import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { ChannelAdapter, InboundMessage } from "@pihub/channels";
import {
  runStartup,
  shutdownRuntime,
  type LoopLike,
  type ServerLike,
  type StartupStore,
} from "../src/startup.ts";
import { openManagerStore, openTestDb, type ManagerStore } from "../src/storage/sqlite.ts";
import { composeChannels, type ChannelComposition } from "../src/channels/composition.ts";
import type { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
import { createLateBoundHitl } from "../src/channels/hitl-bridge.ts";
import { HumanRequestDelivery } from "../src/primary-channel/human-request-delivery.ts";
import type { HumanRequest } from "../src/agenda/human-requests.ts";
import { ChannelRuntimeRegistry } from "../src/channels/registry.ts";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import type {
  CompletedTurn,
  StartTurnCommand,
  TurnExecution,
} from "../src/agenda/turn-execution.ts";

// Slice (c) part 3a, item 2 (la segunda mitad): el DUEÑO del drenado es el
// arranque.
//
// `ChannelOutboxWorker` sabe dreñar; quien decide CUANDO empieza y CUANDO se
// detiene es la composición, porque ese orden es un contrato de apagado:
//   * el worker arranca DESPUÉS de `serve`, igual que el Loop — ningún reclamo
//     antes de que el proceso sea observable;
//   * se PARA despues de `loop.stop` (ningún turno nuevo encola) y ANTES de parar
//     los adapters (queda un envío en vuelo necesita el transporte vivo);
//   * lo que no se pueda confirmar se deja `in_flight` a propósito: el lease es
//     el que lo reclamará en la siguiente arrancada (ver `outbox-worker.ts`).
// Las piezas son opcionales en `StartupDeps`/`ShutdownRuntime`: un arranque sin
// canales compuestos se ordena exactamente como antes.

interface Recorder {
  calls: string[];
}

function recordingSink(recorder: Recorder) {
  const mark = (name: string) => (..._args: unknown[]) => {
    recorder.calls.push(name);
  };
  return mark;
}

function fakeStore(recorder: Recorder): StartupStore {
  const mark = recordingSink(recorder);
  return {
    agenda: {
      recoverRunningOnStartup: () => {
        mark("recover")();
        return { runningRecovered: [], deadlineExpired: 0 };
      },
      triggers: {
        reconcileAuthority: () => {
          mark("reconcile")();
          return 0;
        },
      },
    },
    close: () => {
      mark("store.close")();
    },
  };
}

function fakeLoop(recorder: Recorder): LoopLike {
  return {
    start: () => recorder.calls.push("loop.start"),
    async stop(): Promise<void> {
      recorder.calls.push("loop.stop");
    },
  };
}

describe("startup — el drenado del outbox es dueño del arranque", () => {
  it("compone el worker y lo arranca después de `serve`", async () => {
    const recorder: Recorder = { calls: [] };
    const store = fakeStore(recorder);
    const starts: string[] = [];

    const runtime = await runStartup(
      {
        openStore: async () => {
          recorder.calls.push("openStore");
          return store;
        },
        providers: {
          async initialize(): Promise<void> {
            recorder.calls.push("providers");
          },
        },
        provision: async () => {
          recorder.calls.push("provision");
        },
        createSupervisor: () => ({
          async startAll(): Promise<void> {
            recorder.calls.push("startAll");
          },
          async stopAll(): Promise<void> {
            recorder.calls.push("supervisor.stopAll");
          },
        }),
        createTurns: () => {
          recorder.calls.push("createTurns");
          return {};
        },
        createOAuth: () => ({}),
        createApp: () => {
          recorder.calls.push("createApp");
          return {};
        },
        createLoop: () => {
          recorder.calls.push("createLoop");
          return fakeLoop(recorder);
        },
        // EL worker lo fabrica la composición de canales, pero lo ARRANCA startup.
        createOutboxWorker: () => {
          recorder.calls.push("createOutboxWorker");
          return {
            start(): void {
              starts.push("start");
              recorder.calls.push("outbox.start");
            },
            async stop(): Promise<void> {
              starts.push("stop");
              recorder.calls.push("outbox.stop");
            },
          };
        },
        serve: () => {
          recorder.calls.push("serve");
          return { close: () => recorder.calls.push("server.close") } satisfies ServerLike;
        },
      },
      "owner",
    );

    assert.deepEqual(starts, ["start"], "el worker arranca con el runtime");
    assert.ok(
      recorder.calls.indexOf("outbox.start") > recorder.calls.indexOf("serve"),
      `el drenado no reclama antes de servir: ${recorder.calls.join(" → ")}`,
    );
    assert.ok(
      recorder.calls.indexOf("outbox.start") > recorder.calls.indexOf("createTurns"),
      "se compone sobre el TurnExecution ya existente, no antes",
    );
    assert.equal(runtime.outbox, runtime.outbox, "el runtime expone el worker al apagado");
    assert.ok(runtime.outbox, "sin `createOutboxWorker` no hay campo que parar");
  });

  it("sin composición de canales no hay worker ni pasos nuevos", async () => {
    const recorder: Recorder = { calls: [] };
    const runtime = await runStartup(
      {
        openStore: async () => fakeStore(recorder),
        providers: { initialize: async () => {} },
        provision: async () => {},
        createSupervisor: () => ({ startAll: async () => {}, stopAll: async () => {} }),
        createTurns: () => ({}),
        createOAuth: () => ({}),
        createApp: () => ({}),
            createLoop: () => {
              recorder.calls.push("createLoop");
              return fakeLoop(recorder);
            },
        serve: () => ({ close: () => {} }),
      },
      "owner",
    );
    assert.equal(runtime.outbox, undefined);
    assert.deepEqual(recorder.calls, [
      "reconcile",
      "recover",
      "createLoop",
      "loop.start",
    ]);
  });

  it("SIGTERM: loop → outbox (deja de reclamar) → adapters → runners → store → server", async () => {
    const recorder: Recorder = { calls: [] };
    await shutdownRuntime({
      loop: fakeLoop(recorder),
      outbox: {
        async stop(): Promise<void> {
          recorder.calls.push("outbox.stop");
        },
      },
      channels: {
        async stopAll(): Promise<void> {
          recorder.calls.push("channels.stopAll");
        },
      },
      supervisor: { stopAll: async () => void recorder.calls.push("supervisor.stopAll") },
      store: { close: () => recorder.calls.push("store.close") },
      server: { close: () => recorder.calls.push("server.close") },
    });

    assert.deepEqual(recorder.calls, [
      "loop.stop",
      // El drenado se para CON los adapters aún vivos: un envío en vuelo todavía
      // puede confirmarse. Lo que no se confirme queda `in_flight` y lo devuelve
      // a la cola el lease de la próxima arrancada.
      "outbox.stop",
      "channels.stopAll",
      "supervisor.stopAll",
      "store.close",
      "server.close",
    ]);
  });

  it("un apagado sin worker ni canales sigue cerrando todo lo demás", async () => {
    const recorder: Recorder = { calls: [] };
    await shutdownRuntime({
      loop: fakeLoop(recorder),
      supervisor: { stopAll: async () => void recorder.calls.push("supervisor.stopAll") },
      store: { close: () => recorder.calls.push("store.close") },
      server: { close: () => recorder.calls.push("server.close") },
    });
    assert.deepEqual(recorder.calls, [
      "loop.stop",
      "supervisor.stopAll",
      "store.close",
      "server.close",
    ]);
  });
});
// --- fix round A, C1: el composition root de producción -----------------------
//
// Part 3a left the channel machinery with zero production callers: `index.ts`
// never passed `createOutboxWorker` (so `runtime.outbox` did not exist and nobody
// drained), never set `TurnExecution.onTurnCompleted` (so a finished turn reached
// nobody), never let `composeChannels` call `registry.attachInbound` (so an
// inbound bot message was dropped), and handed `createApi` only `{ registry }`
// (so `GET …/channel-exchanges` could only ever answer with an empty feed). The
// two tests below are the gate for that: one reads the composition root itself,
// the other runs the production wiring shape through `runStartup` and reads the
// REAL v4 tables.

const dirs: string[] = [];
const stores: ManagerStore[] = [];
const compositions: ChannelComposition[] = [];

/** The projected channel record the pairing machine and the router both read. */
function record(pairingWindowEndsAt: string | null): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "a".repeat(64),
    pairingWindowEndsAt,
    observedStatus: "active",
    updatedAt: 1_761_100_800_000,
  };
}

/** Fake transport: records sends/stops and hands back the `onInbound` it received. */
function fakeTransport() {
  const pollers: Array<(message: InboundMessage) => void> = [];
  const sends: Array<{ chatId: string; text: string }> = [];
  const stops: string[] = [];
  const adapterFactory = (): ChannelAdapter => ({
    kind: "telegram",
    async start({ onInbound }): Promise<void> {
      pollers.push(onInbound);
    },
    async send({ chatId, text }) {
      sends.push({ chatId, text });
      return { messageId: `msg-${sends.length}` };
    },
    async stop(): Promise<void> {
      stops.push("telegram");
    },
  });
  return { pollers, sends, stops, adapterFactory };
}

/** Turn bridge fake: records the commands the inbound handler dispatches. */
function fakeTurns() {
  const commands: StartTurnCommand[] = [];
  return {
    commands,
    startTurn(command: StartTurnCommand) {
      commands.push(command);
      return {
        completion: Promise.resolve({ event: "turn-complete", data: { turnId: command.turnId } }),
        disconnect(): void {},
      };
    },
  };
}

function channelTurn(turnId = "turn-1"): CompletedTurn {
  return {
    agentName: "agent",
    turnId,
    origin: { kind: "channel", channelKind: "telegram", chatId: "12345" },
    userText: "hola",
    replyText: "respuestita",
    finalEvent: "turn-complete",
  };
}

/** La pregunta con la forma que `TurnExecution.onHumanRequest` entrega. */
function requestOf(overrides: Partial<HumanRequest> = {}): HumanRequest {
  return {
    agentName: "agent",
    initiativeId: "ini-hitl",
    requestId: "req-hitl",
    turnId: "turn-hitl",
    toolCallId: "tool-hitl",
    question: "¿Cuál es el plan?",
    summary: "resumen del contexto",
    expiresAt: 1_760_000_000_000,
    ...overrides,
  };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-channels-startup-"));
  dirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
  return dataDir;
}

describe("arranque con canales compuestos — el composition root (fix round A, C1)", () => {
  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      await composition.worker.stop({ graceMs: 0 });
    }
    for (const store of stores.splice(0)) {
      // `shutdownRuntime` ya lo cerró en el test 2: doble `close()` no es un
      // fallo del cableado, es la red de seguridad llegando tarde.
      try {
        store.close();
      } catch {
        /* already closed by the shutdown it just verified */
      }
    }
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it("`index.ts` llama a `composeChannels` y cablea las cuatro puertas", async () => {
    const source = await fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    const checks: Array<[RegExp, string]> = [
      [
        /composeChannels\(/,
        "la composición de canales no tiene llamador de producción: nada construye outbox, router ni worker",
      ],
      [
        /createOutboxWorker:/,
        "`runStartup` no recibe el worker: `runtime.outbox` es `undefined` y nadie dreña la cola",
      ],
      [
        /onTurnCompleted:/,
        "`TurnExecution` no notifica el turno terminado: ninguna respuesta vuelve por el canal",
      ],
      [
        /persistence: store\.channels/,
        "el outbox y el espejo no están sobre las tablas v4 del store abierto",
      ],
      [
        /registry: channelRegistry/,
        "la composición no usa el registry que `shutdownRuntime` para (`channels: channelRegistry`)",
      ],
      [
        /resolveRunner:/,
        "un inbound no podría abrir un turno sin el resolutor del puerto del Runner",
      ],
      [
        /attachInbound|composeChannels\(/,
        "`registry.attachInbound` sigue sin llamarlo nadie",
      ],
      [
        /registry: channelRegistry[\s\S]*exchanges: store\.channels\.exchanges/,
        "`createApi` solo recibe `{ registry }`: `channels.exchanges` es `undefined` y el feed siempre vacío",
      ],
    ];
    for (const [pattern, why] of checks) {
      assert.match(source, pattern, why);
    }
    // El mismo registry en los dos extremos: el que cablea la composición y el que
    // se inyecta a las rutas. Dos registries = un bot que nadie para en el SIGTERM.
    assert.ok(
      (source.match(/registry: channelRegistry/g) ?? []).length >= 2,
      "hacen falta DOS usos del mismo registry: composeChannels y createApi",
    );
  });

  it("runStartup dreña, refleja y enruta el inbound sobre las tablas v4 reales", { timeout: 20000 }, async () => {
    const dataDir = await setup();
    const transport = fakeTransport();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: transport.adapterFactory });
    const pairing = new PairingMachine({ dataDir });
    const bridge = fakeTurns();
    const recorder: Recorder = { calls: [] };

    // La forma EXACTA de `index.ts`: el hook va enlazado tarde porque el router no
    // existe hasta `createOutboxWorker`, y `createApp` recibe el exchange-log del
    // store — la misma instancia que el router escribe.
    let channelDelivery: ((turn: CompletedTurn) => void) | undefined;
    let composed: ChannelComposition | undefined;
    let appExchanges: ChannelExchangeLog | undefined;

    const runtime = await runStartup(
      {
        openStore: async () => {
          const store = await openManagerStore(dataDir);
          stores.push(store);
          return store;
        },
        providers: { initialize: async () => {} },
        provision: async () => {},
        createSupervisor: () => ({ startAll: async () => {}, stopAll: async () => {} }),
        createTurns: () => ({
          startTurn: bridge.startTurn,
          /** Lo que `finalizar()` del TurnExecution real hace con su hook. */
          completeTurn: (turn: CompletedTurn) => {
            channelDelivery?.(turn);
          },
        }),
        createOAuth: () => ({}),
        createApp: ({ store }) => {
          appExchanges = store.channels.exchanges;
          return {};
        },
        createLoop: () => fakeLoop(recorder),
        serve: () => ({ close: () => {} } satisfies ServerLike),
        createOutboxWorker: ({ store, turns }) => {
          composed = composeChannels({
            dataDir,
            persistence: store.channels,
            registry,
            pairing,
            turns,
            resolveRunner: async () => ({ port: 4100 }),
            drainIntervalMs: 5,
            log: () => {},
          });
          compositions.push(composed);
          channelDelivery = composed.onTurnCompleted;
          return composed.worker;
        },
      },
      "owner",
    );

    // 1. EL DRENA DO: `runStartup` compuso y arrancó el worker.
    assert.ok(runtime.outbox, "runtime.outbox no existe: la cola nunca se dreña");
    assert.equal(
      (runtime.outbox as unknown as { isRunning: boolean }).isRunning,
      true,
      "el worker está compuesto pero parado",
    );
    // 2. EL ESPEJO: la instancia que verá `GET …/channel-exchanges` es la que escribe el router.
    assert.ok(appExchanges, "createApp no recibió exchange-log: el feed siempre está vacío");
    assert.equal(appExchanges, composed!.exchanges, "rutas y router no comparten la tabla");

    // Adapter vivo + chat vinculado: la entrega va al VÍNCULO, no al remitente.
    await registry.replaceAll("agent", [
      {
        kind: "telegram",
        token: "771234:AA-token",
        pairingWindowEndsAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    await pairing.requestPairing("agent", "telegram", "12345");

    // 3. INBOUND: `registry.attachInbound` se llamó en la composición.
    assert.equal(transport.pollers.length, 1, "fixture: el adapter arrancó con onInbound");
    transport.pollers[0]!({
      externalChatId: "12345",
      text: "¿hora en Madrid?",
      messageId: "msg-99",
    });
    await until(() => bridge.commands.length === 1);
    assert.equal(bridge.commands[0]!.origin.kind, "channel");

    // 4. COMPLETION: el hook enruta al router, el router encola y el drene envía.
    runtime.turns.completeTurn(channelTurn());
    // El hook es fire-and-forget (igual que `onHumanRequest`): se espera al envío,
    // y ENTONCES la cola está vacía — no antes, cuando todavía no hay fila.
    await until(() => transport.sends.length === 1);
    assert.deepEqual(transport.sends, [{ chatId: "12345", text: "respuestita" }]);
    assert.equal(
      (await composed!.outbox.pendingOf("agent", "telegram")).length,
      0,
      "la fila se confirmó y salió de la cola",
    );
    assert.deepEqual(
      appExchanges!.listAfter("agent", 0).map((row) => [row.turnId, row.origin, row.replyText]),
      [["turn-1", "telegram", "respuestita"]],
      "el feed que drena el Dashboard es esta misma tabla",
    );

    // 5. APAGADO: el worker y el adapter viven/mueren con el runtime.
    await shutdownRuntime({ ...runtime, channels: registry });
    assert.equal(
      (composed!.worker as unknown as { isRunning: boolean }).isRunning,
      false,
      "`shutdownRuntime` no paró el drene",
    );
        assert.equal(registry.isRunning("agent", "telegram"), false);
        assert.deepEqual(transport.stops, ["telegram"]);
      });

      // ─── fix round B (verify): B1 + B2, las dos puertas que nacen tarde ─────────
      //
      // `composeChannels` no existe hasta el paso 13 de `runStartup`, y hasta este
      // corte dos consumidoras nacían antes sin que nadie les pasara nada:
      //
      // * `HumanRequestDelivery` (paso 8) se construía con un cliente Bot API de
      //   token — la costura `hitl` de la composición se quedaba sin llamador y la
      //   tarjeta de `waiting_human` era un no-op silencioso en producción
      //   (spec `agent-channels`, «Unified session delivery-by-origin», caso 3).
      // * Las rutas `/api/v1` (paso 10) recibían `{ registry, pairing, exchanges }`:
      //   `outbox` estaba `undefined`, así que el drenado de teardown (FIX H4) y el
      //   de `DELETE /agents/:name` (revocation 3c) no dreñaban nada.
      //
      // El primer test lee el composition root (es lo único que puede probar que
      // PRODUCCIÓN enchufa estas dos salidas); el segundo ejecuta la misma forma
      // sobre las tablas v4 reales y comprueba que la tarjeta llega al bot.
      it("el arranque enlaza TARDE las dos salidas que nacen en `createOutboxWorker`", async () => {
        const source = await fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8");

        const checks: Array<[RegExp, string]> = [
          [
            /createLateBoundHitl\(/,
            "no hay puerta HITL tardía: `HumanRequestDelivery` (paso 8) no puede recibir una costura que aún no existe",
          ],
          [
            /new HumanRequestDelivery\(\{[\s\S]{0,500}?channel: hitlDoor/,
            "`HumanRequestDelivery` se construye sin `channel`: la tarjeta cae en el camino legado del token que el cutover dejó de escribir",
          ],
          [
            /hitlDoor\.bind\(composition\.hitl\)/,
            "la costura `hitl` de `composeChannels` sigue sin llamador de producción",
          ],
          [
            /\.outbox = composition\.outbox/,
            "las rutas no reciben el outbox: el drenado de teardown (`PUT []`, `DELETE /channels/:kind`, `DELETE /agents/:name`) es un no-op",
          ],
        ];
        for (const [pattern, why] of checks) assert.match(source, pattern, why);

        assert.doesNotMatch(
          source,
          /api\.telegram\.org/,
          "el arranque ya no compone un cliente Bot API con token: el único camino de salida es el outbox",
        );
        assert.doesNotMatch(
          source,
          /agentConfigFor:/,
          "fuente del `telegramToken` legado fuera del arranque (fix H3: la puerta es el vínculo)",
        );
      });

      it("con el cableado real, una tarjeta HITL sale por el outbox del canal", { timeout: 20000 }, async () => {
        const dataDir = await setup();
        // `human_request_deliveries.initiative_id` es FK: la reserva necesita la
        // Initiative que el Dashboard proyecta. Sembrada sobre el MISMO fichero que
        // luego abre `runStartup`, y con el driver crudo cerrado antes de abrirlo.
        const seed = await openTestDb(dataDir);
        seed
          .prepare(
            `INSERT INTO initiatives
               (id, agent_name, state, origin, intent, mode, session_key, available_at,
                bound_model, chain_depth, visible_effects_declared, summary, created_at,
                state_changed_at, human_question, human_expires_at, human_request_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            "ini-hitl",
            "agent",
            "waiting_human",
            "human",
            "haz algo",
            "solo",
            "agent:agent:main",
            1,
            "gpt-5",
            0,
            0,
            "resumen del contexto",
            1000,
            1000,
            "¿Cuál es el plan?",
            1_760_000_000_000,
            "req-hitl",
          );
        seed.close();

        const transport = fakeTransport();
        const registry = new ChannelRuntimeRegistry({ adapterFactory: transport.adapterFactory });
        const pairing = new PairingMachine({ dataDir });
        const bridge = fakeTurns();
        const recorder: Recorder = { calls: [] };
        const logs: string[] = [];

        let channelDelivery: ((turn: CompletedTurn) => void) | undefined;
        let composed: ChannelComposition | undefined;
        let delivery: HumanRequestDelivery | undefined;
        // Lo mismo que `index.ts`: la puerta existe desde el paso 8, la costura
        // detrás de ella aparece en el 13.
        const hitlDoor = createLateBoundHitl({ log: (line) => logs.push(line) });

        const runtime = await runStartup(
          {
            openStore: async () => {
              const store = await openManagerStore(dataDir);
              stores.push(store);
              return store;
            },
            providers: { initialize: async () => {} },
            provision: async () => {},
            createSupervisor: () => ({ startAll: async () => {}, stopAll: async () => {} }),
            createTurns: ({ store }) => {
              delivery = new HumanRequestDelivery({
                deliveries: store.agenda.humanRequestDeliveries,
                channel: hitlDoor,
                log: (line) => logs.push(line),
              });
              return {
                startTurn: bridge.startTurn,
                completeTurn: (turn: CompletedTurn) => channelDelivery?.(turn),
              };
            },
            createOAuth: () => ({}),
            createApp: () => ({}),
            createLoop: () => fakeLoop(recorder),
            serve: () => ({ close: () => {} } satisfies ServerLike),
            createOutboxWorker: ({ store, turns }) => {
              composed = composeChannels({
                dataDir,
                persistence: store.channels,
                registry,
                pairing,
                turns,
                resolveRunner: async () => ({ port: 4100 }),
                drainIntervalMs: 5,
                log: () => {},
              });
              compositions.push(composed);
              hitlDoor.bind(composed.hitl);
              channelDelivery = composed.onTurnCompleted;
              return composed.worker;
            },
          },
          "owner",
        );

        // Canal vivo con vínculo: el destino de la tarjeta es el chat emparejado.
        await registry.replaceAll("agent", [
          {
            kind: "telegram",
            token: "771234:AA-token",
            pairingWindowEndsAt: "2099-01-01T00:00:00.000Z",
          },
        ]);
        await pairing.requestPairing("agent", "telegram", "12345");
        assert.equal(hitlDoor.bound, true, "fixture: la composición enlazó la puerta");

        await delivery!.deliver(requestOf());

        await until(() => transport.sends.length === 1);
        assert.equal(transport.sends[0]!.chatId, "12345", "al VÍNCULO, no a un chat de env");
        assert.match(transport.sends[0]!.text, /Pregunta para ti/);
        assert.match(transport.sends[0]!.text, /¿Cuál es el plan\?/);
        assert.equal(
          runtime.store.agenda.humanRequestDeliveries.lookupDelivery(
            "agent",
            "telegram",
            "12345",
            "pending:req-hitl",
          )?.humanRequestId,
          "req-hitl",
          "la reserva durable se escribe con el chat vinculado",
        );
        assert.deepEqual(
          logs.filter((line) => line.startsWith("HUMAN_REQUEST_DELIVERY_")),
          [],
          "sin skips ni fallos: la tarjeta se entregó: " + logs.join(" | "),
        );

        await shutdownRuntime({ ...runtime, channels: registry });
      });
    });
