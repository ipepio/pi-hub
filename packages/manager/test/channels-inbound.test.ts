import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentPaths,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { InboundMessage } from "@pihub/channels";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import { systemLabel } from "../src/channels/labels.ts";
import { DomainError } from "../src/agenda/errors.ts";
import {
  ChannelInboundHandler,
  INBOUND_QUEUE_DEPTH,
  mainSessionKeyOf,
  pairingCodeReplyText,
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
