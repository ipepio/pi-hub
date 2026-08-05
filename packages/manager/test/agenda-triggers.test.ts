// Fase 2.3 — TriggerRepository.fireTrigger (T1, §6 del plan de Fase 2).
//
// Verifica en `:memory:` (patrón de `storage.test.ts:297`):
//   - T1 crea la Initiative `queued` (origin='trigger', trigger_id, intent,
//     mode, session_key aislada) y avanza el Trigger (`next_fire_at`,
//     `last_fired_at`, `updated_at`) en la misma transacción;
//   - atomicidad (fila T1): si el COMMIT falla a mitad, ROLLBACK — no queda
//     Initiative huérfana ni `next_fire_at` avanzado sin su Initiative;
//   - TRIGGER_NOT_FOUND / TRIGGER_NOT_DISPARABLE (proposed, disabled,
//     `next_fire_at` NULL, kind != schedule, definition_json no planificable —
//     pendiente 1);
//   - cada disparo crea exactamente una Initiative y reprograma desde `now`
//     (resincroniza: no encola disparos atrasados; la forma del schedule es el
//     pendiente 1 y solo vive en `triggers.ts`).
//
// Las filas de fixture se siembran por SQL directo; el comportamiento bajo
// prueba se cruza por la interfaz del repositorio, nunca por `db` (§10).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { InitiativeRepository } from "../src/agenda/initiatives.ts";
import { TriggerRepository } from "../src/agenda/triggers.ts";
import { DomainError } from "../src/agenda/errors.ts";

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

/** definition_json de fixture: el schedule de intervalo que v1 dispara (pendiente 1). */
const INTERVAL_DEFINITION = JSON.stringify({ version: 1, kind: "interval", intervalMs: 5000 });

interface InsertTrigger {
  id: string;
  agent_name?: string;
  kind?: string;
  definition_json?: string;
  intent?: string;
  mode?: "solo" | "ask";
  created_by?: "owner" | "control_plane" | "agent";
  proposal_state?: "proposed" | "approved" | null;
  enabled?: number;
  next_fire_at?: number | null;
  last_fired_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

/** Siembra una fila `triggers` (setup de fixture, no comportamiento bajo prueba). */
function insertTrigger(db: SqliteDb, init: InsertTrigger): void {
  const row = {
    id: init.id,
    agent_name: init.agent_name ?? "alice",
    kind: init.kind ?? "schedule",
    definition_json: init.definition_json ?? INTERVAL_DEFINITION,
    intent: init.intent ?? "di hola",
    mode: init.mode ?? "solo",
    suggested_skill: null,
    created_by: init.created_by ?? "owner",
    authority: "owner",
    proposal_state: init.proposal_state ?? null,
    enabled: init.enabled ?? 1,
    next_fire_at: init.next_fire_at === undefined ? 100 : init.next_fire_at,
    last_fired_at: init.last_fired_at ?? null,
    created_at: init.created_at ?? 1000,
    updated_at: init.updated_at ?? 1000,
  };
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at, last_fired_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.agent_name, row.kind, row.definition_json, row.intent, row.mode,
    row.suggested_skill, row.created_by, row.authority, row.proposal_state,
    row.enabled, row.next_fire_at, row.last_fired_at, row.created_at, row.updated_at,
  );
}

interface TriggerRow {
  id: string;
  next_fire_at: number | null;
  last_fired_at: number | null;
  updated_at: number;
}

function getTrigger(db: SqliteDb, id: string): TriggerRow {
  return db
    .prepare("SELECT id, next_fire_at, last_fired_at, updated_at FROM triggers WHERE id = ?")
    .get(id) as TriggerRow;
}

function countInitiatives(db: SqliteDb, triggerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM initiatives WHERE origin = 'trigger' AND trigger_id = ?")
    .get(triggerId) as { n: number };
  return row.n;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("triggers.ts — fireTrigger (T1, §6)", () => {
  it("T1: crea la Initiative queued origin='trigger' y avanza el Trigger en la misma tx", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    insertTrigger(db, { id: "trg-1", next_fire_at: 100 });

    const ini = repo.fireTrigger("trg-1", 1000);

    // La Initiative nacida del Trigger (invariante 1 por construcción:
    // origin='trigger' con trigger_id no nulo).
    assert.equal(ini.state, "queued");
    assert.equal(ini.origin, "trigger");
    assert.equal(ini.triggerId, "trg-1");
    assert.equal(ini.agentName, "alice");
    assert.equal(ini.intent, "di hola");
    assert.equal(ini.mode, "solo");
    assert.equal(ini.availableAt, 1000); // disparado → due ahora
    assert.equal(ini.boundModel, null);
    assert.equal(ini.turnId, null);
    assert.equal(ini.chainDepth, 0);
    assert.equal(ini.chainDeadlineAt, null);
    assert.equal(ini.sessionKey.length > 0, true); // sessionKey aislada propia
    assert.equal(ini.createdAt, 1000);
    assert.equal(ini.stateChangedAt, 1000);
    assert.equal(ini.finishedAt, null);

    // El avance del Trigger: next_fire_at = now + intervalMs (pendiente 1),
    // last_fired_at = now, updated_at = now.
    const trigger = getTrigger(db, "trg-1");
    assert.equal(trigger.next_fire_at, 6000);
    assert.equal(trigger.last_fired_at, 1000);
    assert.equal(trigger.updated_at, 1000);
  });

  it("cada disparo crea exactamente una Initiative y reprograma desde now (resincroniza)", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    insertTrigger(db, { id: "trg-rep", next_fire_at: 100 });

    const first = repo.fireTrigger("trg-rep", 1000);
    const second = repo.fireTrigger("trg-rep", 2000);

    assert.equal(countInitiatives(db, "trg-rep"), 2);
    assert.notEqual(first.id, second.id);
    // No encola disparos atrasados: reprograma desde `now`, no desde el
    // `next_fire_at` viejo (el schedule es el pendiente 1).
    assert.equal(getTrigger(db, "trg-rep").next_fire_at, 7000);
  });

  it("atomicidad T1: si el COMMIT falla a mitad, ROLLBACK — ni Initiative ni avance", () => {
    const db = openMemoryDb();
    insertTrigger(db, { id: "trg-atom", next_fire_at: 100 });

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
    const repo = new TriggerRepository(flaky, new InitiativeRepository(flaky));

    assert.throws(() => repo.fireTrigger("trg-atom", 1000));
    assert.equal(commitTried, true);

    // Muerte antes del COMMIT (fila T1): el WAL hace ROLLBACK — no hay
    // Initiative huérfana ni `next_fire_at` avanzado sin su Initiative.
    assert.equal(countInitiatives(db, "trg-atom"), 0);
    const trigger = getTrigger(db, "trg-atom");
    assert.equal(trigger.next_fire_at, 100);
    assert.equal(trigger.last_fired_at, null);
    assert.equal(trigger.updated_at, 1000);
  });

  it("TRIGGER_NOT_FOUND si el trigger no existe", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    assert.throws(() => repo.fireTrigger("no-existe", 1000), isDomainError("TRIGGER_NOT_FOUND"));
  });

  it("TRIGGER_NOT_DISPARABLE para disabled / proposed / next_fire_at NULL / kind != schedule", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    insertTrigger(db, { id: "trg-off", enabled: 0, next_fire_at: 100 });
    insertTrigger(db, { id: "trg-prop", created_by: "agent", proposal_state: "proposed", next_fire_at: 100 });
    insertTrigger(db, { id: "trg-none", next_fire_at: null });
    insertTrigger(db, { id: "trg-kind", kind: "event", next_fire_at: 100 });

    for (const id of ["trg-off", "trg-prop", "trg-none", "trg-kind"]) {
      assert.throws(
        () => repo.fireTrigger(id, 1000),
        isDomainError("TRIGGER_NOT_DISPARABLE"),
        `${id} no debe ser disparable`,
      );
    }
    // Ningún disparo rechazado dejó efectos: cero Initiatives y fechas intactas.
    assert.equal(countInitiatives(db, "trg-off"), 0);
    assert.equal(countInitiatives(db, "trg-prop"), 0);
    assert.equal(countInitiatives(db, "trg-none"), 0);
    assert.equal(countInitiatives(db, "trg-kind"), 0);
    for (const id of ["trg-off", "trg-prop", "trg-none", "trg-kind"]) {
      assert.equal(getTrigger(db, id).updated_at, 1000);
    }
  });

  it("TRIGGER_NOT_DISPARABLE si definition_json no es planificable (pendiente 1)", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    insertTrigger(db, { id: "trg-bad-json", definition_json: "no-es-json", next_fire_at: 100 });
    insertTrigger(db, {
      id: "trg-bad-shape",
      definition_json: JSON.stringify({ version: 1, kind: "daily", at: "08:00" }),
      next_fire_at: 100,
    });

    assert.throws(() => repo.fireTrigger("trg-bad-json", 1000), isDomainError("TRIGGER_NOT_DISPARABLE"));
    assert.throws(() => repo.fireTrigger("trg-bad-shape", 1000), isDomainError("TRIGGER_NOT_DISPARABLE"));
    assert.equal(countInitiatives(db, "trg-bad-json"), 0);
    assert.equal(countInitiatives(db, "trg-bad-shape"), 0);
  });

  it("tras un disparo fallido la base queda operativa: un disparo válido funciona", () => {
    const db = openMemoryDb();
    const repo = new TriggerRepository(db, new InitiativeRepository(db));
    insertTrigger(db, { id: "trg-ok", next_fire_at: 100 });
    assert.throws(() => repo.fireTrigger("no-existe", 1000), isDomainError("TRIGGER_NOT_FOUND"));
    const ini = repo.fireTrigger("trg-ok", 1000);
    assert.equal(ini.origin, "trigger");
    assert.equal(countInitiatives(db, "trg-ok"), 1);
  });
});
