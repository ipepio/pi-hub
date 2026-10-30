import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
  TurnExecution,
  type CompletedTurn,
  type StartTurnCommand,
} from "../src/agenda/turn-execution.ts";

// Slice (c) part 2b, item 1 (the reply half of it) — tasks c-I10.
//
// `TurnExecution` is the only place that sees every Runner message, so it is
// the only honest place to accumulate the reply text and announce a completed
// turn. The delivery DECISION lives in `channels/delivery-router.ts`; this hook
// just reports facts (origin, user text, reply text, terminal event).
//
// The socket is the injectable `createWebSocket` seam: no Runner, no network.

/** Minimal `ws`-shaped fake: only `on`/`send`/`close` are touched. */
class FakeSocket {
  private readonly listeners = new Map<string, (raw: unknown) => void>();
  readonly sent: string[] = [];
  closed = false;

  on(event: string, listener: (raw: unknown) => void): void {
    this.listeners.set(event, listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: string, payload?: unknown): void {
    this.listeners.get(event)?.(payload);
  }

  /** Runner accepts the turn and streams two deltas, then ends. */
  respondWith(text: string): void {
    this.emit("open");
    this.emit("message", JSON.stringify({ type: "ready", capabilities: ["ask_human_v1"] }));
    this.emit("message", JSON.stringify({ type: "agent_start" }));
    this.emit("message", JSON.stringify({ type: "text_delta", delta: text.slice(0, 5) }));
    this.emit("message", JSON.stringify({ type: "text_delta", delta: text.slice(5) }));
    this.emit("message", JSON.stringify({ type: "agent_end" }));
  }

  failWith(): void {
    this.emit("open");
    this.emit("message", JSON.stringify({ type: "ready", capabilities: [] }));
    this.emit("message", JSON.stringify({ type: "error", message: "boom" }));
  }
}

function command(overrides: Partial<StartTurnCommand> = {}): StartTurnCommand {
  return {
    agentName: "agent",
    turnId: "turn-1",
    idempotencyKey: "idem-1",
    correlationId: "corr-1",
    sessionKey: "agent:agent:main",
    message: "hola desde telegram",
    runnerPort: 4100,
    eventProfile: "verbose",
    origin: { kind: "channel", channelKind: "telegram", chatId: "12345" },
    ...overrides,
  };
}

function execution(onTurnCompleted?: (turn: CompletedTurn) => void) {
  const sockets: FakeSocket[] = [];
  const turns = new TurnExecution({
    apiToken: "service-token",
    now: () => 1_761_100_800_000,
    onTurnCompleted,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { turns, sockets };
}

describe("TurnExecution — canal como origen y hook de turno completado", () => {
  it("acumula la respuesta y notifica con el origen del canal intacto", async () => {
    const completed: CompletedTurn[] = [];
    const { turns, sockets } = execution((turn) => completed.push(turn));

    const handle = turns.startTurn(command());
    sockets[0]!.respondWith("respuesta larga");
    const terminal = await handle.completion;

    assert.equal(terminal.event, "turn-complete");
    assert.equal(completed.length, 1, "exactamente un terminal, una notificación");
    const turn = completed[0]!;
    assert.equal(turn.agentName, "agent");
    assert.equal(turn.turnId, "turn-1");
    assert.equal(turn.userText, "hola desde telegram");
    assert.equal(turn.replyText, "respuesta larga");
    assert.equal(turn.finalEvent, "turn-complete");
    assert.deepEqual(turn.origin, {
      kind: "channel",
      channelKind: "telegram",
      chatId: "12345",
    });
    // El prompt que sale hacia el Runner NO cambia de vocabulario: el Runner no
    // conoce el origen "channel" y no se le debe romper (ADR 0013 solo distingue
    // `human` e `initiative` en el protocolo WS).
    assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), {
      type: "prompt",
      text: "hola desde telegram",
      context: { kind: "human" },
    });
  });

  it("un turno web también notifica: la decisión de entregar no vive aquí", async () => {
    const completed: CompletedTurn[] = [];
    const { turns, sockets } = execution((turn) => completed.push(turn));

    const handle = turns.startTurn(command({ origin: { kind: "human" } }));
    sockets[0]!.respondWith("hola");
    await handle.completion;

    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0]!.origin, { kind: "human" });
  });

  it("un terminal de error notifica con reply vacío (el router lo descarta)", async () => {
    const completed: CompletedTurn[] = [];
    const { turns, sockets } = execution((turn) => completed.push(turn));

    const handle = turns.startTurn(command());
    sockets[0]!.failWith();
    const terminal = await handle.completion;

    assert.equal(terminal.event, "turn-error");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.finalEvent, "turn-error");
    assert.equal(completed[0]!.replyText, "");
  });

  it("un hook que lanza no rompe el terminal ni propaga al consumidor", async () => {
    const { turns, sockets } = execution(() => {
      throw new Error("el router está caído");
    });

    const handle = turns.startTurn(command());
    sockets[0]!.respondWith("hola");
    const terminal = await handle.completion;
    assert.equal(terminal.event, "turn-complete");
    assert.equal(sockets[0]!.closed, true);
  });

  it("sin hook, el puente se comporta exactamente igual (aditivo)", async () => {
    const { turns, sockets } = execution(undefined);
    const events: string[] = [];
    const handle = turns.startTurn({
      ...command(),
      onEvent: (event) => {
        events.push(event.event);
      },
    });
    sockets[0]!.respondWith("hola mundo");
    assert.equal((await handle.completion).event, "turn-complete");
    assert.deepEqual(events, ["turn-start", "chunk", "chunk", "turn-complete"]);
  });
});
