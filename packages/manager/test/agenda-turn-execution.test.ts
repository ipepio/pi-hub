// Fase 3.1 + 3.2 — `TurnExecution`, el puente WS→eventos→terminal
// (`docs/design-autonomia-loop-schedule.md` §9.3.1-3.2).
//
// Verificable de la Fase 3.1: los tests de la ruta HTTP existentes pasan sin
// cambios (regresión) y los tests directos de `TurnExecution` con WS fake
// reproducen la misma secuencia de eventos que la ruta.
//
// Verificable de la Fase 3.2: ningún `startTurn` aceptado queda sin terminal.
// El cierre del Runner sin terminal limpio ya no cierra en silencio: emite
// `turn-error` (causa `runner_unavailable`); el timeout de despacho
// (`dispatchTimeoutMs`) hace lo mismo con el scheduler inyectable; y con el
// repositorio durable inyectado, cada terminal escribe `turns.complete` con
// su causa del catálogo (`turn_failed|runner_unavailable|dispatch_failed`).
//
// El "WS fake" es un `WebSocketServer` real en un puerto efímero (patrón de
// `api-v1-abort.test.ts`): el Runner no se toca, pero el puente WS→eventos se
// ejercita de verdad. El último test de la Fase 3.1 manda la MISMA secuencia
// WS a la ruta HTTP y a `TurnExecution` y afirma que producen los mismos
// eventos.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { WebSocketServer, type WebSocket } from "ws";
import {
  TurnExecution,
  type StartTurnCommand,
  type TimerHandle,
  type TurnSseEvent,
} from "../src/agenda/turn-execution.ts";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

const TURN_ID = "turn-1";

/**
 * Superficie mínima del socket del Runner fake que los handlers usan. El
 * socket real de `ws` es estructuralmente compatible (solo se tocan
 * `on`/`send`/`close`).
 */
interface FakeRunnerSocket {
  on(event: string | symbol, listener: (raw: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

const openRunners: Array<() => Promise<void>> = [];
const openDbs: SqliteDb[] = [];

afterEach(async () => {
  for (const close of openRunners.splice(0)) await close();
  for (const db of openDbs.splice(0)) db.close();
});

/** Fixture de `:memory:` con el esquema aplicado (patrón `agenda-turns.test.ts`). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

/** Siembra una Initiative `running` enlazada a un turno — setup de fixture. */
function insertRunningInitiative(
  db: SqliteDb,
  id: string,
  agentName: string,
  turnId: string,
): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, agentName, "running", "human", null, "di hola", "solo", "sk-1", 1,
    "modelo", turnId, 0, null, 0, null, null, null, null, 1000, 1000, 1000, null,
  );
}

/** Arranca un "Runner fake": un WebSocketServer que responde como el Runner. */
async function startRunner(
  behavior: (socket: FakeRunnerSocket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const runner = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => runner.once("listening", () => resolve()));
  const address = runner.address();
  assert.ok(address && typeof address === "object");
  runner.on("connection", (socket) => behavior(socket as unknown as FakeRunnerSocket));
  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      runner.close(() => resolve());
    });
  openRunners.push(close);
  return { port: address.port, close };
}

/** Comando base de `startTurn` para los tests. */
function command(overrides: Partial<StartTurnCommand> = {}): StartTurnCommand {
  return {
    agentName: "agent",
    turnId: TURN_ID,
    idempotencyKey: "idem-1",
    correlationId: "corr-1",
    sessionKey: "session-1",
    message: "hola",
    runnerPort: 1, // lo pisa cada test con el puerto real del Runner fake
    eventProfile: "basic",
    origin: { kind: "human" },
    ...overrides,
  };
}

/** Recoge los eventos emitidos por un `TurnHandle` y permite esperar uno concreto. */
class EventCollector {
  readonly events: TurnSseEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: TurnSseEvent) => boolean;
    resolve: (event: TurnSseEvent) => void;
  }> = [];

  push(event: TurnSseEvent): void {
    this.events.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter.predicate(event)) {
        this.waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  }

  /** Resuelve con el primer evento que cumple `predicate` (el que ya llegó, si llegó). */
  waitFor(predicate: (event: TurnSseEvent) => boolean): Promise<TurnSseEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }
}

function fakeSupervisor(port: number): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    statusOf: async () => ({ state: "running", port, pid: 42 }),
  } as unknown as Supervisor;
}

/** Lee los eventos SSE de una respuesta de la ruta (formato de `streamSSE`). */
async function readSseEvents(
  response: Response,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let pending = "";
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let done = false;
  while (!done) {
    const read = await reader!.read();
    done = read.done;
    if (read.value) pending += decoder.decode(read.value, { stream: !done });
    pending = pending.replace(/\r\n/g, "\n");
    let separator = pending.indexOf("\n\n");
    while (separator >= 0) {
      const block = pending.slice(0, separator);
      pending = pending.slice(separator + 2);
      separator = pending.indexOf("\n\n");
      const eventName = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!eventName || !data) continue;
      events.push({ event: eventName, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  // Un bloque final sin separador `\n\n` (stream cortado justo después del
  // último evento) todavía es un evento válido.
  if (pending.trim().length > 0) {
    const eventName = pending.match(/^event: (.+)$/m)?.[1];
    const data = pending.match(/^data: (.+)$/m)?.[1];
    if (eventName && data) {
      events.push({ event: eventName, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  return events;
}

/** Respuesta del "Runner fake" a una secuencia de turno típica. */
function happySequence(socket: FakeRunnerSocket): void {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as { type?: string };
    if (message.type === "prompt") {
      socket.send(JSON.stringify({ type: "agent_start" }));
      socket.send(JSON.stringify({ type: "text_delta", delta: "Hola" }));
      socket.send(JSON.stringify({ type: "thinking_delta", delta: "mmm" }));
      socket.send(JSON.stringify({ type: "tool_start", toolName: "read" }));
      socket.send(JSON.stringify({ type: "tool_end", toolName: "read", isError: false }));
      socket.send(JSON.stringify({ type: "agent_end" }));
    }
  });
}

describe("TurnExecution — el puente WS→eventos→terminal (Fase 3.1 + 3.2)", () => {
  it("secuencia básica: agent_start → text_delta → agent_end produce turn-start, chunk, turn-complete y libera el turno vivo", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.send(JSON.stringify({ type: "text_delta", delta: "Hola" }));
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "chunk", data: { turnId: TURN_ID, delta: "Hola" } },
      { event: "turn-complete", data: { turnId: TURN_ID, totalTokens: 0 } },
    ]);
    // El turno se libera del registro al terminar (el alta mientras está
    // vivo se prueba con el flujo de abort, donde el turno no es terminal).
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
    assert.equal(turns.hasAnyLiveTurn(), false);
  });

  it("verbose traduce thinking_delta, tool_start y tool_end", async () => {
    const runner = await startRunner(happySequence);

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(
      command({ runnerPort: runner.port, eventProfile: "verbose", onEvent: (e) => collector.push(e) }),
    );

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "chunk", data: { turnId: TURN_ID, delta: "Hola" } },
      { event: "thinking-delta", data: { turnId: TURN_ID, delta: "mmm" } },
      { event: "tool-start", data: { turnId: TURN_ID, toolName: "read" } },
      { event: "tool-end", data: { turnId: TURN_ID, toolName: "read", isError: false } },
      { event: "turn-complete", data: { turnId: TURN_ID, totalTokens: 0 } },
    ]);
  });

  it("basic omite el razonamiento y las tools, como la ruta", async () => {
    const runner = await startRunner(happySequence);

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "chunk", data: { turnId: TURN_ID, delta: "Hola" } },
      { event: "turn-complete", data: { turnId: TURN_ID, totalTokens: 0 } },
    ]);
  });

  it("los mensajes desconocidos y de conexión se ignoran sin romper el turno", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.send(JSON.stringify({ type: "ready", agent: "a", sessionId: "s" }));
          socket.send(JSON.stringify({ type: "inventado-mañana" }));
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "turn-complete", data: { turnId: TURN_ID, totalTokens: 0 } },
    ]);
  });

  it("un error del Runner se traduce a turn-error con el código estable", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.send(JSON.stringify({ type: "error", message: "ENOENT /data/agents/x" }));
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");
    assert.equal((terminal?.data as { code: string }).code, "INTERNAL_ERROR");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "turn-error", data: { turnId: TURN_ID, code: "INTERNAL_ERROR", message: "Runner error" } },
    ]);
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("Fase 3.2: un close del Runner sin terminal ni abort emite turn-error (el cierre mudo desaparece)", async () => {
    // La ruta original cerraba el SSE en silencio ante un close del Runner sin
    // terminal. Fase 3.2 lo convierte en `turn-error`: ningún turno aceptado
    // queda sin terminal (§4.6).
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.close();
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");
    assert.equal((terminal?.data as { code: string }).code, "RESOURCE_UNAVAILABLE");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      {
        event: "turn-error",
        data: { turnId: TURN_ID, code: "RESOURCE_UNAVAILABLE", message: "Runner unavailable" },
      },
    ]);
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("abort marca el turno y el siguiente agent_end publica turn-aborted; un turno desconocido devuelve false", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
        if (message.type === "abort") socket.send(JSON.stringify({ type: "agent_end" }));
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    await collector.waitFor((e) => e.event === "turn-start");
    assert.equal(turns.abort("agent", TURN_ID), true);
    assert.equal(turns.abort("agent", "turn-fantasma"), false);

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-aborted");
    assert.deepEqual(collector.events, [
      { event: "turn-start", data: { turnId: TURN_ID } },
      { event: "turn-aborted", data: { turnId: TURN_ID } },
    ]);
  });

  it("un close del Runner después del abort publica turn-aborted", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
        if (message.type === "abort") socket.close();
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    await collector.waitFor((e) => e.event === "turn-start");
    assert.equal(turns.abort("agent", TURN_ID), true);

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-aborted");
  });

  it("un error de conexión (puerto sin Runner) se traduce a turn-error RESOURCE_UNAVAILABLE", async () => {
    const probe = await startRunner(() => {});
    const closedPort = probe.port;
    await probe.close();

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: closedPort, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");
    assert.equal((terminal?.data as { code: string }).code, "RESOURCE_UNAVAILABLE");
    assert.deepEqual(collector.events, [
      {
        event: "turn-error",
        data: { turnId: TURN_ID, code: "RESOURCE_UNAVAILABLE", message: "Runner unavailable" },
      },
    ]);
  });

  it("disconnect() (el cliente se fue) corta el WS y resuelve completion con turn-error", async () => {
    let resolveServerClosed!: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      resolveServerClosed = resolve;
    });
    const runner = await startRunner((socket) => {
      socket.on("close", () => resolveServerClosed());
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    await collector.waitFor((e) => e.event === "turn-start");
    assert.equal(turns.hasLiveTurnForAgent("agent"), true);

    handle.disconnect();
    const terminal = await handle.completion;
    // Fase 3.2: el corte también es un terminal — no puede haber un turno
    // aceptado sin terminal.
    assert.equal(terminal?.event, "turn-error");
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
    assert.equal(turns.hasAnyLiveTurn(), false);

    // El WS contra el Runner se cortó de verdad: no queda una fuga generando.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("el WS del Runner no se cerró tras disconnect()")),
        1000,
      );
      void serverClosed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it("el registro distingue turnos por Agent y libera cada uno al terminar", async () => {
    // El Runner fake no manda `agent_end` hasta recibir `abort`: así el turno
    // sigue vivo mientras se inspecciona el registro (si el terminal llegara
    // en la misma ráfaga, el registro ya se habría liberado).
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
        if (message.type === "abort") socket.send(JSON.stringify({ type: "agent_end" }));
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collectorA = new EventCollector();
    const handleA = turns.startTurn(
      command({
        agentName: "agent-a",
        turnId: "turn-a",
        runnerPort: runner.port,
        onEvent: (e) => collectorA.push(e),
      }),
    );
    const collectorB = new EventCollector();
    const handleB = turns.startTurn(
      command({
        agentName: "agent-b",
        turnId: "turn-b",
        runnerPort: runner.port,
        onEvent: (e) => collectorB.push(e),
      }),
    );

    // Ambos WS abiertos (registro de vivos) antes de mirar el registro.
    await collectorA.waitFor((e) => e.event === "turn-start");
    await collectorB.waitFor((e) => e.event === "turn-start");
    assert.equal(turns.hasAnyLiveTurn(), true);
    assert.equal(turns.hasLiveTurnForAgent("agent-a"), true);
    assert.equal(turns.hasLiveTurnForAgent("agent-b"), true);

    // Termina A; B sigue vivo y el registro lo distingue.
    assert.equal(turns.abort("agent-a", "turn-a"), true);
    await handleA.completion;
    assert.equal(turns.hasLiveTurnForAgent("agent-a"), false);
    assert.equal(turns.hasLiveTurnForAgent("agent-b"), true);
    assert.equal(turns.hasAnyLiveTurn(), true);

    // Termina B; no queda ningún turno vivo.
    assert.equal(turns.abort("agent-b", "turn-b"), true);
    await handleB.completion;
    assert.equal(turns.hasAnyLiveTurn(), false);
  });

  it("la ruta HTTP y TurnExecution producen los mismos eventos para la misma secuencia WS", async () => {
    // (a) vía la ruta HTTP: POST /agents/agent/turns y lectura del SSE.
    const routeRunner = await startRunner(happySequence);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-turn-exec-eq-"));
    try {
      await scaffoldGlobalDirs(dataDir);
      await scaffoldAgentDirs(dataDir, "agent");
      await writeAgent(dataDir, {
        name: "agent",
        port: routeRunner.port,
        enabled: true,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(routeRunner.port));
      const response = await app.request("http://pihub.test/agents/agent/turns?eventProfile=verbose", {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "session-eq",
          turnId: TURN_ID,
          idempotencyKey: "idem-eq",
          correlationId: "corr-eq",
          message: "hola",
        }),
      });
      assert.equal(response.status, 200);
      const routeEvents = await readSseEvents(response);

      // (b) vía `TurnExecution` directo, con la MISMA secuencia y perfil.
      const directRunner = await startRunner(happySequence);
      const turns = new TurnExecution({ apiToken: "service-token" });
      const collector = new EventCollector();
      const handle = turns.startTurn(
        command({
          runnerPort: directRunner.port,
          eventProfile: "verbose",
          onEvent: (e) => collector.push(e),
        }),
      );
      await handle.completion;

      assert.deepEqual(routeEvents, collector.events);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("completion resuelve exactamente una vez (el terminal no puede repetirse)", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.send(JSON.stringify({ type: "agent_end" }));
          // El Runner "se repite": el segundo agent_end debe ignorarse.
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token" });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    const completions = await Promise.all([handle.completion, handle.completion]);
    assert.ok(completions.every((t) => t?.event === "turn-complete"));
    // Un solo turn-complete en el stream, no dos.
    assert.equal(collector.events.filter((e) => e.event === "turn-complete").length, 1);
  });

  // --- Fase 3.2: el hueco del terminal ---

  /**
   * Scheduler manual (plan §7.1): solo corre los callbacks al `advance(ms)`;
   * el test no duerme. El handle es un número opaco; se tipa como
   * `TimerHandle` porque el contrato del scheduler inyectable lo exige.
   */
  class ManualTimer {
    private elapsed = 0;
    private nextId = 0;
    private readonly pending = new Map<number, { callback: () => void; deadline: number }>();

    readonly schedule = (callback: () => void, ms: number): TimerHandle => {
      const id = ++this.nextId;
      this.pending.set(id, { callback, deadline: this.elapsed + ms });
      return id as unknown as TimerHandle;
    };

    readonly cancel = (handle: TimerHandle): void => {
      this.pending.delete(Number(handle));
    };

    /** Avanza el reloj y corre los callbacks cuyo plazo ya venció. */
    advance(ms: number): void {
      this.elapsed += ms;
      for (const [id, task] of [...this.pending.entries()]) {
        if (task.deadline <= this.elapsed) {
          this.pending.delete(id);
          task.callback();
        }
      }
    }
  }

  it("Fase 3.2: timeout de despacho — el Runner que acepta pero no responde emite turn-error runner_unavailable", async () => {
    // El Runner acepta la conexión y no hace nada más (ni agent_start, ni
    // cierre): es el hueco que el watchdog cierra (§4.6).
    const runner = await startRunner(() => {});

    const timer = new ManualTimer();
    const turns = new TurnExecution({
      apiToken: "service-token",
      dispatchTimeoutMs: 100,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    // Dentro del plazo: ningún terminal, el turno sigue vivo.
    timer.advance(99);
    assert.equal(collector.events.length, 0);

    // Vence el plazo: turn-error runner_unavailable y el turno se libera.
    timer.advance(1);
    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");
    assert.equal((terminal?.data as { code: string }).code, "RESOURCE_UNAVAILABLE");
    assert.deepEqual(collector.events, [
      {
        event: "turn-error",
        data: { turnId: TURN_ID, code: "RESOURCE_UNAVAILABLE", message: "Runner unavailable" },
      },
    ]);
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("Fase 3.2: un envío del prompt que falla tras aceptar el turno emite turn-error dispatch_failed y lo persiste", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    agenda.turns.reserveIdempotency("agent", TURN_ID, "idem-df", 1000);
    insertRunningInitiative(db, "ini-df", "agent", TURN_ID);

    // Fake WS: emite "open" en el siguiente tick (tras registrar listeners) y
    // su `send` lanza — reproduce el guardia de `turn-execution.ts:317-322`.
    const fakeWs = {
      abortRequested: false,
      sent: false,
      listeners: new Map<string, Array<(raw: unknown) => void>>(),
      on(event: string, fn: (raw: unknown) => void) {
        (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(fn);
        if (event === "open") queueMicrotask(() => this.listeners.get("open")?.forEach((f) => f(undefined)));
      },
      send() { this.sent = true; throw new Error("send simulado falla"); },
      close() {},
    };
    const turns = new TurnExecution({
      apiToken: "service-token",
      repository: agenda.turns,
      createWebSocket: () => fakeWs as unknown as WebSocket,
    });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ idempotencyKey: "idem-df", onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal.event, "turn-error");
    assert.equal((terminal.data as { code: string }).code, "RESOURCE_UNAVAILABLE");
    assert.ok(fakeWs.sent, "el prompt se intentó enviar");

    const ini = agenda.initiatives.get("ini-df");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "dispatch_failed");
    assert.equal(turns.hasLiveTurnForAgent("agent"), false);
  });

  it("Fase 3.2: el watchdog se cancela con el primer agent_start y no se dispara después del terminal", async () => {
    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      });
    });

    const timer = new ManualTimer();
    const turns = new TurnExecution({
      apiToken: "service-token",
      dispatchTimeoutMs: 100,
      schedule: timer.schedule,
      cancel: timer.cancel,
    });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");

    // El plazo vence después del terminal: el watchdog ya está cancelado y no
    // vuelve a emitir nada.
    timer.advance(1000);
    assert.equal(collector.events.filter((e) => e.event === "turn-error").length, 0);
  });

  it("Fase 3.2: close sin terminal escribe failed con runner_unavailable en el repositorio durable", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    agenda.turns.reserveIdempotency("agent", TURN_ID, "idem-durable-close", 1000);
    insertRunningInitiative(db, "ini-close", "agent", TURN_ID);

    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "agent_start" }));
          socket.close();
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token", repository: agenda.turns });
    const handle = turns.startTurn(command({ runnerPort: runner.port }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");

    const ini = agenda.initiatives.get("ini-close");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "runner_unavailable");
    assert.ok(ini.finishedAt !== null);
  });

  it("Fase 3.2: un error del Runner escribe failed con turn_failed", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    agenda.turns.reserveIdempotency("agent", TURN_ID, "idem-durable-err", 1000);
    insertRunningInitiative(db, "ini-err", "agent", TURN_ID);

    const runner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "error", message: "boom" }));
        }
      });
    });

    const turns = new TurnExecution({ apiToken: "service-token", repository: agenda.turns });
    const handle = turns.startTurn(command({ runnerPort: runner.port }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-error");

    const ini = agenda.initiatives.get("ini-err");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "turn_failed");
  });

  it("Fase 3.2: turn-complete escribe succeeded y turn-aborted escribe cancelled (sin failure_reason)", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    agenda.turns.reserveIdempotency("agent", "turn-ok", "idem-durable-ok", 1000);
    insertRunningInitiative(db, "ini-ok", "agent", "turn-ok");
    agenda.turns.reserveIdempotency("agent", "turn-ab", "idem-durable-ab", 1000);
    insertRunningInitiative(db, "ini-ab", "agent", "turn-ab");

    const okRunner = await startRunner(happySequence);
    const turnsOk = new TurnExecution({ apiToken: "service-token", repository: agenda.turns });
    const okHandle = turnsOk.startTurn(command({ turnId: "turn-ok", idempotencyKey: "idem-durable-ok", runnerPort: okRunner.port }));
    assert.equal((await okHandle.completion)?.event, "turn-complete");
    const iniOk = agenda.initiatives.get("ini-ok");
    assert.equal(iniOk.state, "succeeded");
    assert.equal(iniOk.failureReason, null);

    const abRunner = await startRunner((socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
        if (message.type === "abort") socket.send(JSON.stringify({ type: "agent_end" }));
      });
    });
    const turnsAb = new TurnExecution({ apiToken: "service-token", repository: agenda.turns });
    const abCollector = new EventCollector();
    const abHandle = turnsAb.startTurn(
      command({ turnId: "turn-ab", idempotencyKey: "idem-durable-ab", runnerPort: abRunner.port, onEvent: (e) => abCollector.push(e) }),
    );
    await abCollector.waitFor((e) => e.event === "turn-start");
    assert.equal(turnsAb.abort("agent", "turn-ab"), true);
    assert.equal((await abHandle.completion)?.event, "turn-aborted");
    const iniAb = agenda.initiatives.get("ini-ab");
    assert.equal(iniAb.state, "cancelled");
    assert.equal(iniAb.failureReason, null);
  });

  it("Fase 3.2: turno humano sin reserva durable — el terminal se entrega y el write se tolera", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    // Sin reserva durable (como la ruta HTTP de Fase 3.2): `complete`
    // lanzaría TURN_NOT_FOUND, pero el SSE ya tiene el evento y el write no
    // debe romper la entrega del terminal.
    const runner = await startRunner(happySequence);

    const turns = new TurnExecution({ apiToken: "service-token", repository: agenda.turns });
    const collector = new EventCollector();
    const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));

    const terminal = await handle.completion;
    assert.equal(terminal?.event, "turn-complete");
    assert.deepEqual(collector.events.at(-1), { event: "turn-complete", data: { turnId: TURN_ID, totalTokens: 0 } });
  });

  it("Fase 3.2: ningún startTurn aceptado queda sin terminal (completion nunca es undefined)", async () => {
    const scenarios: Array<{
      name: string;
      behavior: (socket: FakeRunnerSocket) => void;
      expected: string;
    }> = [
      { name: "feliz", behavior: happySequence, expected: "turn-complete" },
      {
        name: "error del Runner",
        behavior: (socket) => {
          socket.on("message", (raw) => {
            const message = JSON.parse(String(raw)) as { type?: string };
            if (message.type === "prompt") socket.send(JSON.stringify({ type: "error", message: "boom" }));
          });
        },
        expected: "turn-error",
      },
      {
        name: "close sin terminal",
        behavior: (socket) => {
          socket.on("message", (raw) => {
            const message = JSON.parse(String(raw)) as { type?: string };
            if (message.type === "prompt") {
              socket.send(JSON.stringify({ type: "agent_start" }));
              socket.close();
            }
          });
        },
        expected: "turn-error",
      },
      {
        name: "abort → close sin agent_end",
        behavior: (socket) => {
          socket.on("message", (raw) => {
            const message = JSON.parse(String(raw)) as { type?: string };
            if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
            if (message.type === "abort") socket.close();
          });
        },
        expected: "turn-aborted",
      },
    ];

    for (const scenario of scenarios) {
      const runner = await startRunner(scenario.behavior);
      const turns = new TurnExecution({ apiToken: "service-token" });
      const collector = new EventCollector();
      const handle = turns.startTurn(command({ runnerPort: runner.port, onEvent: (e) => collector.push(e) }));
      if (scenario.name === "abort → close sin agent_end") {
        await collector.waitFor((e) => e.event === "turn-start");
        turns.abort("agent", TURN_ID);
      }
      const terminal = await handle.completion;
      assert.ok(terminal !== undefined, `${scenario.name}: completion debe ser un terminal`);
      assert.equal(terminal.event, scenario.expected);
    }
  });
});
