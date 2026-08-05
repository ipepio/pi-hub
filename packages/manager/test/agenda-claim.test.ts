// Fase 3.4 — claim unificado en `AgendaRepository` (plan de Fase 3 §4.5,
// `docs/design-autonomia-loop-schedule.md` §9.4).
//
// El claim compone T7 (reserva de idempotencia) y T2 (`queued→running` con
// `turnId`) en una SOLA `BEGIN IMMEDIATE`. Criterio verificable de esta
// sub-fase: camino feliz, carrera perdida con `INITIATIVE_STATE_CONFLICT`,
// `TURN_ID_CONFLICT`, y que **no** queda reserva huérfana al perder el CAS.
// El two-step dejaría la reserva; el single-tx la descarta en el ROLLBACK
// (§8.1 — contradicción resuelta a propósito, no se reabre).
//
// Las filas de fixture se siembran por SQL directo; el comportamiento bajo
// prueba se cruza por la interfaz del repositorio, nunca por `db` (§10).

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
  agent_name?: string;
  state?: InitiativeState;
  bound_model?: string | null;
  turn_id?: string | null;
  started_at?: number | null;
}

/** Siembra una fila `initiatives` en `queued` (setup de fixture, no comportamiento bajo prueba). */
function insertQueuedInitiative(db: SqliteDb, init: InsertInit): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    init.id, init.agent_name ?? "alice", init.state ?? "queued", "human", null,
    "di hola", "solo", "sk-1", 1, init.bound_model ?? null, init.turn_id ?? null,
    0, null, 0, null, null, null, null, 1000, 1000, init.started_at ?? null, null,
  );
}

/** Siembra una reserva de turno (T7) — setup de fixture. */
function insertTurn(
  db: SqliteDb,
  agentName: string,
  turnId: string,
  idempotencyKey: string,
  claimedAt = 1000,
): void {
  db.prepare(
    "INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at) VALUES (?,?,?,?)",
  ).run(agentName, turnId, idempotencyKey, claimedAt);
}

function countTurns(db: SqliteDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
  return row.n;
}

function countTurnsFor(db: SqliteDb, agentName: string, turnId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM turns WHERE agent_name = ? AND turn_id = ?")
    .get(agentName, turnId) as { n: number };
  return row.n;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("index.ts — claimInitiative (T7+T2 en una sola tx, Fase 3.4)", () => {
  it("camino feliz: claim deja la Initiative running con el turno reservado", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-1" });

    const ini = repo.claimInitiative({
      initiativeId: "ini-1", turnId: "turn-1", idempotencyKey: "idem-1", now: 2000,
    });

    assert.equal(ini.state, "running");
    assert.equal(ini.turnId, "turn-1");
    assert.equal(ini.startedAt, 2000);
    assert.equal(ini.stateChangedAt, 2000);
    assert.equal(ini.finishedAt, null);
    assert.equal(ini.sessionKey, "sk-1");
    // La reserva T7 está presente y sin terminal: es el turno del claim.
    assert.equal(countTurnsFor(db, "alice", "turn-1"), 1);
  });

  it("la reserva cualifica por el agent_name de la Initiative, no por uno ajeno", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-bob", agent_name: "bob" });

    const ini = repo.claimInitiative({
      initiativeId: "ini-bob", turnId: "turn-1", idempotencyKey: "idem-1", now: 2000,
    });
    assert.equal(ini.state, "running");
    assert.equal(countTurnsFor(db, "bob", "turn-1"), 1);
    assert.equal(countTurnsFor(db, "alice", "turn-1"), 0);
  });

  it("dos claims sobre la misma Initiative: el primero gana, el segundo INITIATIVE_STATE_CONFLICT sin reserva nueva", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-race" });

    const first = repo.claimInitiative({
      initiativeId: "ini-race", turnId: "turn-1", idempotencyKey: "idem-1", now: 2000,
    });
    assert.equal(first.state, "running");
    assert.equal(first.turnId, "turn-1");

    // El segundo claim se construyó con la lectura antigua (`queued`): el
    // estado durable ya es `running` → carrera, no bug (§12.4).
    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "ini-race", turnId: "turn-2", idempotencyKey: "idem-2", now: 2000,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    assert.equal(repo.initiatives.get("ini-race").turnId, "turn-1");
    // NO queda reserva huérfana del claim perdedor: el ROLLBACK descartó su
    // turno. Solo existe la reserva del ganador.
    assert.equal(countTurns(db), 1);
    assert.equal(countTurnsFor(db, "alice", "turn-2"), 0);
  });

  it("carrera perdida contra una Initiative ya no queued: INITIATIVE_STATE_CONFLICT sin tocar nada", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    // Otro escritor ya ganó la carrera antes de nuestro claim.
    insertQueuedInitiative(db, { id: "ini-race", state: "running", bound_model: "m", turn_id: "turn-ganador", started_at: 1500 });
    insertTurn(db, "alice", "turn-ganador", "idem-ganador");

    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "ini-race", turnId: "turn-perdedor", idempotencyKey: "idem-perdedor", now: 2000,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    assert.equal(repo.initiatives.get("ini-race").turnId, "turn-ganador");
    // Solo la reserva del ganador existe; el claim perdedor no dejó huérfana.
    assert.equal(countTurns(db), 1);
    assert.equal(countTurnsFor(db, "alice", "turn-perdedor"), 0);
  });

  it("TURN_ID_CONFLICT: la pareja (agent_name, turn_id) ya existe con otra key", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-1" });
    insertTurn(db, "alice", "turn-1", "idem-otro");

    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "ini-1", turnId: "turn-1", idempotencyKey: "idem-nuevo", now: 2000,
      }),
      isDomainError("TURN_ID_CONFLICT"),
    );
    assert.equal(repo.initiatives.get("ini-1").state, "queued");
    assert.equal(countTurns(db), 1);
  });

  it("TURN_ID_CONFLICT: la idempotency_key ya está reservada por otro turno", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-1" });
    insertTurn(db, "alice", "turn-original", "idem-dup");

    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "ini-1", turnId: "turn-nuevo", idempotencyKey: "idem-dup", now: 2000,
      }),
      isDomainError("TURN_ID_CONFLICT"),
    );
    assert.equal(repo.initiatives.get("ini-1").state, "queued");
    assert.equal(countTurns(db), 1);
  });

  it("INITIATIVE_NOT_FOUND si la Initiative no existe, sin reserva", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);

    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "no-existe", turnId: "turn-x", idempotencyKey: "idem-x", now: 2000,
      }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
    assert.equal(countTurns(db), 0);
  });

  it("boundModel: se fija solo si era NULL (invariante 4, igual que transition)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-libre", bound_model: null });
    insertQueuedInitiative(db, { id: "ini-fijado", bound_model: "modelo-existente" });

    const libre = repo.claimInitiative({
      initiativeId: "ini-libre", turnId: "t-a", idempotencyKey: "idem-a", now: 2000, boundModel: "gpt-5",
    });
    assert.equal(libre.boundModel, "gpt-5");

    const fijado = repo.claimInitiative({
      initiativeId: "ini-fijado", turnId: "t-b", idempotencyKey: "idem-b", now: 2000, boundModel: "gpt-otro",
    });
    assert.equal(fijado.boundModel, "modelo-existente"); // no se sobrescribe
  });

  it("atomicidad: si el COMMIT falla a mitad, ni reserva ni transition persisten", () => {
    const db = openMemoryDb();
    insertQueuedInitiative(db, { id: "ini-atom" });

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

    assert.throws(() => repo.claimInitiative({
      initiativeId: "ini-atom", turnId: "turn-atom", idempotencyKey: "idem-atom", now: 2000,
    }));
    assert.equal(commitTried, true);

    // Muerte antes del COMMIT (fila T7/T2): ni la reserva ni el paso a
    // running quedan a medias — la Initiative sigue queued y sin turno.
    assert.equal(countTurns(db), 0);
    const ini = new AgendaRepository(db).initiatives.get("ini-atom");
    assert.equal(ini.state, "queued");
    assert.equal(ini.turnId, null);
  });

  it("tras perder la carrera, la base queda operativa: un claim posterior funciona", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    insertQueuedInitiative(db, { id: "ini-race", state: "running", bound_model: "m", turn_id: "t-win", started_at: 1500 });
    insertTurn(db, "alice", "t-win", "idem-win");
    insertQueuedInitiative(db, { id: "ini-libre" });

    assert.throws(
      () => repo.claimInitiative({
        initiativeId: "ini-race", turnId: "t-lose", idempotencyKey: "idem-lose", now: 2000,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );

    const ini = repo.claimInitiative({
      initiativeId: "ini-libre", turnId: "t-ok", idempotencyKey: "idem-ok", now: 2500,
    });
    assert.equal(ini.state, "running");
    assert.equal(countTurns(db), 2);
  });
});
