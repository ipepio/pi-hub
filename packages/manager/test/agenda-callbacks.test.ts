// Fase 2.3 — CallbackRepository.deliver (T5, §6 del plan de Fase 2).
//
// Verifica en `:memory:` (patrón de `storage.test.ts:297`):
//   - T5 crea la Initiative Callback (origin='callback', queued, reusa
//     session_key/intent/chain de `parent`), inserta la fila `callbacks` y
//     reactiva el `parent` — las tres en la misma transacción (invariante 5);
//   - la reactivación lleva el `parent` a `queued`, no a `running` (§12.1);
//   - atomicidad (fila T5): si el COMMIT falla a mitad, ROLLBACK — no queda
//     Callback sin su Initiative ni `parent` reactivado sin sus filas;
//   - invariantes multi-fila: CALLBACK_PARENT_MISMATCH (M5), CALLBACK_PARENT_TERMINAL,
//     CALLBACK_ALREADY_PENDING (un-delegado-a-la-vez, índice `callbacks_by_parent`),
//     INITIATIVE_NOT_FOUND.
//
// Las filas de fixture se siembran por SQL directo; el comportamiento bajo
// prueba se cruza por la interfaz del repositorio, nunca por `db` (§10).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { InitiativeRepository } from "../src/agenda/initiatives.ts";
import { CallbackRepository } from "../src/agenda/callbacks.ts";
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
  agent_name?: string;
  state?: InitiativeState;
  origin?: "trigger" | "callback" | "human";
  intent?: string;
  mode?: "solo" | "ask";
  session_key?: string;
  available_at?: number;
  chain_depth?: number;
  chain_deadline_at?: number | null;
  visible_effects_declared?: number;
  summary?: string | null;
  failure_reason?: string | null;
  result?: string | null;
  finished_at?: number | null;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, init: InsertInit): void {
  const row = {
    id: init.id,
    agent_name: init.agent_name ?? "alice",
    state: init.state ?? "queued",
    origin: init.origin ?? "human",
    trigger_id: null,
    intent: init.intent ?? "di hola",
    mode: init.mode ?? "solo",
    session_key: init.session_key ?? "sk-1",
    available_at: init.available_at ?? 1,
    bound_model: null,
    turn_id: null,
    chain_depth: init.chain_depth ?? 0,
    chain_deadline_at: init.chain_deadline_at ?? null,
    visible_effects_declared: init.visible_effects_declared ?? 0,
    summary: init.summary ?? null,
    ask_correlation: null,
    failure_reason: init.failure_reason ?? null,
    result: init.result ?? null,
    created_at: 1000,
    state_changed_at: 1000,
    started_at: null,
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

/** `parent` típico `waiting_agent` que delega y espera su Callback. */
function insertWaitingParent(db: SqliteDb, id: string): void {
  insertInitiative(db, {
    id,
    state: "waiting_agent",
    intent: "continúa el encargo",
    mode: "solo",
    session_key: "sk-parent",
    chain_depth: 2,
    chain_deadline_at: 9000,
    visible_effects_declared: 1,
  });
}

interface CallbackRow {
  id: string;
  parent_id: string;
  result: string;
  created_at: number;
}

function getCallback(db: SqliteDb, id: string): CallbackRow | undefined {
  return db
    .prepare("SELECT id, parent_id, result, created_at FROM callbacks WHERE id = ?")
    .get(id) as CallbackRow | undefined;
}

function countCallbacks(db: SqliteDb, parentId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM callbacks WHERE parent_id = ?")
    .get(parentId) as { n: number };
  return row.n;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("callbacks.ts — deliver (T5, §6)", () => {
  it("T5: Initiative Callback + fila callbacks + reactivación del parent en la misma tx", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertWaitingParent(db, "parent");

    const cb = repo.deliver("alice", "parent", "resultado del delegado", 5000);

    // La Initiative Callback (especialización 1:1, invariante 5).
    assert.equal(cb.state, "queued");
    assert.equal(cb.origin, "callback");
    assert.equal(cb.triggerId, null);
    assert.equal(cb.agentName, "alice");
    // §1.3: reusa la sesión aislada del parent y su continuación.
    assert.equal(cb.sessionKey, "sk-parent");
    assert.equal(cb.intent, "continúa el encargo");
    assert.equal(cb.mode, "solo");
    // Invariante 6: hereda profundidad y deadline de la cadena del parent.
    assert.equal(cb.chainDepth, 3); // parent + 1
    assert.equal(cb.chainDeadlineAt, 9000);
    assert.equal(cb.visibleEffectsDeclared, true);
    assert.equal(cb.availableAt, 5000);
    assert.equal(cb.finishedAt, null);

    // La fila `callbacks` con la misma identidad que la Initiative Callback.
    const row = getCallback(db, cb.id);
    assert.ok(row !== undefined);
    assert.equal(row.parent_id, "parent");
    assert.equal(row.result, "resultado del delegado");
    assert.equal(row.created_at, 5000);

    // La reactivación del parent: waiting_agent → queued (§12.1), no running.
    const parent = new InitiativeRepository(db).get("parent");
    assert.equal(parent.state, "queued");
    assert.equal(parent.availableAt, 5000);
    assert.equal(parent.stateChangedAt, 5000);
    assert.equal(parent.sessionKey, "sk-parent"); // conserva su sesión
  });

  it("reactiva el parent a queued, nunca a running (§12.1)", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertWaitingParent(db, "parent-2");
    repo.deliver("alice", "parent-2", "r", 5000);
    assert.equal(new InitiativeRepository(db).get("parent-2").state, "queued");
  });

  it("atomicidad T5: si el COMMIT falla a mitad, ROLLBACK — ni Callback ni fila ni reactivación", () => {
    const db = openMemoryDb();
    insertWaitingParent(db, "parent-atom");

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
    const repo = new CallbackRepository(flaky, new InitiativeRepository(flaky));

    assert.throws(() => repo.deliver("alice", "parent-atom", "r", 5000));
    assert.equal(commitTried, true);

    // Muerte antes del COMMIT (fila T5): no queda Callback sin su Initiative,
    // ni fila `callbacks` sin las otras dos, ni `parent` reactivado a medias.
    const initiatives = new InitiativeRepository(db);
    assert.equal(countCallbacks(db, "parent-atom"), 0);
    assert.equal(initiatives.get("parent-atom").state, "waiting_agent");
    assert.equal(initiatives.get("parent-atom").stateChangedAt, 1000);
  });

  it("tras un ROLLBACK el parent sigue waiting_agent y una entrega posterior funciona", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertWaitingParent(db, "parent-re");

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
    const failing = new CallbackRepository(flaky, new InitiativeRepository(flaky));
    assert.throws(() => failing.deliver("alice", "parent-re", "r", 5000));

    const cb = repo.deliver("alice", "parent-re", "r", 6000);
    assert.equal(cb.origin, "callback");
    assert.equal(new InitiativeRepository(db).get("parent-re").state, "queued");
  });

  it("INITIATIVE_NOT_FOUND si el parent no existe", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    assert.throws(() => repo.deliver("alice", "no-existe", "r", 5000), isDomainError("INITIATIVE_NOT_FOUND"));
  });

  it("CALLBACK_PARENT_MISMATCH si el parent no es del mismo Agent (M5)", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertInitiative(db, { id: "parent-bob", agent_name: "bob", state: "waiting_agent" });
    assert.throws(
      () => repo.deliver("alice", "parent-bob", "r", 5000),
      isDomainError("CALLBACK_PARENT_MISMATCH"),
    );
    // Nada cambió: el parent sigue waiting_agent y no hay filas callbacks.
    assert.equal(new InitiativeRepository(db).get("parent-bob").state, "waiting_agent");
    assert.equal(countCallbacks(db, "parent-bob"), 0);
  });

  it("CALLBACK_PARENT_TERMINAL si el parent está terminal", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertInitiative(db, { id: "parent-done", state: "succeeded", finished_at: 2000, result: "r" });
    assert.throws(
      () => repo.deliver("alice", "parent-done", "r", 5000),
      isDomainError("CALLBACK_PARENT_TERMINAL"),
    );
    assert.equal(countCallbacks(db, "parent-done"), 0);
  });

  it("CALLBACK_ALREADY_PENDING: un-delegado-a-la-vez — segundo deliver sobre el mismo parent", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    insertWaitingParent(db, "parent-uno");

    const first = repo.deliver("alice", "parent-uno", "primero", 5000);
    assert.ok(first);

    // El modelo v1 es un delegado a la vez (§1.3): el parent ya fue
    // reactivado (está queued) y ya tiene su Callback entregado.
    assert.throws(
      () => repo.deliver("alice", "parent-uno", "segundo", 6000),
      isDomainError("CALLBACK_ALREADY_PENDING"),
    );
    assert.equal(countCallbacks(db, "parent-uno"), 1);
    assert.equal(new InitiativeRepository(db).get("parent-uno").state, "queued");
  });

  it("CALLBACK_ALREADY_PENDING si ya existe una fila callbacks (índice callbacks_by_parent)", () => {
    const db = openMemoryDb();
    const repo = new CallbackRepository(db, new InitiativeRepository(db));
    // Fixture: un parent waiting_agent con una fila callbacks ya insertada
    // (el parent sigue esperando — pendencia duplicada imposible por el repo).
    insertWaitingParent(db, "parent-dual");
    insertInitiative(db, { id: "cb-existente", origin: "callback", session_key: "sk-parent", chain_depth: 3, chain_deadline_at: 9000, visible_effects_declared: 1 });
    db.prepare("INSERT INTO callbacks (id, parent_id, result, created_at) VALUES (?,?,?,?)")
      .run("cb-existente", "parent-dual", "ya hay uno", 4000);

    assert.throws(
      () => repo.deliver("alice", "parent-dual", "otro", 5000),
      isDomainError("CALLBACK_ALREADY_PENDING"),
    );
    assert.equal(countCallbacks(db, "parent-dual"), 1);
    assert.equal(new InitiativeRepository(db).get("parent-dual").state, "waiting_agent");
  });
});
