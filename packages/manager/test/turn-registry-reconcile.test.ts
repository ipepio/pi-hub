// T4-D/2 — reconciliación al arranque de las reservas de admisión durables
// (seguimiento del ODD `agent-session-workspace`, S2).
//
// T4-D/1 dejó la reserva en `agent_live_turns` y el arranque la carga como «no
// verificada»: el Agent queda bloqueado (fail-closed) porque el Runner puede seguir
// ejecutando ese turno o haberse muerto con el Manager anterior, y este proceso no
// tiene su socket. Lo que faltaba es RESOLVERLA: un turno huérfano bloquea al Agent
// para siempre si nadie lo cierra.
//
// La política es fail-closed y NUNCA adopta el turno (no hay forma de volver a
// engancharse al SSE/WS del proceso anterior):
//   1. Runner en marcha + gate ocupada + titular == identidad de la fila → CONFIRMADO
//      (se conserva todo; el Agent sigue bloqueado).
//   2. Runner en marcha + gate libre → HUÉRFANO.
//   3. Runner parado/errored/sin puerto     → HUÉRFANO.
//   4. Runner en marcha + gate ocupada, pero el titular NO es el de la fila, o el
//      endpoint no se puede leer/entender → NO RESUELTO (se conserva todo y se
//      grita en el log; el siguiente arranque reconcilia).
// El huérfano se resuelve liberando la fila durable, cerrando el turno `failed` con
// causa `turn_orphaned` y liberando la admisión en memoria, en ese orden: si el
// terminal durable no se puede escribir, no se libera nada.
//
// El «Runner» de estos tests es un `WebSocketServer` real en un puerto efímero
// (patrón de `turn-registry-durable.test.ts`) y el `/api/status` es un `fetchImpl`
// falso: lo que se prueba es la POLÍTICA, no el transporte del Runner.
//
// La ruta de abort importa de `dist` (patrón de los suites de `/api/v1`): el router
// comprueba `instanceof DomainError` contra la clase construida, así que el ejecutor
// inyectado tiene que ser la MISMA copia.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { WebSocket, WebSocketServer } from "ws";
import { TurnExecution, type StartTurnCommand } from "../src/agenda/turn-execution.ts";
import { TurnRepository } from "../src/agenda/turns.ts";
import { DomainError } from "../src/agenda/errors.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { LiveTurnRepository } from "../src/storage/live-turns.ts";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { reconcileLiveTurns } from "../src/startup-reconcile.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { TurnExecution as DistTurnExecution } from "../dist/agenda/turn-execution.js";

const runners: Array<() => Promise<void>> = [];
const dbs: SqliteDb[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const close of runners.splice(0)) await close();
  for (const db of dbs.splice(0)) db.close();
  for (const dataDir of dataDirs.splice(0)) {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

/** Base `:memory:` con el esquema REAL (migraciones de producción). */
function openDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  dbs.push(db);
  return db;
}

interface RunnerHarness {
  readonly port: number;
  readonly connections: () => number;
  waitForSockets(count: number): Promise<void>;
  finishAll(): void;
}

/** Runner fake: anuncia `ready`, acepta el prompt y no cierra por su cuenta. */
async function startRunner(): Promise<RunnerHarness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "ready",
        agent: "agent",
        sessionId: "sk-1",
        capabilities: ["prompt_context_v1", "ask_human_v1"],
      }),
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type !== "prompt") return;
      socket.send(JSON.stringify({ type: "agent_start" }));
    });
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
            if (sockets.length >= count) return resolve();
            server.on("connection", function check() {
              if (sockets.length >= count) resolve();
              else server.once("connection", check);
            });
          }),
    finishAll: () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "agent_end" }));
      }
    },
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
    runnerPort: 1,
    eventProfile: "basic",
    origin: { kind: "human" },
    ...overrides,
  };
}

/** Validador de `assert.throws`: el rechazo es el código cerrado, no un texto. */
function busy(error: unknown): boolean {
  return error instanceof DomainError && error.code === "TURN_IN_PROGRESS";
}

/**
 * Supervisor falso: SOLO las dos preguntas que la reconciliación hace. `port`
 * `undefined` reproduce un Agent parado (sin Runner al que preguntar).
 */
function fakeSupervisor(options: { state?: string; port?: number } = {}) {
  const state = options.state ?? "running";
  const port = options.port;
  return {
    state: () => ({ state }),
    runnerPortOf: () => port,
  };
}

/** `/api/status` falso: lo único que la reconciliación lee es `execution`. */
function statusResponse(execution: unknown, status = 200) {
  return {
    ok: status === 200,
    status,
    json: async () => ({ agent: "agent", model: "proveedor/modelo", execution }),
  };
}

/** Fetches que un caso NO debe hacer: falla fuerte en vez de devolver algo. */
function forbiddenFetch(url: string): never {
  throw new Error(`no debía consultarse el Runner: ${url}`);
}

    /**
     * Fila cruda de `turns`. `DatabaseSync.get()` devuelve objetos de prototipo
     * nulo: se copia campo a campo para poder compararlos con `deepEqual`.
     */
    function durableTurn(db: SqliteDb, agentName: string, turnId: string) {
      const row = db
        .prepare(
          "SELECT final_state, result, finished_at FROM turns WHERE agent_name = ? AND turn_id = ?",
        )
        .get(agentName, turnId) as
        | { final_state: string | null; result: string | null; finished_at: number | null }
        | undefined;
      return row === undefined
        ? undefined
        : { final_state: row.final_state, result: row.result, finished_at: row.finished_at };
    }

/** Initiative `running` enlazada al turno: el terminal le escribe `failure_reason`. */
function seedRunningInitiative(db: SqliteDb, agentName: string, turnId: string): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, intent, mode, session_key, available_at, turn_id,
        chain_depth, visible_effects_declared, created_at, state_changed_at, started_at)
     VALUES (?,?,'running','human',?, 'solo', ?, ?, ?, 0, 0, ?, ?, ?)`,
  ).run(`ini-${turnId}`, agentName, "iniciativa de prueba", "sk-1", 1000, turnId, 1000, 1000, 1000);
}

    /**
     * Fila cruda de `initiatives` (prototipo nulo → se copia campo a campo para
     * poder compararla con `deepEqual`, igual que `durableTurn`).
     */
    function initiativeRow(db: SqliteDb, agentName: string, turnId: string) {
      const row = db
        .prepare(
          "SELECT state, failure_reason, finished_at FROM initiatives WHERE agent_name = ? AND turn_id = ?",
        )
        .get(agentName, turnId) as
        | { state: string; failure_reason: string | null; finished_at: number | null }
        | undefined;
      return row === undefined
        ? undefined
        : { state: row.state, failure_reason: row.failure_reason, finished_at: row.finished_at };
    }

interface Harness {
  readonly db: SqliteDb;
  readonly liveTurns: LiveTurnRepository;
  readonly turns: TurnExecution;
  readonly logs: string[];
}

/**
 * Estado del arranque: fila durable + reserva de `turns` de una vida anterior del
 * Manager, cargadas en memoria como «no verificadas» (lo que hizo T4-D/1).
 */
function previousLife(options: { sessionKey?: string | null } = {}): Harness {
  const db = openDb();
  const liveTurns = new LiveTurnRepository(db);
  const turnsRepo = new TurnRepository(db);
  liveTurns.claimLiveTurn({
    agentName: "agent",
    turnId: "turn-1",
    sessionKey: options.sessionKey === undefined ? "sk-1" : options.sessionKey,
    startedAt: 1000,
  });
  turnsRepo.reserveIdempotency("agent", "turn-1", "idem-1", 1000);
  seedRunningInitiative(db, "agent", "turn-1");

  const logs: string[] = [];
  const turns = new TurnExecution({
    apiToken: "service-token",
    repository: turnsRepo,
    liveTurns,
    now: () => 5000,
  });
  const loaded = turns.loadUnverified(liveTurns.listLiveTurns());
  assert.equal(loaded, 1, "la fila de la vida anterior entra al registro como no verificada");
  assert.equal(turns.hasLiveTurnForAgent("agent"), true);

  return { db, liveTurns, turns, logs };
}

describe("reconciliación de turnos vivos al arrancar (T4-D/2)", () => {
  it("(1) confirmado: el Runner sigue ejecutando ESE turno — se conserva todo y el Agent sigue bloqueado", async () => {
    const harness = previousLife();
    const runner = await startRunner();
    const urls: string[] = [];

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      turns: harness.turns,
      fetchImpl: async (url) => {
        urls.push(url);
        return statusResponse({ busy: true, holder: "sk-1" });
      },
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 1, orphaned: 0, unresolved: 0, deferred: 0 });
    assert.deepEqual(urls, ["http://127.0.0.1:4100/api/status"], "se pregunta al Runner por su gate");

    assert.deepEqual(
      harness.liveTurns.listLiveTurns(),
      [{ agentName: "agent", turnId: "turn-1", sessionKey: "sk-1", startedAt: 1000 }],
      "una reserva confirmada no se libera: el turno sigue ejecutándose",
    );
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), true, "el Agent sigue ocupado");
    assert.equal(harness.turns.liveTurnIdForAgent("agent"), "turn-1");
    assert.equal(
      durableTurn(harness.db, "agent", "turn-1")?.final_state,
      null,
      "el turno durable sigue abierto: su terminal llegará (o no) por el socket viejo",
    );
    assert.equal(initiativeRow(harness.db, "agent", "turn-1")?.state, "running");
    assert.throws(
      () => harness.turns.startTurn(command({ runnerPort: runner.port })),
      busy,
      "la admisión sigue rechazando (fail-closed)",
    );
    assert.equal(runner.connections(), 0, "el rechazo no abre socket contra el Runner");
  });

  it("(2) huérfano con el Runner en marcha y la gate libre: libera la fila, cierra el turno y admite otra vez", async () => {
    const harness = previousLife();
    const runner = await startRunner();

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      turns: harness.turns,
      fetchImpl: async () => statusResponse({ busy: false, holder: null }),
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 1, unresolved: 0, deferred: 0 });
    assert.deepEqual(
      harness.liveTurns.listLiveTurns(),
      [],
      "un turno huérfano no puede seguir bloqueando al Agent",
    );
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), false, "la admisión queda libre");
    assert.equal(harness.turns.liveTurnIdForAgent("agent"), undefined);

    assert.deepEqual(
      durableTurn(harness.db, "agent", "turn-1"),
      { final_state: "failed", result: null, finished_at: 5000 },
      "el turno se cierra como `failed` (el catálogo de final_state no cambia)",
    );
    assert.deepEqual(
      initiativeRow(harness.db, "agent", "turn-1"),
      { state: "failed", failure_reason: "turn_orphaned", finished_at: 5000 },
      "la causa `turn_orphaned` se escribe en la Initiative enlazada",
    );

    // La prueba de que la admisión quedó libre: el siguiente turno del MISMO Agent
    // arranca contra el Runner de verdad.
    const siguiente = harness.turns.startTurn(
      command({ turnId: "turn-2", idempotencyKey: "idem-2", runnerPort: runner.port }),
    );
    // El socket abre de forma asíncrona: hay que ESPERARLO antes de contarlo o
    // de cerrar el turno — si el test aborta aquí, el terminal tardío del socket
    // llega después del afterEach y el release durable falla (log, no bug).
    await runner.waitForSockets(1);
    assert.equal(runner.connections(), 1, "el turno nuevo sí abre su socket");
    runner.finishAll();
    assert.equal((await siguiente.completion).event, "turn-complete");
  });

  it("(3) huérfano con el Runner parado: mismo desenlace, sin preguntar al endpoint", async () => {
    const harness = previousLife();
    const runner = await startRunner();

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "stopped" }),
      turns: harness.turns,
      fetchImpl: forbiddenFetch,
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 1, unresolved: 0, deferred: 0 });
    assert.deepEqual(harness.liveTurns.listLiveTurns(), []);
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), false);
    assert.equal(durableTurn(harness.db, "agent", "turn-1")?.final_state, "failed");
    assert.equal(
      initiativeRow(harness.db, "agent", "turn-1")?.failure_reason,
      "turn_orphaned",
    );

    const siguiente = harness.turns.startTurn(
      command({ turnId: "turn-2", idempotencyKey: "idem-2", runnerPort: runner.port }),
    );
    await runner.waitForSockets(1);
    runner.finishAll();
    assert.equal((await siguiente.completion).event, "turn-complete");
  });

  it("(4) no resuelto: la gate está ocupada por OTRA identidad — se conserva todo y la admisión sigue en 409", async () => {
    const harness = previousLife();
    const runner = await startRunner();

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      turns: harness.turns,
      // La gate está ocupada, pero por el turno de otra sesión: no se puede
      // demostrar que esta fila sea la que se ejecuta.
      fetchImpl: async () => statusResponse({ busy: true, holder: "sk-otra" }),
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 0, unresolved: 1, deferred: 0 });
    assert.deepEqual(
      harness.liveTurns.listLiveTurns(),
      [{ agentName: "agent", turnId: "turn-1", sessionKey: "sk-1", startedAt: 1000 }],
      "sin prueba de identidad no se libera la reserva (fail-closed)",
    );
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), true);
    assert.equal(durableTurn(harness.db, "agent", "turn-1")?.final_state, null);
    assert.throws(
      () => harness.turns.startTurn(command({ runnerPort: runner.port })),
      busy,
    );
    assert.ok(
      harness.logs.some((line) => line.includes("UNRESOLVED") && line.includes("turn-1")),
      `el caso ambiguo se grita en el log: ${harness.logs.join(" | ")}`,
    );
  });

  it("(5) no resuelto: un `/api/status` ilegible no cambia nada (nunca lanza)", async () => {
    const harness = previousLife();
    const runner = await startRunner();

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      turns: harness.turns,
      fetchImpl: async () => {
        throw new Error("Runner inaccesible");
      },
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 0, unresolved: 1, deferred: 0 });
    assert.equal(harness.liveTurns.listLiveTurns().length, 1);
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), true);
    assert.equal(durableTurn(harness.db, "agent", "turn-1")?.final_state, null);
    assert.throws(() => harness.turns.startTurn(command({ runnerPort: runner.port })), busy);
  });

  it("(6) no resuelto: una respuesta sin el campo `execution` (Runner anterior) se trata como ilegible", async () => {
    const harness = previousLife();

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      // `streaming` es del hub por defecto: NO dice si hay una ejecución keyed.
      fetchImpl: async () => statusResponse(undefined),
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 0, unresolved: 1, deferred: 0 });
    assert.equal(harness.liveTurns.listLiveTurns().length, 1, "sin evidencia no se libera nada");
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), true);
    assert.ok(harness.logs.some((line) => line.includes("UNRESOLVED")));
  });

  it("(7) el titular de la gate es la sessionKey: una fila sin sesión no se confirma por parecido", async () => {
    const harness = previousLife({ sessionKey: null });

    const result = await reconcileLiveTurns({
      liveTurns: harness.liveTurns,
      supervisor: fakeSupervisor({ state: "running", port: 4100 }),
      // Con la fila sin `session_key` no hay identidad que comparar contra `default`
      // ni contra ninguna clave: se conserva (el siguiente arranque reconcilia).
      fetchImpl: async () => statusResponse({ busy: true, holder: "default" }),
      apiToken: "service-token",
      now: () => 5000,
      log: (line) => harness.logs.push(line),
    });

    assert.deepEqual(result, { confirmed: 0, orphaned: 0, unresolved: 1, deferred: 0 });
    assert.equal(harness.liveTurns.listLiveTurns().length, 1);
    assert.equal(harness.turns.hasLiveTurnForAgent("agent"), true);
  });
});

describe("abort de un turno que sobrevivió al reinicio (T4-D/2)", () => {
  async function setupDataDir(): Promise<string> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-turn-reconcile-"));
    dataDirs.push(dataDir);
    await scaffoldGlobalDirs(dataDir);
    await scaffoldAgentDirs(dataDir, "agent");
    await writeAgent(dataDir, {
      name: "agent",
      port: 4100,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    return dataDir;
  }

  function supervisor() {
    return {
      state: () => ({ state: "running", pid: 42 }),
      statusOf: async () => ({ state: "running", port: 4100, pid: 42 }),
    };
  }

  it("(8a) la ruta responde 409 TURN_UNREACHABLE con su mensaje, no un 500", async () => {
    const dataDir = await setupDataDir();
    const turns = new DistTurnExecution({ apiToken: "service-token" });
    turns.loadUnverified([{ agentName: "agent", turnId: "turn-1", startedAt: 1000 }]);

    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" } as never,
      supervisor() as never,
      undefined as never,
      undefined as never,
      turns as never,
    );

    const response = await app.request(
      "http://pihub.test/agents/agent/turns/turn-1/abort",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );

    assert.equal(response.status, 409, "el Agent sigue ocupado: no es un turno inexistente");
    const body = (await response.json()) as {
      code: string;
      message: string;
      correlationId: string;
    };
    assert.equal(body.code, "TURN_UNREACHABLE");
    assert.match(body.message, /Manager restart/i, "el mensaje dice POR QUÉ no se puede abortar");
    assert.equal(typeof body.correlationId, "string", "el envelope se conserva");
  });

  it("(8b) un turno inexistente sigue siendo TURN_NOT_FOUND (PRESERVE)", async () => {
    const dataDir = await setupDataDir();
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" } as never,
      supervisor() as never,
      undefined as never,
      undefined as never,
      new DistTurnExecution({ apiToken: "service-token" }) as never,
    );

    const response = await app.request(
      "http://pihub.test/agents/agent/turns/turn-fantasma/abort",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "TURN_NOT_FOUND");
  });
});
