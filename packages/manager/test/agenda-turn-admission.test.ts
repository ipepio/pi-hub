// T4a — un único turno vivo por Agent, compartido por todos los orígenes.
//
// S2 del ODD `odd/tasks/agent-session-workspace.md`: «at most one executing turn
// across web, Telegram and autonomy». La regla vive en `TurnExecution.startTurn`
// (una sola verdad para la ruta HTTP, el inbound de canales y el Loop), se
// reserva de forma SÍNCRONA antes de crear el socket del Runner y se libera solo
// por el terminal existente — nunca por un abort ni porque el cliente se vaya.
//
// El Runner es un `WebSocketServer` real en un puerto efímero (patrón de
// `agenda-turn-execution.test.ts`): no hay Runner de verdad, pero los sockets
// existen y se pueden contar, que es lo que prueba «no se abrió un segundo».
// El Runner acepta el prompt y NO cierra el turno por su cuenta: el test decide
// cuándo llega `agent_end`, que es lo único que puede liberar la admisión.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import {
  TurnExecution,
  type StartTurnCommand,
} from "../src/agenda/turn-execution.ts";
import { DomainError } from "../src/agenda/errors.ts";

const runners: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of runners.splice(0)) await close();
});

interface RunnerHarness {
  readonly port: number;
  /** Sockets aceptados hasta ahora: la prueba de «no se abrió un segundo». */
  connections(): number;
  /** `sessionKey` de cada socket aceptado, en orden de conexión. */
  sessions(): string[];
  /** Espera a que el Runner haya aceptado `count` sockets. */
  waitForSockets(count: number): Promise<void>;
  /** `agent_end` a todo socket abierto: el terminal que libera la admisión. */
  finishAll(): void;
  close(): Promise<void>;
}

async function startRunner(): Promise<RunnerHarness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const sockets: WebSocket[] = [];
  const sessions: string[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  server.on("connection", (socket, request) => {
    sockets.push(socket);
    const sessionKey = new URL(request.url ?? "/", "ws://runner").searchParams.get(
      "sessionKey",
    );
    sessions.push(sessionKey ?? "");
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
      // El prompt se acepta con `agent_start`; el `abort` se ignora a propósito:
      // un abort no termina el turno, solo lo marca.
      if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
    });
    for (const waiter of waiters.splice(0)) {
      if (sessions.length >= waiter.count) waiter.resolve();
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
    connections: () => sessions.length,
    sessions: () => [...sessions],
    waitForSockets: (count) =>
      new Promise<void>((resolve) => {
        if (sessions.length >= count) {
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

describe("admisión de un turno por Agent (S2)", () => {
  it("rechaza un segundo turno del MISMO Agent desde cualquier origen y no abre socket", async () => {
    const runner = await startRunner();
    const turns = new TurnExecution({ apiToken: "service-token" });

    const vivo = turns.startTurn(
      command({ turnId: "turn-human", sessionKey: "sk-human", runnerPort: runner.port }),
    );

    // La reserva es SÍNCRONA: dos peticiones en el mismo tick no pueden colarse
    // entre «comprobar» y «crear el socket».
    assert.throws(
      () =>
        turns.startTurn(
          command({ turnId: "turn-mismo-tick", sessionKey: "sk-otra", runnerPort: runner.port }),
        ),
      busy,
      "una segunda petición en el mismo tick también debe rechazarse",
    );

    await runner.waitForSockets(1);

    const intentos: Array<{ origen: string; turnId: string; origin: StartTurnCommand["origin"] }> = [
      { origen: "human", turnId: "turn-human-2", origin: { kind: "human" } },
      {
        origen: "channel",
        turnId: "turn-channel",
        origin: { kind: "channel", channelKind: "telegram", chatId: "42" },
      },
      {
        origen: "initiative",
        turnId: "turn-initiative",
        origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
      },
    ];
    for (const intento of intentos) {
      assert.throws(
        () =>
          turns.startTurn(
            command({
              turnId: intento.turnId,
              sessionKey: "sk-otra-sesion",
              runnerPort: runner.port,
              origin: intento.origin,
            }),
          ),
        busy,
        `un turno ${intento.origen} del mismo Agent debe rechazarse`,
      );
    }

    assert.equal(runner.connections(), 1, "un turno rechazado no abre un segundo socket");
    assert.deepEqual(runner.sessions(), ["sk-human"], "solo el turno admitido llegó al Runner");

    // El turno admitido no se vio afectado por los rechazos.
    runner.finishAll();
    assert.equal((await vivo.completion).event, "turn-complete");
  });

  it("dos Agents distintos siguen ejecutando a la vez", async () => {
    const runner = await startRunner();
    const turns = new TurnExecution({ apiToken: "service-token" });

    const a = turns.startTurn(
      command({ agentName: "agent-a", turnId: "turn-a", sessionKey: "sk-a", runnerPort: runner.port }),
    );
    const b = turns.startTurn(
      command({ agentName: "agent-b", turnId: "turn-b", sessionKey: "sk-b", runnerPort: runner.port }),
    );

    await runner.waitForSockets(2);
    assert.deepEqual(runner.sessions().sort(), ["sk-a", "sk-b"]);

    runner.finishAll();
    assert.equal((await a.completion).event, "turn-complete");
    assert.equal((await b.completion).event, "turn-complete");
  });

  it("un abort NO libera la admisión: solo el terminal existente lo hace", async () => {
    const runner = await startRunner();
    const turns = new TurnExecution({ apiToken: "service-token" });

    const primero = turns.startTurn(
      command({ turnId: "turn-1", sessionKey: "sk-1", runnerPort: runner.port }),
    );
    await runner.waitForSockets(1);
    assert.equal(turns.abort("agent", "turn-1"), true);

    // El abort marcó el turno, pero no hay terminal todavía: la admisión sigue
    // tomada. Es la invariante que impide dos ejecuciones del mismo Agent
    // mientras el Runner sigue trabajando en la primera.
    assert.throws(
      () =>
        turns.startTurn(
          command({ turnId: "turn-2", sessionKey: "sk-2", runnerPort: runner.port }),
        ),
      busy,
    );
    assert.equal(runner.connections(), 1);

    runner.finishAll();
    assert.equal((await primero.completion).event, "turn-aborted");
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);

    const segundo = turns.startTurn(
      command({ turnId: "turn-2", sessionKey: "sk-2", runnerPort: runner.port }),
    );
    await runner.waitForSockets(2);
    runner.finishAll();
    assert.equal((await segundo.completion).event, "turn-complete");
  });

  it("el terminal por agent_end libera el Agent para el siguiente turno", async () => {
    const runner = await startRunner();
    const turns = new TurnExecution({ apiToken: "service-token" });

    const primero = turns.startTurn(
      command({ turnId: "turn-1", sessionKey: "sk-1", runnerPort: runner.port }),
    );
    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await primero.completion).event, "turn-complete");

    const segundo = turns.startTurn(
      command({ turnId: "turn-2", sessionKey: "sk-1", runnerPort: runner.port }),
    );
    await runner.waitForSockets(2);
    runner.finishAll();
    assert.equal((await segundo.completion).event, "turn-complete");
    assert.deepEqual(runner.sessions(), ["sk-1", "sk-1"]);
  });

  it("un socket que no se pudo crear no envenena la admisión", async () => {
    const runner = await startRunner();
    let fallos = 1;
    const turns = new TurnExecution({
      apiToken: "service-token",
      createWebSocket: (url) => {
        if (fallos-- > 0) throw new Error("socket imposible");
        return new WebSocket(url);
      },
    });

    assert.throws(
      () => turns.startTurn(command({ sessionKey: "sk-1", runnerPort: runner.port })),
      /socket imposible/,
    );
    assert.equal(
      turns.hasLiveTurnForAgent("agent"),
      false,
      "sin socket no quedó una reserva que bloquee para siempre",
    );

    const siguiente = turns.startTurn(
      command({ turnId: "turn-2", sessionKey: "sk-1", runnerPort: runner.port }),
    );
    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await siguiente.completion).event, "turn-complete");
  });
});
