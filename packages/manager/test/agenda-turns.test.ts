// Fase 2.3 — TurnRepository (T7 reserva + T6 terminal, §6 y §8 del plan).
//
// Verifica en `:memory:` (patrón de `storage.test.ts:297`):
//   - T7: `reserveIdempotency` INSERT durable; idempotency_key UNIQUE global
//     (cruza Agents, §8.2) devuelve `{ turnId, duplicate: true }` sin
//     re-ejecutar; misma pareja con otra key → TURN_ID_CONFLICT; atomicidad
//     (COMMIT que falla → no queda reserva);
//   - `findDuplicateTurnId` reproduce `isDuplicateTurn` (undefined si no hay);
//   - T6: `complete` marca turno + Initiative en la misma transacción
//     (mapeo SSE→final_state: succeeded/failed/cancelled, §8.1); doble
//     terminal → TURN_ALREADY_TERMINAL sin sobrescribir; TURN_NOT_FOUND;
//     atomicidad (COMMIT que falla → ni turno ni Initiative marcan terminal);
//     el UPDATE de la Initiative pasa por `canTransition` (discipline §5.1) y
//     acepta 0 filas cuando el barrido/recovery ya falló la Initiative.
//
// Las filas de fixture se siembran por SQL directo; el comportamiento bajo
// prueba se cruza por la interfaz del repositorio, nunca por `db` (§10).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { TurnRepository, type TurnFinalState } from "../src/agenda/turns.ts";
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

/** Siembra una Initiative `running` enlazada a un turno — setup de fixture. */
function insertRunningInitiative(
  db: SqliteDb,
  id: string,
  agentName: string,
  turnId: string,
  chainDeadlineAt: number | null = null,
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
    "modelo", turnId, 0, chainDeadlineAt, 0, null, null, null, null, 1000, 1000, 1000, null,
  );
}

interface TurnRow {
  agent_name: string;
  turn_id: string;
  idempotency_key: string;
  final_state: TurnFinalState | null;
  result: string | null;
  claimed_at: number;
  finished_at: number | null;
}

function getTurn(db: SqliteDb, agentName: string, turnId: string): TurnRow | undefined {
  return db
    .prepare(
      `SELECT agent_name, turn_id, idempotency_key, final_state, result, claimed_at, finished_at
         FROM turns WHERE agent_name = ? AND turn_id = ?`,
    )
    .get(agentName, turnId) as TurnRow | undefined;
}

function countTurns(db: SqliteDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
  return row.n;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("turns.ts — reserveIdempotency (T7, §6/§8)", () => {
  it("T7: reserva durable con duplicate=false", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    const result = repo.reserveIdempotency("alice", "turn-1", "idem-1", 1000);

    assert.deepEqual(result, { turnId: "turn-1", duplicate: false });
    const turn = getTurn(db, "alice", "turn-1");
    assert.ok(turn !== undefined);
    assert.equal(turn.idempotency_key, "idem-1");
    assert.equal(turn.final_state, null);
    assert.equal(turn.claimed_at, 1000);
  });

  it("misma idempotency_key (global, cruza Agents) → {turnId original, duplicate:true}, sin fila nueva", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    repo.reserveIdempotency("alice", "turn-1", "idem-global", 1000);

    const dup = repo.reserveIdempotency("bob", "turn-2", "idem-global", 2000);
    assert.deepEqual(dup, { turnId: "turn-1", duplicate: true });
    assert.equal(countTurns(db), 1); // no se re-ejecuta: una sola reserva
  });

  it("reserva idéntica repetida (misma key y misma pareja) → duplicate:true", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    repo.reserveIdempotency("alice", "turn-1", "idem-1", 1000);
    // El INSERT completo es un duplicado (SQLite puede reportar la PK o la
    // UNIQUE); la key identifica el caso: es la misma reserva.
    assert.deepEqual(repo.reserveIdempotency("alice", "turn-1", "idem-1", 2000), {
      turnId: "turn-1",
      duplicate: true,
    });
    assert.equal(countTurns(db), 1);
  });

  it("misma pareja (agent_name, turn_id) con otra key → TURN_ID_CONFLICT", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    repo.reserveIdempotency("alice", "turn-1", "idem-1", 1000);
    assert.throws(
      () => repo.reserveIdempotency("alice", "turn-1", "idem-2", 2000),
      isDomainError("TURN_ID_CONFLICT"),
    );
    assert.equal(countTurns(db), 1);
  });

  it("findDuplicateTurnId reproduce isDuplicateTurn: turnId o undefined", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-1", "idem-buscada");
    assert.equal(repo.findDuplicateTurnId("idem-buscada"), "turn-1");
    assert.equal(repo.findDuplicateTurnId("idem-inexistente"), undefined);
  });

  it("atomicidad T7: si el COMMIT falla a mitad, ROLLBACK — no queda reserva", () => {
    const db = openMemoryDb();
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
    const repo = new TurnRepository(flaky);

    // El error del COMMIT no es de unicidad: se re-propaga tal cual y el
    // ROLLBACK deja el disco sin la reserva (fila T7: o reservado o nada).
    assert.throws(() => repo.reserveIdempotency("alice", "turn-1", "idem-1", 1000));
    assert.equal(commitTried, true);
    assert.equal(countTurns(db), 0);
  });

  it("tras un ROLLBACK la base queda operativa y la reserva posterior funciona", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
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
    assert.throws(() => new TurnRepository(flaky).reserveIdempotency("alice", "turn-1", "idem-1", 1000));
    assert.deepEqual(repo.reserveIdempotency("alice", "turn-1", "idem-1", 1000), {
      turnId: "turn-1",
      duplicate: false,
    });
  });
});

describe("turns.ts — complete (T6, §6/§8)", () => {
  it("T6: turno + Initiative terminales en la misma tx (turn-complete → succeeded)", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-1", "idem-1");
    insertRunningInitiative(db, "ini-1", "alice", "turn-1");

    repo.complete("alice", "turn-1", "succeeded", "hecho", 2000);

    const turn = getTurn(db, "alice", "turn-1");
    assert.ok(turn !== undefined);
    assert.equal(turn.final_state, "succeeded");
    assert.equal(turn.result, "hecho");
    assert.equal(turn.finished_at, 2000);

    const ini = new AgendaRepository(db).initiatives.get("ini-1");
    assert.equal(ini.state, "succeeded");
    assert.equal(ini.result, "hecho");
    assert.equal(ini.finishedAt, 2000);
    assert.equal(ini.stateChangedAt, 2000);
  });

  it("turn-error → failed con failure_reason='turn_failed' (dato estable, §9.1)", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-err", "idem-err");
    insertRunningInitiative(db, "ini-err", "alice", "turn-err");

    repo.complete("alice", "turn-err", "failed", null, 2000);

    assert.equal(getTurn(db, "alice", "turn-err")?.final_state, "failed");
    const ini = new AgendaRepository(db).initiatives.get("ini-err");
    assert.equal(ini.state, "failed");
    assert.equal(ini.failureReason, "turn_failed");
    assert.equal(ini.finishedAt, 2000);
  });

  it("Fase 3.2: complete acepta cada causa del catálogo y la escribe como failure_reason en la misma tx", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-ru", "idem-ru");
    insertRunningInitiative(db, "ini-ru", "alice", "turn-ru");
    insertTurn(db, "alice", "turn-df", "idem-df");
    insertRunningInitiative(db, "ini-df", "alice", "turn-df");

    repo.complete("alice", "turn-ru", "failed", null, 2000, "runner_unavailable");
    repo.complete("alice", "turn-df", "failed", null, 2000, "dispatch_failed");

    assert.equal(getTurn(db, "alice", "turn-ru")?.final_state, "failed");
    assert.equal(getTurn(db, "alice", "turn-df")?.final_state, "failed");
    const ini = new AgendaRepository(db).initiatives;
    assert.equal(ini.get("ini-ru").failureReason, "runner_unavailable");
    assert.equal(ini.get("ini-df").failureReason, "dispatch_failed");
  });

  it("Fase 3.2: el terminal no dividido por la causa — turno e Initiative cambian en la misma tx", () => {
    // Si el COMMIT falla a mitad, ni el turno ni la Initiative deben marcar
    // terminal, sea cual sea la causa del catálogo.
    const db = openMemoryDb();
    insertTurn(db, "alice", "turn-atom-ru", "idem-atom-ru");
    insertRunningInitiative(db, "ini-atom-ru", "alice", "turn-atom-ru");

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
    const repo = new TurnRepository(flaky);

    assert.throws(() => repo.complete("alice", "turn-atom-ru", "failed", null, 2000, "runner_unavailable"));
    assert.equal(commitTried, true);

    const turn = getTurn(db, "alice", "turn-atom-ru");
    assert.equal(turn?.final_state, null);
    assert.equal(turn?.finished_at, null);
    assert.equal(new AgendaRepository(db).initiatives.get("ini-atom-ru").state, "running");
  });

  it("turn-aborted → cancelled", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-ab", "idem-ab");
    insertRunningInitiative(db, "ini-ab", "alice", "turn-ab");

    repo.complete("alice", "turn-ab", "cancelled", null, 2000);

    assert.equal(getTurn(db, "alice", "turn-ab")?.final_state, "cancelled");
    assert.equal(new AgendaRepository(db).initiatives.get("ini-ab").state, "cancelled");
  });

  it("doble terminal: TURN_ALREADY_TERMINAL y no sobrescribe (write-once, §8.1)", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-1", "idem-1");
    insertRunningInitiative(db, "ini-1", "alice", "turn-1");

    repo.complete("alice", "turn-1", "succeeded", "primero", 2000);
    assert.throws(
      () => repo.complete("alice", "turn-1", "failed", "segundo", 3000),
      isDomainError("TURN_ALREADY_TERMINAL"),
    );

    const turn = getTurn(db, "alice", "turn-1");
    assert.equal(turn?.final_state, "succeeded"); // no se reescribe a failed
    assert.equal(turn?.result, "primero");
    assert.equal(turn?.finished_at, 2000);
    assert.equal(new AgendaRepository(db).initiatives.get("ini-1").state, "succeeded");
  });

  it("TURN_NOT_FOUND si el turno nunca se reservó", () => {
    const repo = new TurnRepository(openMemoryDb());
    assert.throws(
      () => repo.complete("alice", "turn-no", "succeeded", null, 2000),
      isDomainError("TURN_NOT_FOUND"),
    );
  });

  it("atomicidad T6: si el COMMIT falla a mitad, ROLLBACK — ni turno ni Initiative marcan terminal", () => {
    const db = openMemoryDb();
    insertTurn(db, "alice", "turn-atom", "idem-atom");
    insertRunningInitiative(db, "ini-atom", "alice", "turn-atom");

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
    const repo = new TurnRepository(flaky);

    assert.throws(() => repo.complete("alice", "turn-atom", "succeeded", "r", 2000));
    assert.equal(commitTried, true);

    // Muerte antes del COMMIT (fila T6): el terminal SSE se re-procesa
    // (idempotente por el WHERE final_state IS NULL) sin estado parcial.
    const turn = getTurn(db, "alice", "turn-atom");
    assert.equal(turn?.final_state, null);
    assert.equal(turn?.finished_at, null);
    assert.equal(new AgendaRepository(db).initiatives.get("ini-atom").state, "running");
  });

  it("initiative ya fallada por el barrido: el terminal se registra y no reabre la Initiative", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-late", "idem-late");
    insertRunningInitiative(db, "ini-late", "alice", "turn-late", 100);
    // El barrido T9 ya decidió: la Initiative pasó a failed por deadline antes
    // de que llegara el terminal del turno (carrera documentada en complete).
    const n = new AgendaRepository(db).initiatives.sweepChainDeadline(500);
    assert.equal(n, 1);

    repo.complete("alice", "turn-late", "succeeded", "tarde", 2000);

    const turn = getTurn(db, "alice", "turn-late");
    assert.equal(turn?.final_state, "succeeded"); // idempotencia del terminal
    const ini = new AgendaRepository(db).initiatives.get("ini-late");
    assert.equal(ini.state, "failed"); // no se reabre una Initiative ya terminal
    assert.equal(ini.failureReason, "chain_deadline_exceeded");
  });

  it("discipline §5.1: un finalState ilegal desde running lanza INITIATIVE_TRANSITION_ILLEGAL antes de tocar disco", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-1", "idem-1");
    insertRunningInitiative(db, "ini-1", "alice", "turn-1");

    // El tipo cierra el catálogo a succeeded/failed/cancelled; el cast solo
    // demuestra que el guard de la función pura existe también aquí.
    assert.throws(
      () => repo.complete("alice", "turn-1", "expired" as TurnFinalState, null, 2000),
      isDomainError("INITIATIVE_TRANSITION_ILLEGAL"),
    );
    assert.equal(getTurn(db, "alice", "turn-1")?.final_state, null);
    assert.equal(new AgendaRepository(db).initiatives.get("ini-1").state, "running");
  });

  it("tras un ROLLBACK la base queda operativa: un complete posterior funciona", () => {
    const db = openMemoryDb();
    const repo = new TurnRepository(db);
    insertTurn(db, "alice", "turn-re", "idem-re");
    insertRunningInitiative(db, "ini-re", "alice", "turn-re");

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
    assert.throws(() => new TurnRepository(flaky).complete("alice", "turn-re", "succeeded", "r", 2000));

    repo.complete("alice", "turn-re", "succeeded", "r", 3000);
    assert.equal(getTurn(db, "alice", "turn-re")?.final_state, "succeeded");
    assert.equal(new AgendaRepository(db).initiatives.get("ini-re").state, "succeeded");
  });
});
