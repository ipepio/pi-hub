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
import type { InboundMessage } from "@pihub/channels";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import { openManagerStore } from "../src/storage/sqlite.ts";
import { systemLabel } from "../src/channels/labels.ts";
import { DomainError } from "../src/agenda/errors.ts";
import {
  ChannelInboundHandler,
  INBOUND_QUEUE_DEPTH,
  mainSessionKeyOf,
  pairingCodeReplyText,
  catalogueSessionCommands,
  type EnqueueFn,
} from "../src/channels/inbound.ts";
// `handle` es fire-and-forget (el adapter nunca se espera); los tests llaman a
// `handleAsync` y luego dan un tick de macro-tarea: el drenado de la cola es
// asincrónico por diseño (emparejar y resolver el Runner van antes que el
// `startTurn`), y un turno en vuelo no termina hasta que el test lo resuelve.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
import type {
  CompletedTurn,
  StartTurnCommand,
  TurnHandle,
  TurnSseEvent,
} from "../src/agenda/turn-execution.ts";

// Slice (c) part 2b, items 1-2: the `onInbound` seam finally has a consumer.
//
// The Manager is the only party that sees an inbound message, so THIS is where
// the pairing machine is actually armed: an unbound channel inside the open
// auto-pair window binds on the first message (zero clicks) and the message is
// then processed as a turn; outside the window the sender gets a pairing code
// through the transport and the message is NOT processed (spec §2.1). A bound
// channel drains a bounded FIFO into `turns.startTurn` with a `channel` origin,
// which is what makes the reply route to the outbox instead of only to the web.
//
// The real PairingMachine on a temp dataDir is used on purpose: the whole point
// of this file is the contract between the inbound handler and that machine
// (window open/closed, no stealing), and a fake machine would test nothing.

const dataDirs: string[] = [];

async function setup(agentName = "agent"): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-inbound-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  await writeAgent(dataDir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  dataDirs.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  for (const dir of dataDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function record(pairingWindowEndsAt: string | null): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "a".repeat(64),
    pairingWindowEndsAt,
    observedStatus: "active",
    lastSeenAt: 1_761_100_800_000,
    updatedAt: 1_761_100_800_000,
  };
}

/** Turn bridge fake: records the commands it is handed and resolves them on demand. */
function fakeTurns() {
  const commands: StartTurnCommand[] = [];
  const completions: Array<(turn: CompletedTurn) => void> = [];
  const started: Array<() => void> = [];
  const turns = {
    startTurn(command: StartTurnCommand): TurnHandle {
      commands.push(command);
      let resolve!: (terminal: TurnSseEvent) => void;
      const completion = new Promise<TurnSseEvent>((resolvePromise) => {
        resolve = resolvePromise;
      });
      started.push(() => resolve({ event: "turn-complete", data: { turnId: command.turnId } }));
      completions.push((turn) => {
        // The delivery decision lives in the completion hook, not here.
        void turn;
        resolve({ event: "turn-complete", data: { turnId: command.turnId } });
      });
      return { completion, disconnect(): void {} };
    },
  } as unknown as Pick<import("../src/agenda/turn-execution.ts").TurnExecution, "startTurn">;
  return { turns, commands, started, completions };
}

function inbound(text = "hola", messageId = "1", externalChatId = "12345"): InboundMessage {
  return { externalChatId, text, messageId, senderName: "pepio" };
}

describe("ChannelInboundHandler — paired channel → turn", () => {
  it("un canal emparejado despacha un turno con origen canal y sesión unificada", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record(null)]);
    const pairing = new PairingMachine({ dataDir });
    // Bind through the real machine: auto-pair inside an open window.
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const bound = await pairing.requestPairing("agent", "telegram", "12345");
    assert.equal(bound.autoPaired, true, "fixture: window open ⇒ bind zero clicks");

    const sink = fakeTurns();
    const enqueued: Array<{ chatId: string; text: string }> = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push({ chatId: input.chatId, text: input.text });
      }) satisfies EnqueueFn,
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();
    assert.equal(sink.started.length, 1, "el turno se despacha");
    const command = sink.commands[0]!;
    assert.equal(command.agentName, "agent");
    assert.equal(command.message, "hola");
    assert.equal(command.runnerPort, 4100);
    assert.equal(command.origin.kind, "channel");
    assert.deepEqual(command.origin, { kind: "channel", channelKind: "telegram", chatId: "12345" });
    assert.equal(command.sessionKey, mainSessionKeyOf("agent"), "sesión unificada del Agent");
    // El literal también se fija: la sesión unificada es UNA por Agent (no por
    // chat), así que el Telegram del Agent y su superficie web caen en el mismo
    // contexto. Cambiar esta clave es partir la conversación en dos.
    assert.equal(mainSessionKeyOf("agent"), "agent:agent:main");
    assert.equal(enqueued.length, 0, "sin reply todavía: la entrega la decide el hook");
  });

  it("el mensaje del humano llega al turno COMPLETO: el camino inbound no recorta", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: () => {},
    });

    // T5a (S5): la mitad del humano de un mensaje largo de Telegram entra
    // entera en el turno, que es la MISMA fuente de la que el espejo
    // (`channel_exchanges.user_full_text`) toma su texto. Un recorte aquí se
    // propagaría a la transcripción durable sin que nadie lo notara.
    const largo = "Mensaje largo del humano por Telegram. ".repeat(40).padEnd(1_700, ".");
    assert.ok(largo.length > 1_000, `fixture: ${largo.length} caracteres`);

    await handler.handleAsync("agent", "telegram", inbound(largo, "9"));
    await tick();

    assert.equal(sink.commands.length, 1);
    assert.equal(sink.commands[0]!.message, largo, "el prompt es el mensaje íntegro");
    assert.equal(sink.commands[0]!.message.length, largo.length);
  });

  it("los turnos de un mismo Agent se drenan en FIFO y no en paralelo", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: () => {},
    });

    await handler.handleAsync("agent", "telegram", inbound("primero", "1"));
    await handler.handleAsync("agent", "telegram", inbound("segundo", "2"));
    assert.equal(sink.commands.length, 1, "el segundo espera al terminal del primero");
    assert.equal(handler.queueDepth("agent", "telegram"), 1);

    sink.started[0]!();
    await tick();
    await tick();
    assert.deepEqual(sink.commands.map((command) => command.message), ["primero", "segundo"]);
  });

  it("la cola está acotada: lo que llegue después del límite se descarta", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const logs: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: () => {},
      log: (line) => logs.push(line),
    });

    for (let index = 0; index < INBOUND_QUEUE_DEPTH + 5; index += 1) {
      await handler.handleAsync("agent", "telegram", inbound(`m${index}`, `${index}`));
    }
    assert.equal(INBOUND_QUEUE_DEPTH, 10);
    // 1 en vuelo + 10 en cola; el resto se tira (el diseño acepta la efemeridad
    // de la cola, no un crecimiento sin cota).
    assert.equal(sink.commands.length, 1);
    assert.equal(handler.queueDepth("agent", "telegram"), INBOUND_QUEUE_DEPTH);
    assert.ok(
      logs.some((line) => line.includes("inbound queue full")),
      `descarte observado: ${logs.join("|")}`,
    );
  });

  it("un Agent sin Runner vivo no despacha nada y no lanza", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const logs: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => undefined,
      enqueue: () => {},
      log: (line) => logs.push(line),
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();
    assert.equal(sink.commands.length, 0);
    assert.ok(logs.some((line) => line.includes("runner unavailable")));
  });
});

    describe("ChannelInboundHandler — Agent ocupado (S2 / T4b)", () => {
      it("no ejecuta un segundo turno: contesta por el outbox con UN aviso de sistema", async () => {
        const dataDir = await setup();
        await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
        const pairing = new PairingMachine({ dataDir });
        await pairing.requestPairing("agent", "telegram", "12345");

        // El turno vivo de OTRO origen (la web) es lo que rechaza `startTurn` en
        // producción: aquí se simula con el MISMO DomainError.
        const vivo = { live: true };
        const pasados: StartTurnCommand[] = [];
        const turns = {
          startTurn(command: StartTurnCommand): TurnHandle {
            if (vivo.live) {
              throw new DomainError(
                "TURN_IN_PROGRESS",
                `agent "${command.agentName}" already has a live turn`,
              );
            }
            pasados.push(command);
            return {
              completion: Promise.resolve({
                event: "turn-complete",
                data: { turnId: command.turnId },
              } as TurnSseEvent),
              disconnect(): void {},
            };
          },
        } as unknown as Pick<import("../src/agenda/turn-execution.ts").TurnExecution, "startTurn">;

        const enqueued: Array<{ chatId: string; text: string }> = [];
        const logs: string[] = [];
        const handler = new ChannelInboundHandler({
          dataDir,
          pairing,
          turns,
          resolveRunner: async () => ({ port: 4100 }),
          enqueue: ((input) => {
            enqueued.push({ chatId: input.chatId, text: input.text });
          }) satisfies EnqueueFn,
          log: (line) => logs.push(line),
        });

        await handler.handleAsync("agent", "telegram", inbound("hola", "1"));
        await handler.idle();

        assert.equal(pasados.length, 0, "el mensaje no se ejecutó: ni un turno del modelo");
        assert.deepEqual(
          enqueued,
          [{ chatId: "12345", text: systemLabel("turnBusy") }],
          "exactamente un aviso de sistema al chat ENLAZADO, con el texto del catálogo",
        );
        assert.equal(
          handler.queueDepth("agent", "telegram"),
          0,
          "el mensaje rechazado no se queda en la cola para ejecutarse por sorpresa",
        );
        assert.ok(logs.some((line) => line.includes("busy")), `rechazo registrado: ${logs.join("|")}`);

        // El turno vivo del Agent termina: el reenvío del usuario SÍ se ejecuta.
        vivo.live = false;
        await handler.handleAsync("agent", "telegram", inbound("hola", "2"));
        await handler.idle();
        assert.equal(pasados.length, 1, "el reintento posterior ejecuta el turno");
        assert.equal(pasados[0]!.message, "hola");
        assert.equal(enqueued.length, 1, "el reintento no repite el aviso de ocupado");
      });

      it("un outbox roto no deja una promesa rechazada suelta y el drenado sigue vivo", async () => {
        const dataDir = await setup();
        await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
        const pairing = new PairingMachine({ dataDir });
        await pairing.requestPairing("agent", "telegram", "12345");

        const vivo = { live: true };
        const pasados: StartTurnCommand[] = [];
        const turns = {
          startTurn(command: StartTurnCommand): TurnHandle {
            if (vivo.live) {
              throw new DomainError("TURN_IN_PROGRESS", "agent ocupado");
            }
            pasados.push(command);
            return {
              completion: Promise.resolve({
                event: "turn-complete",
                data: { turnId: command.turnId },
              } as TurnSseEvent),
              disconnect(): void {},
            };
          },
        } as unknown as Pick<import("../src/agenda/turn-execution.ts").TurnExecution, "startTurn">;

        const logs: string[] = [];
        const handler = new ChannelInboundHandler({
          dataDir,
          pairing,
          turns,
          resolveRunner: async () => ({ port: 4100 }),
          enqueue: () => {
            throw new Error("outbox roto");
          },
          log: (line) => logs.push(line),
        });

        // `unhandledRejection` es el síntoma real del bug: un `void
        // next.finally(...)` dejaba una promesa derivada rechazada sin consumidor.
        const sinConsumidor: unknown[] = [];
        const observador = (reason: unknown): void => {
          sinConsumidor.push(reason);
        };
        process.on("unhandledRejection", observador);
        try {
          await handler.handleAsync("agent", "telegram", inbound("hola", "1"));
          await handler.idle();
          await tick();
          await tick();
          assert.deepEqual(
            sinConsumidor,
            [],
            "un outbox caído se registra; no puede tumbar el proceso",
          );
          assert.ok(
            logs.some((line) => line.includes("outbox roto")),
            `el fallo del outbox queda registrado: ${logs.join("|")}`,
          );
          assert.equal(handler.queueDepth("agent", "telegram"), 0);

          // El drenado NO se perdió: el mismo chat vuelve a ejecutar al liberarse.
          vivo.live = false;
          await handler.handleAsync("agent", "telegram", inbound("hola", "2"));
          await handler.idle();
          assert.equal(pasados.length, 1, "el drenado posterior sigue funcionando");
        } finally {
          process.off("unhandledRejection", observador);
        }
      });

      it("un fallo del resolver se registra y no pierde los mensajes que vienen detrás", async () => {
        const dataDir = await setup();
        await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
        const pairing = new PairingMachine({ dataDir });
        await pairing.requestPairing("agent", "telegram", "12345");

        const sink = fakeTurns();
        const logs: string[] = [];
        let intentos = 0;
        const handler = new ChannelInboundHandler({
          dataDir,
          pairing,
          turns: sink.turns,
          resolveRunner: async () => {
            intentos += 1;
            if (intentos === 1) throw new Error("resolver roto");
            return { port: 4100 };
          },
          enqueue: () => {},
          log: (line) => logs.push(line),
        });

        await handler.handleAsync("agent", "telegram", inbound("primero", "1"));
        await handler.handleAsync("agent", "telegram", inbound("segundo", "2"));
        await tick();
        await tick();
        assert.deepEqual(
          sink.commands.map((command) => command.message),
          ["segundo"],
          "el mensaje cuyo resolver falló se registra y el siguiente se ejecuta",
        );
        assert.ok(logs.some((line) => line.includes("resolver roto")), logs.join("|"));

        sink.started[0]!();
        await handler.idle();
      });
    });

    describe("ChannelInboundHandler — catálogo de labels de sistema (S4)", () => {
      it("el aviso de ocupado dice que el mensaje NO se ejecutó y que se puede reintentar", () => {
        const texto = systemLabel("turnBusy");
        assert.match(texto, /no se ha ejecutado/i, "el usuario debe saber que su mensaje no corrió");
        assert.match(texto, /vuelve a enviarlo/i, "y que puede reintentar cuando termine el turno");
      });
    });

    describe("ChannelInboundHandler — auto-pair consumption (item 2)", () => {
  it("ventana abierta: el primer mensaje enlaza el chat y ADEMÁS se procesa", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    const sink = fakeTurns();
    const enqueued: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push(input.text);
      }) satisfies EnqueueFn,
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();

    const state = await pairing.stateOf("agent", "telegram");
    assert.equal(state?.state, "active");
    assert.equal(state?.externalChatId, "12345", "cero clicks");
    assert.equal(sink.commands.length, 1, "el mensaje que emparejó se procesa");
    assert.deepEqual(enqueued, [], "auto-pair no responde con un código");
  });

  it("ventana cerrada (null): código por el transporte y el mensaje NO se procesa", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record(null)]);
    const pairing = new PairingMachine({ dataDir, newCode: () => "ABCD2345" });
    const sink = fakeTurns();
    const enqueued: Array<{ chatId: string; text: string }> = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push({ chatId: input.chatId, text: input.text });
      }) satisfies EnqueueFn,
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();

    assert.equal(sink.commands.length, 0, "no es un turno del Agent: es un mensaje de sistema");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.chatId, "12345");
    assert.match(enqueued[0]!.text, /ABCD2345/);
    assert.equal(enqueued[0]!.text, pairingCodeReplyText("ABCD2345"));
    const state = await pairing.stateOf("agent", "telegram");
    assert.equal(state?.state, "pending");
  });

  it("ventana en el pasado: mismo flujo de código (la ventana está CERRADA)", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2020-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir, newCode: () => "QQQQWWWW" });
    const sink = fakeTurns();
    const enqueued: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push(input.text);
      }) satisfies EnqueueFn,
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();
    assert.equal(sink.commands.length, 0);
    assert.deepEqual(enqueued, [pairingCodeReplyText("QQQQWWWW")]);
  });

  it("nunca roba un canal ya enlazado: otro chat no dispara turno, ni código, ni rebind", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const enqueued: string[] = [];
    const logs: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push(input.text);
      }) satisfies EnqueueFn,
      log: (line) => logs.push(line),
    });

    await handler.handleAsync("agent", "telegram", inbound("hola", "7", "99999"));
    await tick();

    const state = await pairing.stateOf("agent", "telegram");
    assert.equal(state?.externalChatId, "12345", "el binding original sobrevive");
    assert.equal(sink.commands.length, 0);
    assert.deepEqual(enqueued, [], "el límite/robo no se responde con un código");
    assert.ok(logs.some((line) => line.includes("already bound")));
  });

  it("un chat ya enlazado que reenvía su mensaje sigue sin recibir código", async () => {
    const dataDir = await setup();
    await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
    const pairing = new PairingMachine({ dataDir });
    await pairing.requestPairing("agent", "telegram", "12345");

    const sink = fakeTurns();
    const enqueued: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: ((input) => {
        enqueued.push(input.text);
      }) satisfies EnqueueFn,
    });

    await handler.handleAsync("agent", "telegram", inbound("primera", "1"));
    await tick();
    assert.equal(sink.commands.length, 1, "el primer reenvío despacha un turno");
    sink.started[0]!();
    await handler.handleAsync("agent", "telegram", inbound("primera", "1"));
    await tick();

    assert.deepEqual(enqueued, []);
    const state = await pairing.stateOf("agent", "telegram");
    assert.equal(state?.externalChatId, "12345");
  });

  it("sin canal registrado (o sin credencial): el mensaje se ignora, sin turno ni estado", async () => {
    const dataDir = await setup();
    const pairing = new PairingMachine({ dataDir });
    const sink = fakeTurns();
    const logs: string[] = [];
    const handler = new ChannelInboundHandler({
      dataDir,
      pairing,
      turns: sink.turns,
      resolveRunner: async () => ({ port: 4100 }),
      enqueue: () => {},
      log: (line) => logs.push(line),
    });

    await handler.handleAsync("agent", "telegram", inbound());
    await tick();

    assert.equal(sink.commands.length, 0);
    assert.equal(await pairing.stateOf("agent", "telegram"), undefined);
    assert.ok(logs.some((line) => line.includes("no channel")));
  });
});

    // T6a — comandos de texto del chat enlazado.
    //
    // El seam es el handler completo (`handleAsync`), igual que en el resto de esta
    // suite: lo observable es «¿se ejecuta un turno del Agent?» y «¿qué contesta el
    // Manager?» (una fila del outbox). El adaptador de comandos se inyecta como objeto
    // de mentira en el primer bloque porque lo que aquí se fija es el CONTRATO entre el
    // inbound y el catálogo (qué método se llama, con qué argumento y qué se responde),
    // no el SQL del catálogo; el adaptador REAL (`catalogueSessionCommands`) tiene su
    // propio bloque al final, contra el catálogo durable de producción.

    describe("ChannelInboundHandler — comandos de texto (T6a)", () => {
      interface FakeState {
        busy: boolean;
        abort: boolean;
        selected: string;
      }

      /** Adaptador de comandos de mentira: registra las llamadas y muta su estado. */
      function fakeCommands(
        state: FakeState,
        initial?: Array<{ id: string; name: string | null }>,
      ) {
        const sessions = [...(initial ?? [
          { id: "main", name: null },
          { id: "s2", name: "trabajo" },
        ])];
        const calls: string[] = [];
        const commands = {
          newSession: (input: { name?: string }) => {
            calls.push(`new:${input.name ?? ""}`);
            const created = { id: `s${sessions.length + 1}`, name: input.name ?? null };
            sessions.push(created);
            state.selected = created.id;
            return created;
          },
          listSessions: () => {
            calls.push("list");
            return { sessions: [...sessions], selectedId: state.selected };
          },
          selectSession: (input: { sessionId: string }) => {
            calls.push(`select:${input.sessionId}`);
            state.selected = input.sessionId;
            return sessions.find((session) => session.id === input.sessionId) ??
              { id: input.sessionId, name: null };
          },
          isBusy: () => state.busy,
          abortIfLive: () => {
            calls.push("abort");
            return state.abort;
          },
        };
        return { commands, calls, sessions };
      }

      async function bound(
        options: {
          busy?: boolean;
          abort?: boolean;
          /** `false` = ventana cerrada: el chat NO está enlazado. */
          pair?: boolean;
          selected?: string;
          initial?: Array<{ id: string; name: string | null }>;
        } = {},
      ) {
        const dataDir = await setup();
        await writeChannelRecords(dataDir, "agent", [
          record(options.pair === false ? null : "2099-01-01T00:00:00.000Z"),
        ]);
        const pairing = new PairingMachine({ dataDir, newCode: () => "ABCD2345" });
        if (options.pair !== false) await pairing.requestPairing("agent", "telegram", "12345");
        const state: FakeState = {
          busy: options.busy ?? false,
          abort: options.abort ?? false,
          selected: options.selected ?? "main",
        };
        const fake = fakeCommands(state, options.initial);
        const sink = fakeTurns();
        const enqueued: Array<{ chatId: string; text: string }> = [];
        const handler = new ChannelInboundHandler({
          dataDir,
          pairing,
          turns: sink.turns,
          resolveRunner: async () => ({ port: 4100 }),
          enqueue: ((input) => {
            enqueued.push({ chatId: input.chatId, text: input.text });
          }) satisfies EnqueueFn,
          sessionCommands: fake.commands,
        });
        return { handler, sink, enqueued, state, fake, pairing };
      }

      it("/new crea y selecciona una sesión y contesta con su nombre, sin turno del Agent", async () => {
        const { handler, sink, enqueued, state, fake } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("/new trabajo", "1"));
        await tick();

        assert.equal(sink.commands.length, 0, "un comando NO es un turno del modelo");
        assert.deepEqual(fake.calls, ["new:trabajo"]);
        assert.equal(state.selected, "s3", "la sesión creada queda seleccionada en este chat");
        assert.deepEqual(enqueued, [
          {
            chatId: "12345",
            text: systemLabel("sessionCreated", {
              session: systemLabel("sessionRef", { name: "trabajo", id: "s3" }),
            }),
          },
        ]);
      });

      it("/sessions lista como mucho diez sesiones y marca la seleccionada", async () => {
        const doce = Array.from({ length: 12 }, (_, index) => ({
          id: `s${index + 1}`,
          name: index === 11 ? "doce" : null,
        }));
        const { handler, enqueued } = await bound({ initial: doce, selected: "s12" });

        await handler.handleAsync("agent", "telegram", inbound("/sessions", "1"));
        await tick();

        assert.equal(enqueued.length, 1, "una sola respuesta de sistema");
        const texto = enqueued[0]!.text;
        const lineas = texto.split("\n");
        assert.equal(lineas.length, 1 + 10, "cabecera + diez sesiones: la lista está acotada");
        assert.match(lineas[0]!, /\b10 de 12\b/, `cabecera con el recuento: ${lineas[0]}`);
        assert.equal(
          lineas.filter((linea) => linea.includes(systemLabel("sessionSelectedMark"))).length,
          0,
          "la seleccionada (s12) queda fuera de las diez primeras: sin marca visible",
        );
        assert.ok(lineas.some((linea) => linea.includes("s1)")), `el id viaja en el listado: ${texto}`);
      });

      it("/session sin argumento dice la sesión actual y si el agente está ocupado", async () => {
        const { handler, enqueued, state, fake, sink } = await bound({ busy: true });

        await handler.handleAsync("agent", "telegram", inbound("/session", "1"));
        await tick();

        assert.deepEqual(enqueued, [
          {
            chatId: "12345",
            text: systemLabel("sessionCurrent", {
              session: systemLabel("sessionRef", {
                name: systemLabel("sessionUnnamed"),
                id: "main",
              }),
              status: systemLabel("agentBusy"),
            }),
          },
        ]);
        assert.equal(state.selected, "main", "consultar no cambia la selección");
        assert.equal(sink.commands.length, 0, "consultar no abre turno");
        assert.ok(!fake.calls.includes("abort"), "consultar no aborta nada");
      });

      it("/session <nombre> y /session <id> seleccionan esa sesión para este chat", async () => {
        const { handler, enqueued, state } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("/session trabajo", "1"));
        await tick();
        assert.equal(state.selected, "s2", "selección por nombre exacto");
        assert.equal(
          enqueued[0]!.text,
          systemLabel("sessionSwitched", {
            session: systemLabel("sessionRef", { name: "trabajo", id: "s2" }),
          }),
        );

        await handler.handleAsync("agent", "telegram", inbound("/session main", "2"));
        await tick();
        assert.equal(state.selected, "main", "selección por id");
        assert.equal(enqueued.length, 2);
      });

      it("/session con un nombre inexistente no cambia la selección y contesta con la lista", async () => {
        const { handler, enqueued, state } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("/session fantasma", "1"));
        await tick();

        assert.equal(state.selected, "main", "nada cambia");
        assert.deepEqual(enqueued, [
          { chatId: "12345", text: systemLabel("sessionUnknownTarget", { target: "fantasma" }) },
        ]);
      });

      it("/stop sin turno vivo contesta que no hay nada en marcha", async () => {
        const { handler, enqueued, fake, sink } = await bound({ abort: false });

        await handler.handleAsync("agent", "telegram", inbound("/stop", "1"));
        await tick();

        assert.deepEqual(fake.calls, ["abort"], "el hook de abort se consulta una vez");
        assert.deepEqual(enqueued, [{ chatId: "12345", text: systemLabel("stopNothing") }]);
        assert.equal(sink.commands.length, 0);
      });

      it("/stop con un turno vivo pide el abort del turno del Agent", async () => {
        const { handler, enqueued, fake } = await bound({ abort: true });

        await handler.handleAsync("agent", "telegram", inbound("/stop", "1"));
        await tick();

        assert.deepEqual(fake.calls, ["abort"]);
        assert.deepEqual(enqueued, [{ chatId: "12345", text: systemLabel("stopRequested") }]);
      });

      it("un comando desconocido contesta con la lista de comandos y no abre turno", async () => {
        const { handler, enqueued, sink } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("/borrar", "1"));
        await tick();

        assert.equal(sink.commands.length, 0);
        assert.deepEqual(enqueued, [
          { chatId: "12345", text: systemLabel("unknownCommand", { command: "borrar" }) },
        ]);
      });

      it("el comando es insensible a mayúsculas y tolera el sufijo @bot de Telegram", async () => {
        const { handler, state, fake } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("/NEW@pi_hub_bot trabajo", "1"));
        await tick();

        assert.deepEqual(fake.calls, ["new:trabajo"]);
        assert.equal(state.selected, "s3");
      });

      it("un chat NO enlazado recibe el flujo de emparejamiento y ningún comando", async () => {
        const { handler, enqueued, state, fake, sink } = await bound({ pair: false });

        await handler.handleAsync("agent", "telegram", inbound("/new trabajo", "1"));
        await tick();

        assert.deepEqual(
          enqueued.map((reply) => reply.text),
          [pairingCodeReplyText("ABCD2345")],
          "el código de emparejamiento, no un comando",
        );
        assert.deepEqual(fake.calls, [], "el catálogo no se toca desde un chat sin enlazar");
        assert.equal(state.selected, "main");
        assert.equal(sink.commands.length, 0, "y el comando no se ejecuta como prompt");
      });

      it("PRESERVE: el texto normal sigue siendo un turno aunque los comandos estén inyectados", async () => {
        const { handler, sink, enqueued } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("hola", "1"));
        await tick();

        assert.equal(sink.commands.length, 1, "nada del camino de turnos cambia");
        assert.equal(sink.commands[0]!.message, "hola");
        assert.deepEqual(enqueued, [], "un turno no contesta por el outbox: lo hace su completion");
      });

      it("PRESERVE: una barra dentro del texto no convierte el mensaje en comando", async () => {
        const { handler, sink, enqueued } = await bound();

        await handler.handleAsync("agent", "telegram", inbound("mira /new x y /stop", "1"));
        await tick();

        assert.equal(sink.commands.length, 1);
        assert.equal(sink.commands[0]!.message, "mira /new x y /stop");
        assert.deepEqual(enqueued, []);
      });
    });

    // T6a, segundo bloque — el adaptador REAL (`catalogueSessionCommands`) contra el
    // catálogo durable de producción (`openManagerStore`).
    //
    // El primer bloque fija el contrato con el adaptador; este fija lo que solo se ve
    // con el catálogo de verdad: `/new` y `/session` mueven la selección de la
    // superficie del canal y **no** la de la web (S3), y el mensaje siguiente corre en
    // la sesión recién seleccionada, porque el inbound la lee al ACEPTAR el mensaje.

    describe("ChannelInboundHandler — comandos contra el catálogo real (T6a)", () => {
      const NOW = 1_790_000_000_000;
      const stores: Array<Awaited<ReturnType<typeof openManagerStore>>> = [];

      afterEach(() => {
        for (const store of stores.splice(0)) store.close();
      });

      async function boundWithCatalogue() {
        const dataDir = await setup();
        await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
        const pairing = new PairingMachine({ dataDir });
        await pairing.requestPairing("agent", "telegram", "12345");
        const store = await openManagerStore(dataDir);
        stores.push(store);
        const sink = fakeTurns();
        const enqueued: string[] = [];
        const handler = new ChannelInboundHandler({
          dataDir,
          pairing,
          turns: sink.turns,
          resolveRunner: async () => ({ port: 4100 }),
          enqueue: ((input) => {
            enqueued.push(input.text);
          }) satisfies EnqueueFn,
          // Mismo callback que cablea la composición: la selección de la superficie
          // del canal, leída al aceptar el mensaje.
          sessionKeyFor: (agentName) =>
            store.sessions.getSelectedSession({
              agentName,
              channel: "telegram",
              now: NOW,
            }).key,
          sessionCommands: catalogueSessionCommands({
            sessions: store.sessions,
            surfaceOf: () => "telegram",
            now: () => NOW,
            isBusy: () => false,
            abortIfLive: () => false,
          }),
        });
        return { handler, sink, enqueued, store };
      }

      it("/new crea y selecciona en Telegram sin mover la selección de la web", async () => {
        const { handler, sink, enqueued, store } = await boundWithCatalogue();
        const web = store.sessions.create({ agentName: "agent", channel: "web", name: "web-fija", now: NOW });
        store.sessions.select({ agentName: "agent", channel: "web", sessionId: web.id, now: NOW });

        await handler.handleAsync("agent", "telegram", inbound("/new trabajo", "1"));
        await tick();

        const snapshot = store.sessions.list("agent", NOW);
        const telegramId = snapshot.selection.telegram;
        assert.ok(telegramId !== null, "telegram tiene selección");
        const created = snapshot.sessions.find((session) => session.id === telegramId);
        assert.equal(created?.name, "trabajo", "la sesión creada lleva el nombre del comando");
        assert.notEqual(telegramId, "main", "y es una sesión NUEVA, no la legacy");
        assert.equal(snapshot.selection.web, web.id, "la selección de la web no se mueve");
        assert.deepEqual(enqueued, [
          systemLabel("sessionCreated", {
            session: systemLabel("sessionRef", { name: "trabajo", id: String(telegramId) }),
          }),
        ]);
        assert.equal(sink.commands.length, 0, "crear una sesión no ejecuta un turno");

        // El mensaje siguiente corre en la sesión recién seleccionada: el comando
        // cambia la atribución de verdad, no solo una fila.
        await handler.handleAsync("agent", "telegram", inbound("hola", "2"));
        await tick();
        assert.equal(sink.commands.length, 1);
        assert.equal(sink.commands[0]!.sessionKey, created!.key);
        sink.started[0]!();
        await handler.idle();
      });

      it("/sessions marca la selección de Telegram y deja la web intacta", async () => {
        const { handler, store, enqueued } = await boundWithCatalogue();
        const web = store.sessions.create({ agentName: "agent", channel: "web", name: "web-fija", now: NOW });
        store.sessions.select({ agentName: "agent", channel: "web", sessionId: web.id, now: NOW });
        const telegram = store.sessions.create({ agentName: "agent", channel: "telegram", name: "chat", now: NOW });
        store.sessions.select({ agentName: "agent", channel: "telegram", sessionId: telegram.id, now: NOW });

        await handler.handleAsync("agent", "telegram", inbound("/sessions", "1"));
        await tick();

        assert.equal(enqueued.length, 1);
        const lineas = enqueued[0]!.split("\n");
        assert.equal(lineas.length, 1 + 3, "cabecera + las tres sesiones del Agent");
        const marcada = lineas.filter((linea) => linea.includes(systemLabel("sessionSelectedMark")));
        assert.equal(marcada.length, 1, "una sola marcada: la de ESTA superficie");
        assert.ok(marcada[0]!.includes(telegram.id), `la marcada es la de Telegram: ${marcada[0]}`);
        assert.equal(
          store.sessions.list("agent", NOW).selection.web,
          web.id,
          "listar no mueve ninguna selección",
        );
      });
    });
