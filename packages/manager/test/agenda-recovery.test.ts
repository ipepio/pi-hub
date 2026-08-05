// Fase 2.2 — recuperación al arranque (ADR 0007, §7 del plan de Fase 2) sin
// levantar el Manager.
//
// Sin `serve`, sin Supervisor, sin Providers ni HTTP: se abre un `SqliteDb` en
// `:memory:`, se corren las migraciones, se siembran Initiatives `running` y se
// invoca `recoverRunningOnStartup` directamente sobre el repositorio — el seam
// del §3 que la Fase 2.4 insertará en `index.ts` entre `provisionAgents` y
// `new Supervisor`.
//
// Cubre: running→failed con `startup_recovery` (ADR 0007, §7.2 paso 1), el
// barrido de `chain_deadline_at` en el mismo COMMIT (§7.2 paso 2), arranque
// limpio (changes=0, §7.3), idempotencia (segunda llamada no reescribe fechas,
// §10.3 paso 7) y el fallo (ROLLBACK + `STARTUP_RECOVERY_FAILED` — el Manager
// abortaría, §7.4).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { DomainError } from "../src/agenda/errors.ts";
import type { InitiativeState } from "../src/agenda/state.ts";

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

interface InsertInit {
  id: string;
  state?: InitiativeState;
  bound_model?: string | null;
  turn_id?: string | null;
  started_at?: number | null;
  chain_deadline_at?: number | null;
  summary?: string | null;
  result?: string | null;
  failure_reason?: string | null;
  state_changed_at?: number;
  finished_at?: number | null;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, init: InsertInit): void {
  const row = {
    id: init.id,
    agent_name: "alice",
    state: init.state ?? "queued",
    origin: "human",
    trigger_id: null,
    intent: "di hola",
    mode: "solo",
    session_key: "sk-1",
    available_at: 1,
    bound_model: init.bound_model ?? null,
    turn_id: init.turn_id ?? null,
    chain_depth: 0,
    chain_deadline_at: init.chain_deadline_at ?? null,
    visible_effects_declared: 0,
    summary: init.summary ?? null,
    ask_correlation: null,
    failure_reason: init.failure_reason ?? null,
    result: init.result ?? null,
    created_at: 1000,
    state_changed_at: init.state_changed_at ?? 1000,
    started_at: init.started_at ?? null,
    finished_at: init.finished_at ?? null,
  };
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.agent_name, row.state, row.origin, row.trigger_id, row.intent,
    row.mode, row.session_key, row.available_at, row.bound_model, row.turn_id,
    row.chain_depth, row.chain_deadline_at, row.visible_effects_declared,
    row.summary, row.ask_correlation, row.failure_reason, row.result,
    row.created_at, row.state_changed_at, row.started_at, row.finished_at,
  );
}

interface Row {
  id: string;
  state: string;
  failure_reason: string | null;
  finished_at: number | null;
  state_changed_at: number;
  started_at: number | null;
  turn_id: string | null;
  bound_model: string | null;
  result: string | null;
  summary: string | null;
}

function getRow(db: SqliteDb, id: string): Row {
  return db
    .prepare(
      `SELECT id, state, failure_reason, finished_at, state_changed_at, started_at,
              turn_id, bound_model, result, summary
         FROM initiatives WHERE id = ?`,
    )
    .get(id) as Row;
}

describe("recovery.ts — recuperación al arranque (ADR 0007, §7)", () => {
  it("running durable → failed con failure_reason='startup_recovery' (§7.2 paso 1)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertInitiative(db, { id: "r1", state: "running", bound_model: "m", turn_id: "t1", started_at: 1000 });
    insertInitiative(db, { id: "r2", state: "running", bound_model: "m", turn_id: "t2", started_at: 1000 });

    const result = repo.recoverRunningOnStartup(5000);
    assert.deepEqual([...result.runningRecovered].sort(), ["r1", "r2"]);
    assert.equal(result.deadlineExpired, 0);

    const row = getRow(db, "r1");
    assert.equal(row.state, "failed");
    assert.equal(row.failure_reason, "startup_recovery");
    assert.equal(row.finished_at, 5000);
    assert.equal(row.state_changed_at, 5000);
    // ADR 0007 conserva summary/started_at/turn_id/bound_model; result queda NULL.
    assert.equal(row.started_at, 1000);
    assert.equal(row.turn_id, "t1");
    assert.equal(row.bound_model, "m");
    assert.equal(row.result, null);
  });

  it("el mismo COMMIT falla también los no terminales con chain_deadline_at vencido (§7.2 paso 2)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertInitiative(db, { id: "wh-due", state: "waiting_human", summary: "s", chain_deadline_at: 100 });
    insertInitiative(db, { id: "wa-due", state: "waiting_agent", chain_deadline_at: 100 });
    insertInitiative(db, { id: "q-future", state: "queued", chain_deadline_at: 9999 });
    insertInitiative(db, { id: "s-term", state: "succeeded", chain_deadline_at: 50, finished_at: 60, failure_reason: null });

    const result = repo.recoverRunningOnStartup(500);
    assert.equal(result.runningRecovered.length, 0);
    assert.equal(result.deadlineExpired, 2);

    assert.equal(getRow(db, "wh-due").state, "failed");
    assert.equal(getRow(db, "wh-due").failure_reason, "chain_deadline_exceeded");
    assert.equal(getRow(db, "wa-due").state, "failed");
    assert.equal(getRow(db, "wa-due").failure_reason, "chain_deadline_exceeded");
    assert.equal(getRow(db, "q-future").state, "queued");
    assert.equal(getRow(db, "s-term").state, "succeeded"); // terminal: fuera de la red de seguridad
  });

  it("arranque limpio: cambios=0, sin excepción y sin reescribir fechas (§7.3)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertInitiative(db, { id: "q", state: "queued", state_changed_at: 1000 });
    insertInitiative(db, { id: "s", state: "succeeded", finished_at: 2000, state_changed_at: 2000, result: "r" });

    const result = repo.recoverRunningOnStartup(5000);
    assert.equal(result.runningRecovered.length, 0);
    assert.equal(result.deadlineExpired, 0);

    assert.equal(getRow(db, "q").state, "queued");
    assert.equal(getRow(db, "q").state_changed_at, 1000);
    assert.equal(getRow(db, "s").state, "succeeded");
    assert.equal(getRow(db, "s").finished_at, 2000);
  });

  it("idempotente: una segunda llamada no reescribe fechas (§10.3 paso 7)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertInitiative(db, { id: "r1", state: "running", bound_model: "m", turn_id: "t1", started_at: 1000 });

    const first = repo.recoverRunningOnStartup(5000);
    assert.equal(first.runningRecovered.length, 1);
    assert.equal(first.deadlineExpired, 0);

    const second = repo.recoverRunningOnStartup(6000);
    assert.equal(second.runningRecovered.length, 0);
    assert.equal(second.deadlineExpired, 0);

    const row = getRow(db, "r1");
    assert.equal(row.state, "failed");
    assert.equal(row.finished_at, 5000); // no se reescribe a 6000
    assert.equal(row.state_changed_at, 5000);
  });

  it("si la transacción falla: ROLLBACK, las filas siguen running y se propaga STARTUP_RECOVERY_FAILED (§7.4)", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "r1", state: "running", bound_model: "m", turn_id: "t1", started_at: 1000 });

    // Driver que falla al confirmar: simula un COMMIT imposible (I/O, disco
    // corrupto, busy_timeout agotado). El repo hace ROLLBACK y reenvuelve como
    // STARTUP_RECOVERY_FAILED — el Manager abortaría sin publicar HTTP y
    // systemd reintentaría (§7.4).
    let commitTried = false;
    const flaky: SqliteDb = {
      exec: (sql) => {
        if (sql === "COMMIT") {
          commitTried = true;
          throw new Error("COMMIT simulado falla");
        }
        db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
    };

    const repo = new AgendaRepository(flaky);
    assert.throws(
      () => repo.recoverRunningOnStartup(5000),
      (err: unknown) => err instanceof DomainError && err.code === "STARTUP_RECOVERY_FAILED",
    );
    assert.equal(commitTried, true);

    // El ROLLBACK deja el disco tal cual: o todas las running pasan a failed o
    // ninguna (atomicidad, §7.4).
    const row = getRow(db, "r1");
    assert.equal(row.state, "running");
    assert.equal(row.failure_reason, null);
    assert.equal(row.finished_at, null);
    assert.equal(row.state_changed_at, 1000);
  });
});
