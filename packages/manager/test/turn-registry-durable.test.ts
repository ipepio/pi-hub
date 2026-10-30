// T4-D/1 — registro DURABLE de turnos vivos (seguimiento del ODD
// `agent-session-workspace`): la admisión «un turno por Agent» (S2) sobrevive a un
// reinicio del Manager.
//
// Antes de esta unidad la admisión era solo el `Map` en memoria de
// `TurnExecution`: recién arrancado, el Manager de un proceso anterior tenía el
// registro vacío y el mismo Agent podía recibir un SEGUNDO turno mientras el
// Runner seguía ejecutando el primero. Aquí la reserva se espeja en
// `agent_live_turns` (PK `agent_name`) y el arranque carga esas filas como
// «no verificadas»: el slot queda ocupado y el turno nuevo se rechaza con
// `TURN_IN_PROGRESS` (409). Lo que NO se hace es fingir que se puede abortar un
// turno cuyo socket no existe: `TURN_UNREACHABLE`.
//
// El Runner es un `WebSocketServer` real en un puerto efímero (patrón de
// `agenda-turn-admission.test.ts`): los sockets existen y se pueden contar, y el
// test decide cuándo llega el terminal. La base es `:memory:` con las
// migraciones reales aplicadas, así que es la tabla de verdad la que sostiene la
// invariante, no un doble del repositorio.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import {
  TurnExecution,
  type StartTurnCommand,
} from "../src/agenda/turn-execution.ts";
import { DomainError } from "../src/agenda/errors.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { LiveTurnRepository } from "../src/storage/live-turns.ts";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import type {
  HumanRequest,
  PauseRunningForHumanCommand,
} from "../src/agenda/human-requests.ts";

const runners: Array<() => Promise<void>> = [];
const dbs: SqliteDb[] = [];

afterEach(async () => {
  for (const close of runners.splice(0)) await close();
  for (const db of dbs.splice(0)) db.close();
});

/** Base `:memory:` con el esquema REAL (una base recién migrada, como producción). */
function openDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  dbs.push(db);
  return db;
}

interface RunnerHarness {
  readonly port: number;
  /** Sockets aceptados hasta ahora: la prueba de «el rechazo no abre socket». */
  connections(): number;
  /** Espera a que el Runner haya aceptado `count` sockets. */
  waitForSockets(count: number): Promise<void>;
  /** `agent_end` a todo socket abierto: el terminal que libera la admisión. */
  finishAll(): void;
  close(): Promise<void>;
}

/**
 * Runner fake: anuncia `ready` al conectar y, salvo que el test diga otra cosa,
 * responde al `prompt` con `agent_start` y NO cierra el turno por su cuenta.
 */
async function startRunner(
  onPrompt?: (socket: WebSocket) => void,
): Promise<RunnerHarness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const sockets: WebSocket[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  server.on("connection", (socket, request) => {
    sockets.push(socket);
    const sessionKey = new URL(request.url ?? "/", "ws://runner").searchParams.get(
      "sessionKey",
    );
    socket.send(
      JSON.stringify({
        type: "ready",
        agent: "agent",
        sessionId: sessionKey,
        capabilities: ["prompt_context_v1", "ask_human_v1"],
      }),
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type !== "prompt") return;
      if (onPrompt) {
        onPrompt(socket);
        return;
      }
      socket.send(JSON.stringify({ type: "agent_start" }));
    });
    for (const waiter of waiters.splice(0)) {
      if (sockets.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  runners.push(close);

  return {
    port: address.port,
    connections: () => sockets.length,
    waitForSockets: (count) =>
      new Promise<void>((resolve) => {
        if (sockets.length >= count) {
          resolve();
          return;
        }
        waiters.push({ count, resolve });
      }),
    finishAll: () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      }
    },
    close,
  };
}

function command(overrides: Partial<StartTurnCommand> = {}): StartTurnCommand {
  return {
    agentName: "agent",
    turnId: "turn-1",
    idempotencyKey: "idem-1",
    correlationId: "corr-1",
    sessionKey: "sk-1",
    message: "hola",
    runnerPort: 1, // lo pisa cada test con el puerto real del Runner fake
    eventProfile: "basic",
    origin: { kind: "human" },
    ...overrides,
  };
}

/** Validador de `assert.throws`: el rechazo es el código cerrado, no un texto. */
function busy(error: unknown): boolean {
  return error instanceof DomainError && error.code === "TURN_IN_PROGRESS";
}

function unreachable(error: unknown): boolean {
  return error instanceof DomainError && error.code === "TURN_UNREACHABLE";
}

describe("registro durable de turnos vivos (T4-D/1)", () => {
  it("(a) startTurn deja una fila durable con agente, turno, sesión y arranque", async () => {
    const runner = await startRunner();
    const liveTurns = new LiveTurnRepository(openDb());
    const turns = new TurnExecution({
      apiToken: "service-token",
      liveTurns,
      now: () => 4242,
    });

    const vivo = turns.startTurn(command({ runnerPort: runner.port }));

    assert.deepEqual(
      liveTurns.listLiveTurns(),
      [{ agentName: "agent", turnId: "turn-1", sessionKey: "sk-1", startedAt: 4242 }],
      "la reserva de admisión es durable antes de abrir el socket",
    );

    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await vivo.completion).event, "turn-complete");
  });

  it("(b) el terminal libera la fila durable junto con el registro en memoria", async () => {
    const runner = await startRunner();
    const liveTurns = new LiveTurnRepository(openDb());
    const turns = new TurnExecution({ apiToken: "service-token", liveTurns });

    const vivo = turns.startTurn(command({ runnerPort: runner.port }));
    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await vivo.completion).event, "turn-complete");

    assert.deepEqual(
      liveTurns.listLiveTurns(),
      [],
      "un turno terminado no deja reserva durable: el Agent queda admitido otra vez",
    );
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("(c) la pausa humana durable también libera la fila durable", async () => {
    const runner = await startRunner((socket) => {
      socket.send(
        JSON.stringify({
          type: "human_input_required",
          question: "¿Procedo?",
          summary: "Necesita aprobación",
          toolCallId: "call-1",
        }),
      );
    });
    const liveTurns = new LiveTurnRepository(openDb());
    const pauses: PauseRunningForHumanCommand[] = [];
    const turns = new TurnExecution({
      apiToken: "service-token",
      liveTurns,
      now: () => 2000,
      requestId: () => "request-1",
      expiryMs: 60_000,
      humanRequests: {
        pauseRunningForHuman(input: PauseRunningForHumanCommand): HumanRequest {
          pauses.push(input);
          return {
            initiativeId: input.initiativeId,
            agentName: input.agentName,
            turnId: input.turnId,
            requestId: input.requestId,
            question: input.question,
            summary: input.summary,
            toolCallId: input.toolCallId,
            expiresAt: input.now + input.expiryMs,
          };
        },
      },
    });

    const handle = turns.startTurn(
      command({
        turnId: "turn-ini",
        runnerPort: runner.port,
        origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
      }),
    );

    assert.deepEqual(await handle.waitingHuman, {
      initiativeId: "ini-1",
      requestId: "request-1",
    });
    assert.equal(pauses.length, 1, "la pausa durable se confirmó antes de liberar el slot");
    assert.deepEqual(
      liveTurns.listLiveTurns(),
      [],
      "una Initiative pausada para el humano no conserva reserva de admisión",
    );
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("(d) un socket que no se pudo crear no deja ni reserva en memoria ni fila durable", async () => {
    const runner = await startRunner();
    const liveTurns = new LiveTurnRepository(openDb());
    const turns = new TurnExecution({
      apiToken: "service-token",
      liveTurns,
      createWebSocket: () => {
        throw new Error("socket imposible");
      },
    });

    assert.throws(
      () => turns.startTurn(command({ runnerPort: runner.port })),
      /socket imposible/,
    );
    assert.deepEqual(
      liveTurns.listLiveTurns(),
      [],
      "sin socket no puede quedar una fila que bloquee al Agent para siempre",
    );
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("(e) tras un reinicio, la fila durable no verificada rechaza el turno nuevo con 409", async () => {
    const runner = await startRunner();
    const liveTurns = new LiveTurnRepository(openDb());
    // Fila del proceso anterior: el Runner puede seguir ejecutando ese turno.
    liveTurns.claimLiveTurn({
      agentName: "agent",
      turnId: "turn-previo",
      sessionKey: "sk-prev",
      startedAt: 1000,
    });

    const turns = new TurnExecution({ apiToken: "service-token", liveTurns });
    turns.loadUnverified(liveTurns.listLiveTurns());

    assert.equal(
      turns.hasLiveTurnForAgent("agent"),
      true,
      "el Agent aparece ocupado para stop/restart/reload tras el reinicio",
    );
    assert.equal(turns.liveTurnIdForAgent("agent"), "turn-previo");
    assert.throws(
      () => turns.startTurn(command({ runnerPort: runner.port })),
      busy,
      "un turno no verificable bloquea la admisión (fail-closed)",
    );
    assert.equal(runner.connections(), 0, "el rechazo no abre socket contra el Runner");
    assert.equal(
      liveTurns.listLiveTurns().length,
      1,
      "el rechazo no borra la fila: el slot sigue ocupado",
    );
  });

  it("(f) el claim durable rechaza el segundo turno del mismo Agent aunque venga de otra instancia", async () => {
    const runner = await startRunner();
    const liveTurns = new LiveTurnRepository(openDb());
    const primera = new TurnExecution({
      apiToken: "service-token",
      liveTurns,
      now: () => 1000,
    });
    const segunda = new TurnExecution({
      apiToken: "service-token",
      liveTurns,
      now: () => 2000,
    });

    const vivo = primera.startTurn(command({ runnerPort: runner.port }));
    await runner.waitForSockets(1);

    assert.throws(
      () =>
        segunda.startTurn(
          command({ turnId: "turn-2", sessionKey: "sk-2", runnerPort: runner.port }),
        ),
      busy,
      "la PK `agent_name` es la invariante, no la memoria de una instancia",
    );
    assert.equal(
      segunda.hasLiveTurnForAgent("agent"),
      false,
      "el rechazo deshace también su reserva en memoria",
    );
    assert.equal(runner.connections(), 1, "no se abrió un segundo socket");
    assert.deepEqual(
      liveTurns.listLiveTurns(),
      [{ agentName: "agent", turnId: "turn-1", sessionKey: "sk-1", startedAt: 1000 }],
      "la fila del turno admitido no se toca",
    );

    runner.finishAll();
    assert.equal((await vivo.completion).event, "turn-complete");
  });

  it("(g) abortar un turno no verificado falla con TURN_UNREACHABLE y conserva el slot", async () => {
    const liveTurns = new LiveTurnRepository(openDb());
    liveTurns.claimLiveTurn({
      agentName: "agent",
      turnId: "turn-previo",
      sessionKey: null,
      startedAt: 1000,
    });
    const turns = new TurnExecution({ apiToken: "service-token", liveTurns });
    turns.loadUnverified(liveTurns.listLiveTurns());

    assert.throws(
      () => turns.abort("agent", "turn-previo"),
      unreachable,
      "no se finge un abort que este proceso no puede entregar",
    );
    assert.equal(turns.hasLiveTurnForAgent("agent"), true, "el slot sigue ocupado");
    assert.equal(liveTurns.listLiveTurns().length, 1);
    assert.throws(
      () => turns.startTurn(command({ runnerPort: 9 })),
      busy,
      "un slot ocupado no se puede pisar por la puerta de atrás",
    );
  });

  it("(h) sin colaborador durable el registro se comporta como antes (admisión y liberación)", async () => {
    const runner = await startRunner();
    const turns = new TurnExecution({ apiToken: "service-token" });

    const primero = turns.startTurn(command({ runnerPort: runner.port }));
    assert.throws(
      () => turns.startTurn(command({ turnId: "turn-2", runnerPort: runner.port })),
      busy,
    );
    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await primero.completion).event, "turn-complete");

    const segundo = turns.startTurn(
      command({ turnId: "turn-2", runnerPort: runner.port }),
    );
    await runner.waitForSockets(2);
    runner.finishAll();
    assert.equal((await segundo.completion).event, "turn-complete");
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });
});
