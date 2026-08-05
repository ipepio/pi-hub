// Fase 3.3 — `TriggerRepository.listDueSchedule(now)` + coalesce de intervalo
// (§3.1–§3.2 del plan consolidado de Fase 3, `docs/design-autonomia-loop-schedule.md`).
//
// El Loop decide a quién disparar leyendo `listDueSchedule(now)` — el predicado
// literal del índice parcial `schedule_triggers_due` —; `fireTrigger` (Fase 2.3)
// es quien escribe, en su propia tx, creando **una** Initiative por Trigger
// vencido y avanzando `next_fire_at` a un vencimiento **estrictamente futuro**
// (`now + intervalMs`: resincroniza desde `now`, no encola disparos atrasados).
//
// Criterio verificable de esta sub-fase (apagón, §7.3.1–§7.3.2): una Initiative
// por Trigger vencido, nunca una por ocurrencia perdida, y el siguiente
// vencimiento en el futuro. No hay Loop todavía (Fase 3.5); el "tick" se
// simula con `listDueSchedule` + `fireTrigger`, que es exactamente lo que el
// Loop hará.
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

const HOUR_MS = 3_600_000;
/** definition_json de fixture: el schedule de intervalo que v1 dispara (pendiente 1). */
const INTERVAL_DEFINITION = JSON.stringify({ version: 1, kind: "interval", intervalMs: HOUR_MS });

interface InsertTrigger {
  id: string;
  kind?: string;
  created_by?: "owner" | "control_plane" | "agent";
  proposal_state?: "proposed" | "approved" | null;
  enabled?: number;
  next_fire_at?: number | null;
}

/** Siembra una fila `triggers` (setup de fixture, no comportamiento bajo prueba). */
function insertTrigger(db: SqliteDb, init: InsertTrigger): void {
  const row = {
    id: init.id,
    agent_name: "alice",
    kind: init.kind ?? "schedule",
    definition_json: INTERVAL_DEFINITION,
    intent: "di hola",
    mode: "solo",
    suggested_skill: null,
    created_by: init.created_by ?? "owner",
    authority: "owner",
    proposal_state: init.proposal_state ?? null,
    enabled: init.enabled ?? 1,
    next_fire_at: init.next_fire_at === undefined ? 100 : init.next_fire_at,
    last_fired_at: null,
    created_at: 1000,
    updated_at: 1000,
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

function getNextFireAt(db: SqliteDb, id: string): number | null {
  const row = db
    .prepare("SELECT next_fire_at FROM triggers WHERE id = ?")
    .get(id) as { next_fire_at: number | null };
  return row.next_fire_at;
}

function countInitiatives(db: SqliteDb, triggerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM initiatives WHERE origin = 'trigger' AND trigger_id = ?")
    .get(triggerId) as { n: number };
  return row.n;
}

function newRepo(db: SqliteDb): TriggerRepository {
  return new TriggerRepository(db, new InitiativeRepository(db));
}

describe("triggers.ts — listDueSchedule + coalesce de intervalo (Fase 3.3)", () => {
  it("§7.3.1 intervalo perdido: un tick dispara UNA Initiative y salta a un vencimiento futuro", () => {
    const db = openMemoryDb();
    const repo = newRepo(db);
    // next_fire_at = 08:00; el Manager vuelve a las 12:00 (apagón de 4h).
    const nextFireAt = 8 * HOUR_MS;
    const now = 12 * HOUR_MS;
    insertTrigger(db, { id: "trg-due", next_fire_at: nextFireAt });

    const due = repo.listDueSchedule(now);
    assert.deepEqual(due, [{ id: "trg-due", agentName: "alice", nextFireAt }]);

    const ini = repo.fireTrigger("trg-due", now);
    assert.equal(ini.state, "queued");
    assert.equal(ini.availableAt, now);

    // next_fire_at salta a now + intervalMs: estrictamente posterior a `now`
    // (= 12:00 + 1h), no itera desde el vencimiento viejo de las 08:00.
    assert.equal(getNextFireAt(db, "trg-due"), now + HOUR_MS);
    assert.equal(getNextFireAt(db, "trg-due") > now, true);

    // Otro `tick` sin avanzar el reloj ya no ve nada vencido: no crea otra.
    assert.deepEqual(repo.listDueSchedule(now), []);
    assert.equal(countInitiatives(db, "trg-due"), 1);
  });

  it("§7.3.2 varias ocurrencias perdidas: intervalo 1h y apagón 10h crea UNA, no diez", () => {
    const db = openMemoryDb();
    const repo = newRepo(db);
    // next_fire_at = 08:00; apagón de 10h → 10 ocurrencias perdidas.
    const nextFireAt = 8 * HOUR_MS;
    const now = nextFireAt + 10 * HOUR_MS;
    insertTrigger(db, { id: "trg-blackout", next_fire_at: nextFireAt });

    assert.deepEqual(repo.listDueSchedule(now).map((t) => t.id), ["trg-blackout"]);
    repo.fireTrigger("trg-blackout", now);

    assert.equal(countInitiatives(db, "trg-blackout"), 1);
    assert.equal(getNextFireAt(db, "trg-blackout"), now + HOUR_MS);
    assert.deepEqual(repo.listDueSchedule(now), []);
  });

  it("varios Triggers vencidos: orden por (next_fire_at, id) y UNA Initiative por Trigger", () => {
    const db = openMemoryDb();
    const repo = newRepo(db);
    insertTrigger(db, { id: "b", next_fire_at: 200 });
    insertTrigger(db, { id: "a", next_fire_at: 200 });
    insertTrigger(db, { id: "c", next_fire_at: 100 });

    const now = 500;
    assert.deepEqual(repo.listDueSchedule(now).map((t) => t.id), ["c", "a", "b"]);

    for (const id of ["c", "a", "b"]) repo.fireTrigger(id, now);

    for (const id of ["c", "a", "b"]) {
      assert.equal(countInitiatives(db, id), 1);
      assert.equal(getNextFireAt(db, id), now + HOUR_MS);
    }
    assert.deepEqual(repo.listDueSchedule(now), []);
  });

  it("listDueSchedule filtra el conjunto del índice: disabled, proposed, kind!=schedule, next_fire_at NULL o futuro", () => {
    const db = openMemoryDb();
    const repo = newRepo(db);
    const now = 1000;
    insertTrigger(db, { id: "due", next_fire_at: 500 });
    insertTrigger(db, { id: "disabled", enabled: 0, next_fire_at: 100 });
    insertTrigger(db, { id: "proposed", created_by: "agent", proposal_state: "proposed", next_fire_at: 100 });
    insertTrigger(db, { id: "kind-event", kind: "event", next_fire_at: 100 });
    insertTrigger(db, { id: "no-next", next_fire_at: null });
    insertTrigger(db, { id: "future", next_fire_at: now + 1 });

    assert.deepEqual(repo.listDueSchedule(now).map((t) => t.id), ["due"]);
  });

  it("listDueSchedule es lectura: no avanza next_fire_at ni crea Initiatives", () => {
    const db = openMemoryDb();
    const repo = newRepo(db);
    insertTrigger(db, { id: "trg", next_fire_at: 100 });

    repo.listDueSchedule(1000);

    assert.equal(getNextFireAt(db, "trg"), 100);
    assert.equal(countInitiatives(db, "trg"), 0);
  });
});
