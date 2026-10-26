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
import { openManagerStore, type ManagerStore } from "../src/storage/sqlite.ts";
import { composeChannels, type ChannelComposition } from "../src/channels/composition.ts";
import type { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
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
});
