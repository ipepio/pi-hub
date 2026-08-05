// Fase 2.2 — InitiativeRepository (contrato de seis pasos, §5 del plan de Fase 2).
//
// Verifica en `:memory:` (patrón de `storage.test.ts:297`):
//   - transición ilegal → `INITIATIVE_TRANSITION_ILLEGAL` **sin escribir en
//     disco** (la fila queda intacta tras el `SELECT`);
//   - carrera perdida → `INITIATIVE_STATE_CONFLICT` (el segundo comando, con
//     `from` obsoleto, ve el estado cambiado entre su lectura y su CAS);
//   - invariantes multi-fila (4: `bound_model` solo si NULL; 6:
//     `chain_deadline_at` al delegar) y campos obligatorios por transición;
//   - barridos T9/T10 que solo tocan filas donde `canTransition` dice legal;
//   - superficie de lectura `get`/`listDue`/`listRunning`.
//
// Las filas se siembran por SQL directo sobre el fixture (el repositorio no
// tiene `insert`: el plan fija su superficie en get/transition/listDue/
// listRunning/sweepChainDeadline/sweepWaitingHumanExpiry); el comportamiento
// bajo prueba —transiciones, CAS, barridos— se cruza por la interfaz del
// repositorio, nunca por `db` (§10).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { InitiativeRepository } from "../src/agenda/initiatives.ts";
import { DomainError } from "../src/agenda/errors.ts";
import {
  canTransition,
  type InitiativeMode,
  type InitiativeState,
} from "../src/agenda/state.ts";

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

const STATES: readonly InitiativeState[] = [
  "queued",
  "running",
  "waiting_human",
  "waiting_agent",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
];

interface InsertInit {
  id: string;
  state?: InitiativeState;
  origin?: "trigger" | "callback" | "human";
  mode?: InitiativeMode;
  session_key?: string;
  available_at?: number;
  bound_model?: string | null;
  turn_id?: string | null;
  chain_depth?: number;
  chain_deadline_at?: number | null;
  summary?: string | null;
  ask_correlation?: string | null;
  failure_reason?: string | null;
  result?: string | null;
  created_at?: number;
  state_changed_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, init: InsertInit): void {
  const row = {
    id: init.id,
    agent_name: "alice",
    state: init.state ?? "queued",
    origin: init.origin ?? "human",
    trigger_id: null,
    intent: "di hola",
    mode: init.mode ?? "solo",
    session_key: init.session_key ?? "sk-1",
    available_at: init.available_at ?? 1,
    bound_model: init.bound_model ?? null,
    turn_id: init.turn_id ?? null,
    chain_depth: init.chain_depth ?? 0,
    chain_deadline_at: init.chain_deadline_at ?? null,
    visible_effects_declared: 0,
    summary: init.summary ?? null,
    ask_correlation: init.ask_correlation ?? null,
    failure_reason: init.failure_reason ?? null,
    result: init.result ?? null,
    created_at: init.created_at ?? 1000,
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

/** Fila con los campos mínimos que una Initiative debe poder tener por estado. */
function seedInState(db: SqliteDb, id: string, state: InitiativeState): void {
  const extra: Partial<InsertInit> = {};
  switch (state) {
    case "waiting_human":
      extra.summary = "resumen";
      break;
    case "succeeded":
      extra.finished_at = 2000;
      break;
    case "failed":
      extra.failure_reason = "turn_failed";
      extra.finished_at = 2000;
      break;
    case "expired":
    case "cancelled":
      extra.finished_at = 2000;
      break;
    default:
      break;
  }
  insertInitiative(db, { id, state, ...extra });
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("initiatives.ts — transiciones (contrato de seis pasos, §5)", () => {
  it("get devuelve la fila mapeada y lanza INITIATIVE_NOT_FOUND si no existe", () => {
    const repo = new InitiativeRepository(openMemoryDb());
    assert.throws(() => repo.get("no-existe"), isDomainError("INITIATIVE_NOT_FOUND"));
  });

  it("queued→running (T2): fija started_at, bound_model, turn_id y state_changed_at", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "ini-1" });
    const after = repo.transition({
      id: "ini-1", from: "queued", to: "running", now: 2000, turnId: "turn-9", boundModel: "gpt-5",
    });
    assert.equal(after.state, "running");
    assert.equal(after.startedAt, 2000);
    assert.equal(after.turnId, "turn-9");
    assert.equal(after.boundModel, "gpt-5");
    assert.equal(after.stateChangedAt, 2000);
    assert.equal(after.finishedAt, null);
    assert.equal(after.sessionKey, "sk-1");
  });

  it("queued→running no sobrescribe un bound_model ya fijado (invariante 4)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "ini-4", bound_model: "modelo-ya-fijado" });
    const after = repo.transition({
      id: "ini-4", from: "queued", to: "running", now: 2000, boundModel: "modelo-nuevo",
    });
    assert.equal(after.boundModel, "modelo-ya-fijado");
  });

  it("running→waiting_human exige summary y escala solo→ask (nunca ask→solo)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "wh", state: "running", bound_model: "m", turn_id: "t" });
    assert.throws(
      () => repo.transition({ id: "wh", from: "running", to: "waiting_human", now: 2000 }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    const after = repo.transition({
      id: "wh", from: "running", to: "waiting_human", now: 2500,
      summary: "necesito datos", askCorrelation: "ask-1",
    });
    assert.equal(after.state, "waiting_human");
    assert.equal(after.summary, "necesito datos");
    assert.equal(after.askCorrelation, "ask-1");
    assert.equal(after.mode, "ask");
    assert.equal(after.boundModel, "m");
  });

  it("running→waiting_agent exige chain_deadline_at (invariante 6)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "wa", state: "running", bound_model: "m", turn_id: "t" });
    assert.throws(
      () => repo.transition({ id: "wa", from: "running", to: "waiting_agent", now: 2000 }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    const after = repo.transition({
      id: "wa", from: "running", to: "waiting_agent", now: 2500, chainDeadlineAt: 4000,
    });
    assert.equal(after.state, "waiting_agent");
    assert.equal(after.chainDeadlineAt, 4000);
  });

  it("running→succeeded (T6): fija result y finished_at", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "ok", state: "running", bound_model: "m", turn_id: "t" });
    const after = repo.transition({ id: "ok", from: "running", to: "succeeded", now: 3000, result: "hecho" });
    assert.equal(after.state, "succeeded");
    assert.equal(after.result, "hecho");
    assert.equal(after.finishedAt, 3000);
    assert.equal(after.stateChangedAt, 3000);
  });

  it("running→failed exige failure_reason y fija finished_at", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "fail", state: "running", bound_model: "m", turn_id: "t" });
    assert.throws(
      () => repo.transition({ id: "fail", from: "running", to: "failed", now: 3000 }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    const after = repo.transition({ id: "fail", from: "running", to: "failed", now: 3000, failureReason: "turn_failed" });
    assert.equal(after.state, "failed");
    assert.equal(after.failureReason, "turn_failed");
    assert.equal(after.finishedAt, 3000);
  });

  it("waiting_human→queued reanuda fijando available_at y conservando session_key/bound_model", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, {
      id: "resume", state: "waiting_human", summary: "s", mode: "ask",
      session_key: "sk-orig", bound_model: "m", ask_correlation: "ask-1",
    });
    const after = repo.transition({ id: "resume", from: "waiting_human", to: "queued", now: 4000, availableAt: 4100 });
    assert.equal(after.state, "queued");
    assert.equal(after.availableAt, 4100);
    assert.equal(after.sessionKey, "sk-orig");
    assert.equal(after.boundModel, "m");
    assert.equal(after.mode, "ask"); // no vuelve a solo
  });

  it("waiting_agent→queued reanuda (entrega de Callback) fijando available_at", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "cb-resume", state: "waiting_agent", session_key: "sk-parent", chain_deadline_at: 9999 });
    assert.throws(
      () => repo.transition({ id: "cb-resume", from: "waiting_agent", to: "queued", now: 4000 }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    const after = repo.transition({ id: "cb-resume", from: "waiting_agent", to: "queued", now: 4000, availableAt: 4100 });
    assert.equal(after.state, "queued");
    assert.equal(after.availableAt, 4100);
    assert.equal(after.sessionKey, "sk-parent");
  });

  it("transición ilegal: INITIATIVE_TRANSITION_ILLEGAL sin escribir en disco (§10.2)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "ini-illegal", created_at: 1000, state_changed_at: 1000 });
    assert.throws(
      () => repo.transition({ id: "ini-illegal", from: "queued", to: "succeeded", now: 2000 }),
      isDomainError("INITIATIVE_TRANSITION_ILLEGAL"),
    );
    // La fila queda exactamente como estaba: nada se escribió.
    const row = db
      .prepare("SELECT state, state_changed_at, finished_at, result, started_at FROM initiatives WHERE id = ?")
      .get("ini-illegal") as { state: string; state_changed_at: number; finished_at: number | null; result: string | null; started_at: number | null };
    assert.equal(row.state, "queued");
    assert.equal(row.state_changed_at, 1000);
    assert.equal(row.finished_at, null);
    assert.equal(row.result, null);
    assert.equal(row.started_at, null);
    // Y la base queda operativa: una transición legal posterior funciona.
    const after = repo.transition({ id: "ini-illegal", from: "queued", to: "running", now: 2000, turnId: "t" });
    assert.equal(after.state, "running");
  });

  it("las 64 celdas de la matriz: toda transición no listada en §4.2 falla con INITIATIVE_TRANSITION_ILLEGAL", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    for (const from of STATES) {
      for (const to of STATES) {
        if (canTransition(from, to)) continue;
        const id = `${from}-to-${to}`;
        seedInState(db, id, from);
        assert.throws(
          () => repo.transition({ id, from, to, now: 2000 }),
          isDomainError("INITIATIVE_TRANSITION_ILLEGAL"),
          `${from} -> ${to} debe ser ilegal`,
        );
      }
    }
  });

  it("ninguna transición sale de un terminal (absorbentes, §4.1)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "done", state: "succeeded", finished_at: 1000, result: "r" });
    for (const to of STATES) {
      assert.throws(
        () => repo.transition({ id: "done", from: "succeeded", to, now: 2000 }),
        isDomainError("INITIATIVE_TRANSITION_ILLEGAL"),
        `succeeded -> ${to}`,
      );
    }
  });

  it("carrera perdida: el segundo comando con from obsoleto recibe INITIATIVE_STATE_CONFLICT (§12.4)", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "ini-race" });
    // Primer escritor: gana la carrera y confirma queued→running.
    const first = repo.transition({ id: "ini-race", from: "queued", to: "running", now: 2000, turnId: "turn-1" });
    assert.equal(first.state, "running");
    // El segundo comando se construyó con la lectura antigua (from='queued'):
    // entre su lectura y su CAS el estado cambió a 'running' → carrera, no bug.
    assert.throws(
      () => repo.transition({ id: "ini-race", from: "queued", to: "running", now: 2000, turnId: "turn-2" }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    // Rollback higiénico: el estado durable sigue siendo el del primer ganador
    // y el repositorio sigue operativo.
    assert.equal(repo.get("ini-race").state, "running");
    const again = repo.transition({ id: "ini-race", from: "running", to: "succeeded", now: 3000, result: "ok" });
    assert.equal(again.state, "succeeded");
  });

  it("transition sobre una Initiative inexistente lanza INITIATIVE_NOT_FOUND", () => {
    const repo = new InitiativeRepository(openMemoryDb());
    assert.throws(
      () => repo.transition({ id: "no-existe", from: "queued", to: "running", now: 2000 }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
  });

  it("ciclo completo: queued→running→waiting_human→queued→running→succeeded", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "journey" });
    let ini = repo.transition({ id: "journey", from: "queued", to: "running", now: 1000, turnId: "t1" });
    assert.equal(ini.state, "running");
    ini = repo.transition({ id: "journey", from: "running", to: "waiting_human", now: 2000, summary: "s", askCorrelation: "a1" });
    assert.equal(ini.state, "waiting_human");
    ini = repo.transition({ id: "journey", from: "waiting_human", to: "queued", now: 3000, availableAt: 3100 });
    assert.equal(ini.state, "queued");
    ini = repo.transition({ id: "journey", from: "queued", to: "running", now: 4000, turnId: "t2" });
    assert.equal(ini.state, "running");
    ini = repo.transition({ id: "journey", from: "running", to: "succeeded", now: 5000, result: "done" });
    assert.equal(ini.state, "succeeded");
    assert.equal(ini.finishedAt, 5000);
  });
});

describe("initiatives.ts — superficie de lectura", () => {
  it("listDue devuelve solo las queued con available_at vencido, en orden", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "a", available_at: 100 });
    insertInitiative(db, { id: "b", available_at: 600 }); // futura
    insertInitiative(db, { id: "c", state: "running", available_at: 50, bound_model: "m", turn_id: "t" }); // no queued
    const due = repo.listDue(500);
    assert.deepEqual(due.map((i) => i.id), ["a"]);
    assert.equal(due[0]?.state, "queued");
  });

  it("listRunning devuelve solo las running", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "r1", state: "running", bound_model: "m", turn_id: "t1" });
    insertInitiative(db, { id: "q", state: "queued" });
    insertInitiative(db, { id: "r2", state: "running", bound_model: "m", turn_id: "t2" });
    const running = repo.listRunning();
    assert.deepEqual(running.map((i) => i.id), ["r1", "r2"]);
    for (const ini of running) assert.equal(ini.state, "running");
  });
});

describe("initiatives.ts — barridos T9/T10 (función pura en lote, §5.2)", () => {
  it("sweepChainDeadline (T9): solo no terminales con deadline vencido pasan a failed", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "wa-due", state: "waiting_agent", chain_deadline_at: 100 });
    insertInitiative(db, { id: "wh-due", state: "waiting_human", summary: "s", chain_deadline_at: 100 });
    insertInitiative(db, { id: "q-due", state: "queued", chain_deadline_at: 100 });
    insertInitiative(db, { id: "r-due", state: "running", chain_deadline_at: 100, bound_model: "m", turn_id: "t" });
    insertInitiative(db, { id: "r-future", state: "running", chain_deadline_at: 9999, bound_model: "m", turn_id: "t" });
    insertInitiative(db, { id: "q-none", state: "queued", chain_deadline_at: null });
    insertInitiative(db, { id: "s-term", state: "succeeded", chain_deadline_at: 50, finished_at: 60 }); // terminal: fuera de la matriz
    const n = repo.sweepChainDeadline(500);
    assert.equal(n, 4);
    for (const id of ["wa-due", "wh-due", "q-due", "r-due"]) {
      const ini = repo.get(id);
      assert.equal(ini.state, "failed", `${id} debe fallar por deadline`);
      assert.equal(ini.failureReason, "chain_deadline_exceeded");
      assert.equal(ini.finishedAt, 500);
    }
    assert.equal(repo.get("r-future").state, "running");
    assert.equal(repo.get("q-none").state, "queued");
    assert.equal(repo.get("s-term").state, "succeeded");
  });

  it("sweepWaitingHumanExpiry (T10): solo waiting_human con state_changed_at vencido caduca", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "wh-old", state: "waiting_human", summary: "s", state_changed_at: 100 });
    insertInitiative(db, { id: "wh-fresh", state: "waiting_human", summary: "s", state_changed_at: 9999 });
    insertInitiative(db, { id: "q-old", state: "queued", state_changed_at: 100 }); // queued no caduca (CONTEXT.md:40)
    insertInitiative(db, { id: "wa-old", state: "waiting_agent", chain_deadline_at: 9999, state_changed_at: 100 }); // waiting_agent tampoco
    const n = repo.sweepWaitingHumanExpiry(500);
    assert.equal(n, 1);
    const expired = repo.get("wh-old");
    assert.equal(expired.state, "expired");
    assert.equal(expired.finishedAt, 500);
    assert.equal(expired.summary, "s"); // decisión 7: conserva summary
    assert.equal(repo.get("wh-fresh").state, "waiting_human");
    assert.equal(repo.get("q-old").state, "queued");
    assert.equal(repo.get("wa-old").state, "waiting_agent");
  });

  it("los barridos no dejan la base en transacción abierta: un transition posterior funciona", () => {
    const db = openMemoryDb();
    const repo = new InitiativeRepository(db);
    insertInitiative(db, { id: "wh-old", state: "waiting_human", summary: "s", state_changed_at: 100 });
    repo.sweepWaitingHumanExpiry(500);
    insertInitiative(db, { id: "fresh", state: "waiting_human", summary: "s", state_changed_at: 9999 });
    const after = repo.transition({ id: "fresh", from: "waiting_human", to: "queued", now: 6000, availableAt: 6100 });
    assert.equal(after.state, "queued");
  });
});
