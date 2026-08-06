// Fase 3.5 — `AgendaLoop`, el dispatcher central
// (`docs/design-autonomia-loop-schedule.md` §2, §4, §5, §6, §9.5).
//
// Criterio verificable de esta sub-fase: la matriz de tests del §7.2 con fakes
// (reloj manual, `TurnExecution` fake, `Supervisor` fake) y SQLite `:memory:`,
// sin esperar tiempo real (§7.1). Se prueba la interfaz real `start/stop`
// con el adaptador temporal reemplazado; no se expone ningún `tick()` público.
//
// El `TurnExecution` fake resuelve `TurnHandle` diferidos — el test decide
// cuándo y con qué terminal — y, como el real (§4.4), escribe `turns.complete`
// con su causa del catálogo antes de resolver `completion`. Así el terminal
// cierra la Initiative por T6 y el `tick` siguiente libera el slot.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { AgendaLoop, type AgendaLoopOptions, type LoopAgenda, type LoopSupervisor, type LoopTurnExecution } from "../src/agenda/loop.ts";
import type { Initiative } from "../src/agenda/initiatives.ts";
import type { FailureCause, TurnFinalState } from "../src/agenda/turns.ts";
import type { StartTurnCommand, TimerHandle, TurnHandle } from "../src/agenda/turn-execution.ts";
import type { TurnSseEvent } from "../src/api-v1/turns.ts";

const HOUR_MS = 3_600_000;
/** definition_json de fixture: el schedule de intervalo que v1 dispara (pendiente 1). */
const INTERVAL_DEFINITION = JSON.stringify({ version: 1, kind: "interval", intervalMs: HOUR_MS });

const openDbs: SqliteDb[] = [];

/** Fixture de `:memory:` con el esquema aplicado (patrón `storage.test.ts:297`). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Deja correr las microtareas pendientes (completion.then → wakeup). No duerme. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Reloj manual + scheduler (plan §7.1): `now()` y `schedule`/`cancel` compartan
 * el mismo reloj; `advance(ms)` corre los callbacks cuyo plazo ya venció (y los
 * que se programen a mitad con plazo ya vencido, como el wakeup a `+0`). El
 * test nunca duerme. El handle es un número opaco tipado como `TimerHandle`.
 */
class ManualClock {
  private elapsed: number;
  private nextId = 0;
  private readonly pending = new Map<number, { callback: () => void; deadline: number }>();

  constructor(startAt = 0) {
    this.elapsed = startAt;
  }

  readonly now = (): number => this.elapsed;

  readonly schedule = (callback: () => void, ms: number): TimerHandle => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, deadline: this.elapsed + ms });
    return id as unknown as TimerHandle;
  };

  readonly cancel = (handle: TimerHandle): void => {
    this.pending.delete(Number(handle));
  };

  advance(ms: number): void {
    this.elapsed += ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, task]) => task.deadline <= this.elapsed)
        .sort((a, b) => a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, task] of due) {
        this.pending.delete(id);
        task.callback();
      }
    }
  }
}

/** `final_state` de T6 a partir del evento terminal (§4.4, `turns.ts`). */
function finalStateOf(event: TurnSseEvent["event"]): TurnFinalState | undefined {
  switch (event) {
    case "turn-complete":
      return "succeeded";
    case "turn-aborted":
      return "cancelled";
    case "turn-error":
      return "failed";
    default:
      return undefined;
  }
}

function turnError(turnId: string, cause: FailureCause): TurnSseEvent {
  return {
    event: "turn-error",
    data: {
      turnId,
      code: cause === "turn_failed" ? "INTERNAL_ERROR" : "RESOURCE_UNAVAILABLE",
      message: cause === "turn_failed" ? "Runner error" : "Runner unavailable",
    },
  };
}

interface PendingTurn {
  readonly command: StartTurnCommand;
  readonly completion: Promise<TurnSseEvent>;
  readonly resolveCompletion: (terminal: TurnSseEvent) => void;
  resolved: boolean;
  aborted: boolean;
  timeoutHandle?: TimerHandle;
}

/**
 * Fake de `TurnExecution` (plan §7.1): `startTurn` devuelve `TurnHandle`
 * diferidos; el test decide cuándo y con qué terminal resuelven. Como el real,
 * antes de resolver `completion` escribe `turns.complete` con su causa (§4.4),
 * de modo que el terminal cierra la Initiative por T6. Opcionalmente `startTurn`
 * lanza (`throwOnStart`, para el caso `dispatch_failed` de §5.2) o aplica un
 * watchdog de despacho (`dispatchTimeoutMs`, §4.6) con el scheduler inyectado.
 */
class FakeTurnExecution implements LoopTurnExecution {
  readonly started: StartTurnCommand[] = [];
  readonly pending: PendingTurn[] = [];
  readonly aborted: Array<{ agentName: string; turnId: string }> = [];
  private readonly deps: {
    repo: LoopAgenda["turns"];
    now: () => number;
    schedule: (cb: () => void, ms: number) => TimerHandle;
    cancel: (handle: TimerHandle) => void;
    throwOnStart?: boolean;
    dispatchTimeoutMs?: number;
  };

  constructor(deps: {
    repo: LoopAgenda["turns"];
    now: () => number;
    schedule: (cb: () => void, ms: number) => TimerHandle;
    cancel: (handle: TimerHandle) => void;
    throwOnStart?: boolean;
    dispatchTimeoutMs?: number;
  }) {
    this.deps = deps;
  }

  startTurn(command: StartTurnCommand): TurnHandle {
    if (this.deps.throwOnStart) throw new Error("startTurn simulado lanza (§5.2 dispatch_failed)");
    let resolveCompletion!: (terminal: TurnSseEvent) => void;
    const completion = new Promise<TurnSseEvent>((resolve) => {
      resolveCompletion = resolve;
    });
    const pending: PendingTurn = {
      command,
      completion,
      resolveCompletion,
      resolved: false,
      aborted: false,
    };
    this.pending.push(pending);
    this.started.push(command);
    const timeoutMs = this.deps.dispatchTimeoutMs ?? 0;
    if (timeoutMs > 0) {
      pending.timeoutHandle = this.deps.schedule(() => {
        this.resolve(pending, turnError(command.turnId, "runner_unavailable"), "runner_unavailable");
      }, timeoutMs);
    }
    return {
      completion,
      disconnect: () => this.resolve(pending, turnError(command.turnId, "runner_unavailable"), "runner_unavailable"),
    };
  }

  abort(agentName: string, turnId: string): boolean {
    const pending = this.pending.find((p) => !p.resolved && p.command.agentName === agentName && p.command.turnId === turnId);
    if (!pending) return false;
    pending.aborted = true;
    this.aborted.push({ agentName, turnId });
    return true;
  }

  resolve(pending: PendingTurn, terminal: TurnSseEvent, cause?: FailureCause): void {
    if (pending.resolved) return;
    pending.resolved = true;
    if (pending.timeoutHandle !== undefined) this.deps.cancel(pending.timeoutHandle);
    const finalState = finalStateOf(terminal.event);
    if (finalState) {
      try {
        this.deps.repo.complete(
          pending.command.agentName,
          pending.command.turnId,
          finalState,
          null,
          this.deps.now(),
          cause,
        );
      } catch {
        // TURN_NOT_FOUND / TURN_ALREADY_TERMINAL: el terminal ya se entregó.
      }
    }
    pending.resolveCompletion(terminal);
  }

  resolveFor(agentName: string, turnId: string, terminal: TurnSseEvent, cause?: FailureCause): void {
    const pending = this.pending.find((p) => !p.resolved && p.command.agentName === agentName && p.command.turnId === turnId);
    assert.ok(pending, `turno (${agentName}, ${turnId}) no está pendiente`);
    this.resolve(pending, terminal, cause);
  }
}

/** Fake de `Supervisor` (plan §7.1): `state` y `runnerPortOf` configurables. */
class FakeSupervisor implements LoopSupervisor {
  private readonly states = new Map<string, { state: "running" | "stopped" | "errored"; port?: number }>();

  set(name: string, state: "running" | "stopped" | "errored", port?: number): void {
    this.states.set(name, { state, port });
  }

  state(name: string): { state: "running" | "stopped" | "errored" } {
    return { state: this.states.get(name)?.state ?? "stopped" };
  }

  runnerPortOf(name: string): number | undefined {
    const managed = this.states.get(name);
    return managed?.state === "running" ? managed.port : undefined;
  }
}

/** Comando de turno humano (simula la ruta HTTP), para "humano paralelo". */
function humanCommand(agentName: string, turnId: string): StartTurnCommand {
  return {
    agentName,
    turnId,
    idempotencyKey: `idem-human-${turnId}`,
    correlationId: `corr-human-${turnId}`,
    sessionKey: `session-human-${turnId}`,
    message: "pregunta del humano",
    runnerPort: 1,
    eventProfile: "basic",
    origin: { kind: "human" },
  };
}

interface InsertInit {
  id: string;
  agent_name?: string;
  state?: "queued" | "running" | "waiting_human";
  available_at?: number;
  turn_id?: string | null;
  summary?: string | null;
  state_changed_at?: number;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, init: InsertInit): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    init.id, init.agent_name ?? "alice", init.state ?? "queued", "human", null,
    "di hola", "solo", "sk-1", init.available_at ?? 0, null, init.turn_id ?? null,
    0, null, 0, init.summary ?? null, null, null, null, 1000, init.state_changed_at ?? 1000, 1000, null,
  );
}

interface InsertTrigger {
  id: string;
  agent_name?: string;
  next_fire_at?: number;
}

/** Siembra una fila `triggers` `schedule` de intervalo (setup de fixture). */
function insertTrigger(db: SqliteDb, init: InsertTrigger): void {
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at, last_fired_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    init.id, init.agent_name ?? "alice", "schedule", INTERVAL_DEFINITION, "di hola",
    "solo", null, "owner", "owner", null, 1,
    init.next_fire_at ?? 100, null, 1000, 1000,
  );
}

function getNextFireAt(db: SqliteDb, id: string): number | null {
  const row = db.prepare("SELECT next_fire_at FROM triggers WHERE id = ?").get(id) as {
    next_fire_at: number | null;
  };
  return row.next_fire_at;
}

function countInitiatives(db: SqliteDb, triggerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM initiatives WHERE origin = 'trigger' AND trigger_id = ?")
    .get(triggerId) as { n: number };
  return row.n;
}

/** Compone el Loop con los fakes y el `agenda` dado (repo real o spy). */
function makeLoop(
  agenda: LoopAgenda,
  clock: ManualClock,
  fakeOptions: { throwOnStart?: boolean; dispatchTimeoutMs?: number } = {},
  loopOptions: Partial<AgendaLoopOptions> = {},
): { loop: AgendaLoop; fake: FakeTurnExecution; supervisor: FakeSupervisor } {
  const fake = new FakeTurnExecution({
    repo: agenda.turns,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    throwOnStart: fakeOptions.throwOnStart,
    dispatchTimeoutMs: fakeOptions.dispatchTimeoutMs,
  });
  const supervisor = new FakeSupervisor();
  const loop = new AgendaLoop(agenda, supervisor, fake, {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    tickIntervalMs: 1000,
    ...loopOptions,
  });
  return { loop, fake, supervisor };
}

describe("loop.ts — AgendaLoop, el dispatcher central (Fase 3.5, §7.2)", () => {
  it("tick básico: una queued due → un claim, un startTurn, running; ningún segundo startTurn al avanzar", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "ini-1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000); // primer tick

    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0].agentName, "alice");
    const ini = repo.initiatives.get("ini-1");
    assert.equal(ini.state, "running");
    assert.ok(ini.turnId !== null);

    // Varios ticks más: la Initiative sigue running y el dial está lleno.
    clock.advance(1000);
    clock.advance(1000);
    clock.advance(1000);
    assert.equal(fake.started.length, 1);
  });

  it("no due: available_at > now → cero claims hasta cruzar la fecha", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "ini-1", agent_name: "alice", available_at: 5000 });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000); // t=1000: available_at 5000 no ha vencido
    assert.equal(fake.started.length, 0);
    assert.equal(repo.initiatives.get("ini-1").state, "queued");

    clock.advance(5000); // t=6000: cruza la fecha; el tick la despacha
    assert.equal(fake.started.length, 1);
    assert.equal(repo.initiatives.get("ini-1").state, "running");
  });

  it("dial default 1: A1 y B1 due → solo una empieza; al resolverla empieza la otra", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice", available_at: 0 });
    insertInitiative(db, { id: "B1", agent_name: "bob", available_at: 1 });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0].agentName, "alice"); // FIFO (available_at, id)

    fake.resolveFor("alice", fake.started[0].turnId, {
      event: "turn-complete",
      data: { turnId: fake.started[0].turnId },
    });
    await flush();
    clock.advance(0); // wakeup: no espera tickIntervalMs
    assert.equal(fake.started.length, 2);
    assert.equal(fake.started[1].agentName, "bob");
  });

  it("dial 2: A1 y B1 arrancan; nunca A1+A2; B1 libera C1 y A1 libera A2", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, {}, { dispatchConcurrency: 2 });
    insertInitiative(db, { id: "A1", agent_name: "alice", available_at: 0 });
    insertInitiative(db, { id: "A2", agent_name: "alice", available_at: 1 });
    insertInitiative(db, { id: "B1", agent_name: "bob", available_at: 2 });
    insertInitiative(db, { id: "C1", agent_name: "carol", available_at: 3 });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);
    supervisor.set("carol", "running", 4102);

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started.length, 2);
    const aliceStarts = fake.started.filter((s) => s.agentName === "alice");
    assert.equal(aliceStarts.length, 1); // nunca A1 y A2 a la vez (ADR 0004)
    assert.ok(fake.started.some((s) => s.agentName === "bob"));

    const a1 = aliceStarts[0];
    const b1 = fake.started.find((s) => s.agentName === "bob")!;

    // Libera B1 → wakeup → arranca C1 (A2 sigue excluida: A1 en vuelo).
    fake.resolveFor("bob", b1.turnId, { event: "turn-complete", data: { turnId: b1.turnId } });
    await flush();
    clock.advance(0);
    assert.ok(fake.started.some((s) => s.agentName === "carol"));
    assert.equal(repo.initiatives.get("A2").state, "queued");

    // Libera A1 → wakeup → ahora sí arranca A2.
    fake.resolveFor("alice", a1.turnId, { event: "turn-complete", data: { turnId: a1.turnId } });
    await flush();
    clock.advance(0);
    assert.equal(repo.initiatives.get("A2").state, "running");
  });

  it("exclusión por Agent con hueco global: dial 3, una running de A + queued de A + queued de B → despacha B, no la segunda de A", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, {}, { dispatchConcurrency: 3 });
    insertInitiative(db, { id: "A-running", agent_name: "alice", state: "running", turn_id: "t-run" });
    insertInitiative(db, { id: "A2", agent_name: "alice" });
    insertInitiative(db, { id: "B1", agent_name: "bob" });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);

    loop.start();
    clock.advance(1000);

    // El dial global tiene hueco (capacidad 2), pero la exclusión por Agent
    // impide la segunda de A: solo B arranca.
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0].agentName, "bob");
    assert.equal(repo.initiatives.get("A2").state, "queued");
  });

  it("humano paralelo: un turno humano de A no reduce capacidad; la Initiative de A puede empezar", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    // Turno humano de alice ya en curso (la ruta HTTP lo abrió en la misma
    // instancia compartida): el dial solo cuenta Initiatives (`listRunning`).
    fake.startTurn(humanCommand("alice", "turn-human"));

    loop.start();
    clock.advance(1000);

    assert.equal(fake.started.length, 2); // el humano + la Initiative
    assert.equal(repo.initiatives.get("A1").state, "running");
  });

  it("agent stopped: la Initiative sigue queued; no hay startTurn", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "stopped", 4100);

    loop.start();
    clock.advance(1000);
    clock.advance(1000);

    assert.equal(fake.started.length, 0);
    assert.equal(repo.initiatives.get("A1").state, "queued");
  });

  it("agent arrancando: queued mientras no esté running; al pasar a running empieza sin recrearla", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "stopped", 4100); // arrancando/backoff → stopped

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started.length, 0);
    assert.equal(repo.initiatives.get("A1").state, "queued");

    supervisor.set("alice", "running", 4100); // el Supervisor la levantó
    clock.advance(1000);
    assert.equal(fake.started.length, 1);
    assert.equal(repo.initiatives.get("A1").state, "running");
  });

  it("agent errored: la Initiative pasa a failed con agent_errored, sin startTurn (D13)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "errored", 4100);

    loop.start();
    clock.advance(1000);

    assert.equal(fake.started.length, 0);
    const ini = repo.initiatives.get("A1");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "agent_errored");
  });

  it("terminales: complete/error/aborted dejan succeeded/failed/cancelled vía T6 y liberan el slot", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, {}, { dispatchConcurrency: 3 });
    insertInitiative(db, { id: "A1", agent_name: "alice", available_at: 0 });
    insertInitiative(db, { id: "B1", agent_name: "bob", available_at: 1 });
    insertInitiative(db, { id: "C1", agent_name: "carol", available_at: 2 });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);
    supervisor.set("carol", "running", 4102);

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started.length, 3);

    const a = fake.started.find((s) => s.agentName === "alice")!;
    const b = fake.started.find((s) => s.agentName === "bob")!;
    const c = fake.started.find((s) => s.agentName === "carol")!;

    fake.resolveFor("alice", a.turnId, { event: "turn-complete", data: { turnId: a.turnId } });
    fake.resolveFor("bob", b.turnId, turnError(b.turnId, "turn_failed"), "turn_failed");
    fake.resolveFor("carol", c.turnId, { event: "turn-aborted", data: { turnId: c.turnId } });
    await flush();

    assert.equal(repo.initiatives.get("A1").state, "succeeded");
    assert.equal(repo.initiatives.get("B1").state, "failed");
    assert.equal(repo.initiatives.get("B1").failureReason, "turn_failed");
    assert.equal(repo.initiatives.get("C1").state, "cancelled");
    // Libera el slot exactamente una vez: no queda ninguna running.
    assert.deepEqual(repo.initiatives.listRunning().map((i) => i.id), []);
  });

  it("close sin terminal: completion por close → failed con runner_unavailable (D14)", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000);
    const a = fake.started[0];

    // El Runner cerró sin terminal ni abort: `TurnExecution` emite turn-error
    // con `runner_unavailable`; el fake lo resuelve igual que el real.
    fake.resolveFor("alice", a.turnId, turnError(a.turnId, "runner_unavailable"), "runner_unavailable");
    await flush();

    const ini = repo.initiatives.get("A1");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "runner_unavailable");
  });

  it("timeout de despacho: sin agent_start antes de dispatchTimeoutMs → failed con runner_unavailable (D15)", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, { dispatchTimeoutMs: 500 });
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000); // el tick despacha a t=1000; watchdog a t=1500
    assert.equal(fake.started.length, 1);

    clock.advance(499); // dentro del plazo: nada
    assert.equal(repo.initiatives.get("A1").state, "running");

    clock.advance(1); // vence el watchdog
    await flush();
    const ini = repo.initiatives.get("A1");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "runner_unavailable");
  });

  it("excepción antes del claim: si el claim falla transitoriamente, la Initiative queda queued y el siguiente tick la reevalúa", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    // Spy de `claimInitiative`: falla una vez de forma transitoria (equivale,
    // en el orden claim→startTurn del Loop, a la fila "antes del claim" de
    // §5.2: la Initiative nunca llegó a `running`).
    const transient = { active: true };
    const agenda: LoopAgenda = {
      initiatives: repo.initiatives,
      triggers: repo.triggers,
      turns: repo.turns,
      claimInitiative: (command) => {
        if (transient.active) {
          transient.active = false;
          throw new Error("storage transitorio (§5.2: reevalúa en el siguiente tick)");
        }
        return repo.claimInitiative(command);
      },
    };
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(agenda, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000); // el claim falla: se descarta la fotografía
    assert.equal(fake.started.length, 0);
    assert.equal(repo.initiatives.get("A1").state, "queued");

    clock.advance(1000); // siguiente tick: reevalúa y despacha
    assert.equal(fake.started.length, 1);
    assert.equal(repo.initiatives.get("A1").state, "running");
  });

  it("excepción tras el claim: startTurn lanza → failed con dispatch_failed (la reserva no queda colgada)", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, { throwOnStart: true });
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000);

    // El claim llegó a `running`; `startTurn` lanzó; el Loop cierra con T6.
    assert.equal(fake.started.length, 0);
    const ini = repo.initiatives.get("A1");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "dispatch_failed");
    assert.ok(ini.finishedAt !== null);
  });

  it("shutdown: sin nuevos claims tras stop; sin abort antes de graceMs; abort al vencer; resuelve tras el drain", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock, {}, { graceMs: 5000, postAbortMarginMs: 1000 });
    insertInitiative(db, { id: "A1", agent_name: "alice" });
    insertInitiative(db, { id: "B1", agent_name: "bob" }); // para probar "sin nuevos claims"
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started.length, 1);
    const a = fake.started[0];

    const stopPromise = loop.stop({ graceMs: 5000 });

    // Dentro de la gracia: ni aborta ni despacha B1.
    clock.advance(4000);
    await flush();
    assert.equal(fake.aborted.length, 0);
    assert.equal(fake.started.length, 1);
    assert.equal(repo.initiatives.get("B1").state, "queued");

    // Vence la gracia: aborta el turno en vuelo; sigue sin despachar B1.
    clock.advance(1000);
    await flush();
    assert.equal(fake.aborted.length, 1);
    assert.deepEqual(fake.aborted[0], { agentName: "alice", turnId: a.turnId });
    assert.equal(fake.started.length, 1);

    // Aún sin terminal del Runner: el stop no resuelve antes del drain.
    let resolved = false;
    void stopPromise.then(() => {
      resolved = true;
    });
    clock.advance(500); // dentro del margen post-abort
    await flush();
    assert.equal(resolved, false);

    // El Runner emite turn-aborted → T6 `cancelled` → drain completo → stop.
    fake.resolveFor("alice", a.turnId, { event: "turn-aborted", data: { turnId: a.turnId } });
    await stopPromise;
    assert.equal(repo.initiatives.get("A1").state, "cancelled");
    // Nunca se escribió `failed` en shutdown; B1 sigue queued.
    assert.equal(repo.initiatives.get("B1").state, "queued");
    assert.equal(repo.initiatives.get("A1").failureReason, null);
  });

  it("wakeup al liberar slot: resolver un TurnHandle programa un tick inmediato, no espera tickIntervalMs", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice", available_at: 0 });
    insertInitiative(db, { id: "B1", agent_name: "bob", available_at: 1 });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);

    loop.start();
    clock.advance(1000); // tick a t=1000: despacha A1; el periódico iría a t=2000
    assert.equal(fake.started.length, 1);
    const a = fake.started[0];

    fake.resolveFor("alice", a.turnId, { event: "turn-complete", data: { turnId: a.turnId } });
    await flush(); // completion → wakeup → tick programado a t=1000+0

    clock.advance(0); // el tick del wakeup corre YA, sin esperar a t=2000
    assert.equal(fake.started.length, 2);
    assert.equal(fake.started[1].agentName, "bob");
  });

  it("scan no solapado: nunca hay dos lecturas activas de listRunning", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    let active = 0;
    let maxActive = 0;
    // Proxy, no spread: los métodos de `InitiativeRepository` viven en el
    // prototipo y un spread los perdería (listDue/sweeps no serían funciones).
    const initiatives = new Proxy(repo.initiatives, {
      get(target, prop, receiver) {
        if (prop === "listRunning") {
          return () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
              return target.listRunning();
            } finally {
              active -= 1;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const agenda: LoopAgenda = {
      initiatives,
      triggers: repo.triggers,
      turns: repo.turns,
      claimInitiative: (command) => repo.claimInitiative(command),
    };
    const clock = new ManualClock();
    const { loop } = makeLoop(agenda, clock);

    loop.start();
    clock.advance(1000);
    clock.advance(1000);
    clock.advance(1000);

    assert.equal(maxActive, 1);
  });

  it("el barrido T10 recibe el CORTE (now - waitingHumanExpiryMs), no `now` — una pregunta de hace 1 minuto NO caduca", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const DAY_MS = 86_400_000;
    // Entró en `waiting_human` 1 minuto antes del primer tick (t=1000).
    insertInitiative(db, {
      id: "wh-reciente",
      state: "waiting_human",
      summary: "s",
      state_changed_at: 1000 - 60_000,
    });
    const cortes: number[] = [];
    // Spy del barrido: registra el argumento que el Loop le pasa, sin tocar
    // el reloj de pared (§7.1).
    const initiatives = new Proxy(repo.initiatives, {
      get(target, prop, receiver) {
        if (prop === "sweepWaitingHumanExpiry") {
          return (cutoff: number) => {
            cortes.push(cutoff);
            return target.sweepWaitingHumanExpiry(cutoff);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const agenda: LoopAgenda = {
      initiatives,
      triggers: repo.triggers,
      turns: repo.turns,
      claimInitiative: (command) => repo.claimInitiative(command),
    };
    const clock = new ManualClock();
    const { loop } = makeLoop(agenda, clock, {}, { waitingHumanExpiryMs: 7 * DAY_MS });

    loop.start();
    clock.advance(1000); // t=1000: el tick ejecuta el barrido

    assert.equal(cortes.length, 1);
    // El Loop pasa el corte, no `now`: con `now` (=1000) la pregunta de hace
    // 1 minuto caducaría en el tick siguiente (el bug).
    assert.equal(cortes[0], 1000 - 7 * DAY_MS);
    assert.equal(repo.initiatives.get("wh-reciente").state, "waiting_human");
  });
});

describe("loop.ts — triggers schedule y round-robin (Fase 3.5, §7.3.1-3)", () => {
  it("§7.3.1 intervalo perdido: un tick dispara UNA Initiative y salta a un vencimiento futuro; otro tick sin avanzar no crea otra", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock(12 * HOUR_MS); // 12:00
    const { loop, supervisor } = makeLoop(repo, clock);
    insertTrigger(db, { id: "trg-due", next_fire_at: 8 * HOUR_MS }); // vencía a las 08:00
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000);

    assert.equal(countInitiatives(db, "trg-due"), 1);
    const next = getNextFireAt(db, "trg-due")!;
    assert.ok(next > clock.now(), "next_fire_at debe ser estrictamente futuro");
    assert.equal(next, clock.now() + HOUR_MS);

    // Otro tick sin avanzar el reloj no vuelve a disparar.
    clock.advance(1000);
    assert.equal(countInitiatives(db, "trg-due"), 1);
  });

  it("§7.3.2 varias ocurrencias perdidas: intervalo 1h y apagón 10h crea UNA, no diez", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock(8 * HOUR_MS + 10 * HOUR_MS); // 08:00 + 10h de apagón
    const { loop, supervisor } = makeLoop(repo, clock);
    insertTrigger(db, { id: "trg-blackout", next_fire_at: 8 * HOUR_MS });
    supervisor.set("alice", "running", 4100);

    loop.start();
    clock.advance(1000);

    assert.equal(countInitiatives(db, "trg-blackout"), 1);
    assert.ok(getNextFireAt(db, "trg-blackout")! > clock.now());
  });

  it("§7.3.3 round-robin: dial 1, A con dos due y B con una → B no pasa hambre; el cursor rota entre ticks", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const clock = new ManualClock();
    const { loop, fake, supervisor } = makeLoop(repo, clock);
    insertInitiative(db, { id: "A1", agent_name: "alice", available_at: 0 });
    insertInitiative(db, { id: "A2", agent_name: "alice", available_at: 1 });
    insertInitiative(db, { id: "B1", agent_name: "bob", available_at: 2 });
    supervisor.set("alice", "running", 4100);
    supervisor.set("bob", "running", 4101);

    loop.start();
    clock.advance(1000);
    assert.equal(fake.started[0].agentName, "alice");
    const a1 = fake.started[0];

    // Tras liberar A1, el cursor rota más allá de alice: B1 va antes que A2.
    fake.resolveFor("alice", a1.turnId, { event: "turn-complete", data: { turnId: a1.turnId } });
    await flush();
    clock.advance(0);
    assert.equal(fake.started.length, 2);
    assert.equal(fake.started[1].agentName, "bob");

    const b1 = fake.started[1];
    fake.resolveFor("bob", b1.turnId, { event: "turn-complete", data: { turnId: b1.turnId } });
    await flush();
    clock.advance(0);
    assert.equal(fake.started.length, 3);
    assert.equal(fake.started[2].agentName, "alice"); // A2, la última
  });
});
