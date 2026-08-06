// P1.5 — AutonomyControl.cancelInitiative (plan P1 §6.2, matriz completa).
//
// Cancelar una Initiative. La decisión que lo gobierna todo es cómo se cancela
// una que está corriendo:
//
//   - `queued`, `waiting_human`, `waiting_agent` → CAS directo a `cancelled`
//     (estados en reposo, nadie los está tocando);
//   - `running` → SOLO por `TurnExecution.abort` + terminal T6. NO existe un
//     write optimista `running→cancelled`: una Initiative `running` tiene un
//     turno vivo con una sesión abierta, y escribir `cancelled` mientras el
//     turno sigue generando dejaría la Agenda mintiendo.
//
// Por eso todo el comportamiento se cruza por `AutonomyControl.cancelInitiative`
// con un fake de `Pick<TurnExecution,"abort">`, y en los casos `running` se
// afirma que Control **no ejecutó ningún UPDATE a `initiatives`** (criterio
// verificable de la sub-fase). El SQL directo es solo fixture y verificación
// de estado durable.
//
// Más decisiones cerradas, convertidas en invariantes:
//
//   - repetir `cancelled` es éxito; cualquier otro terminal es state conflict;
//   - otro Agent es indistinguible de inexistente (`INITIATIVE_NOT_FOUND`);
//   - la ventana connecting (abort=false con el turno todavía corriendo) queda
//     visible como `INITIATIVE_STATE_CONFLICT` hasta P4;
//   - `running` sin `turn_id` es `INITIATIVE_INVARIANT_VIOLATION` (no hay turno
//     que abortar);
//   - el CAS perdido (queued→running entre la lectura de Control y el write)
//     es `INITIATIVE_STATE_CONFLICT` y no deja una cancelación ficticia.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository, AutonomyControl } from "../src/agenda/index.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { DomainError } from "../src/agenda/errors.ts";

const openDbs: SqliteDb[] = [];

/** Fixture de `:memory:` con el esquema aplicado (patrón de la suite). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Fake de `Pick<TurnExecution,"abort">`; falla si el camino de cancel lo invoca sin esperarlo. */
function abortFake(impl?: () => boolean): Pick<TurnExecution, "abort"> {
  return {
    abort: () => {
      if (impl === undefined) {
        throw new Error("abort no debía invocarse en este caso");
      }
      return impl();
    },
  };
}

function control(
  db: SqliteDb,
  turns: Pick<TurnExecution, "abort"> = abortFake(() => false),
): AutonomyControl {
  return new AutonomyControl({ agenda: new AgendaRepository(db), turns, authority: "owner" });
}

interface InitiativeSeed {
  id: string;
  agent_name?: string;
  state?: string;
  origin?: string;
  trigger_id?: string | null;
  intent?: string;
  mode?: string;
  session_key?: string;
  available_at?: number;
  bound_model?: string | null;
  turn_id?: string | null;
  chain_depth?: number;
  chain_deadline_at?: number | null;
  visible_effects_declared?: number;
  summary?: string | null;
  ask_correlation?: string | null;
  failure_reason?: string | null;
  result?: string | null;
  created_at?: number;
  state_changed_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
  pending_human_input?: string | null;
  human_response_idempotency_key?: string | null;
  human_response_command_hash?: string | null;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, seed: InitiativeSeed): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at,
        pending_human_input, human_response_idempotency_key,
        human_response_command_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    seed.id,
    seed.agent_name ?? "alice",
    seed.state ?? "queued",
    seed.origin ?? "human",
    seed.trigger_id ?? null,
    seed.intent ?? "di hola",
    seed.mode ?? "solo",
    seed.session_key ?? "sk-1",
    seed.available_at ?? 1,
    seed.bound_model ?? null,
    seed.turn_id ?? null,
    seed.chain_depth ?? 0,
    seed.chain_deadline_at ?? null,
    seed.visible_effects_declared ?? 0,
    seed.summary ?? null,
    seed.ask_correlation ?? null,
    seed.failure_reason ?? null,
    seed.result ?? null,
    seed.created_at ?? 1000,
    seed.state_changed_at ?? 1000,
    seed.started_at ?? null,
    seed.finished_at ?? null,
    seed.pending_human_input ?? null,
    seed.human_response_idempotency_key ?? null,
    seed.human_response_command_hash ?? null,
  );
}

interface InitiativeRaw {
  id: string;
  agent_name: string;
  state: string;
  turn_id: string | null;
  pending_human_input: string | null;
  human_response_idempotency_key: string | null;
  human_response_command_hash: string | null;
  available_at: number;
  state_changed_at: number;
  session_key: string;
  bound_model: string | null;
  intent: string;
  finished_at: number | null;
}

/** Fila cruda de `initiatives` para verificar el estado durable. */
function rowOf(db: SqliteDb, id: string): InitiativeRaw {
  return db
    .prepare(
      `SELECT id, agent_name, state, turn_id, pending_human_input,
              human_response_idempotency_key, human_response_command_hash,
              available_at, state_changed_at, session_key, bound_model, intent,
              finished_at
         FROM initiatives WHERE id = ?`,
    )
    .get(id) as InitiativeRaw;
}

/** SHA-256 de la forma canónica de respuesta (mismo algoritmo que el repo, §2.3). */
function respondHash(initiativeId: string, answer: string): string {
  return createHash("sha256").update(JSON.stringify({ initiativeId, answer })).digest("hex");
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

/**
 * Adapter de test alrededor de `SqliteDb`: registra cualquier `UPDATE
 * initiatives` que se ejecute a través de él. El criterio verificable de la
 * sub-fase: en el caso `running`, Control no ejecutó ningún UPDATE a la
 * Initiative — T6 escribirá el terminal, nunca Control.
 */
function updateSpy(db: SqliteDb): { db: SqliteDb; updates: string[] } {
  const updates: string[] = [];
  const wrapped: SqliteDb = {
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...args),
        all: (...args: unknown[]) => stmt.all(...args),
        run: (...args: unknown[]) => {
          if (/^\s*UPDATE\s+initiatives\b/i.test(sql)) updates.push(sql);
          return stmt.run(...args);
        },
      };
    },
  };
  return { db: wrapped, updates };
}

/**
 * Adapter que dispara `mutate()` justo después de la primera lectura agent-scoped
 * de una Initiative (el `getForAgent` inicial de Control), para simular que otro
 * escritor gana la carrera antes de que el repositorio aplique su CAS.
 */
function raceDb(db: SqliteDb, mutate: () => void): SqliteDb {
  let armed = true;
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const isScopedInitiativeRead =
        /FROM\s+initiatives/i.test(sql) && /agent_name\s*=\s*\?/i.test(sql);
      return {
        get: (...args: unknown[]) => {
          const result = stmt.get(...args);
          if (armed && isScopedInitiativeRead) {
            armed = false;
            mutate();
          }
          return result;
        },
        all: (...args: unknown[]) => stmt.all(...args),
        run: (...args: unknown[]) => stmt.run(...args),
      };
    },
  };
}

describe("AutonomyControl.cancelInitiative (P1.5, plan P1 §6.2)", () => {
  it("queued → cancelled por CAS: finished_at=state_changed_at=now", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-q", state: "queued", available_at: 100 });
    const ctl = control(db);

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-q", now: 500 });

    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(result.initiative.state, "cancelled");
    assert.strictEqual(result.initiative.finishedAt, 500);
    assert.strictEqual(result.initiative.stateChangedAt, 500);
    const row = rowOf(db, "i-q");
    assert.strictEqual(row.state, "cancelled");
    assert.strictEqual(row.finished_at, 500);
    assert.strictEqual(row.state_changed_at, 500);
  });

  it("waiting_human con pending_human_input → cancelled y se limpia el pending", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "i-wh", state: "waiting_human", summary: "¿procedo?",
      pending_human_input: "respuesta pendiente",
    });
    const ctl = control(db);

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-wh", now: 500 });

    assert.strictEqual(result.status, "cancelled");
    const row = rowOf(db, "i-wh");
    assert.strictEqual(row.state, "cancelled");
    assert.strictEqual(row.pending_human_input, null, "cancelar una Initiative no conserva respuesta pendiente");
    assert.strictEqual(row.finished_at, 500);
  });

  it("waiting_agent → cancelled por CAS", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-wa", state: "waiting_agent", chain_deadline_at: 999 });
    const ctl = control(db);

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-wa", now: 500 });

    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(rowOf(db, "i-wa").state, "cancelled");
    assert.strictEqual(rowOf(db, "i-wa").finished_at, 500);
  });

  it("repetir cancelled es éxito idempotente y no vuelve a escribir el terminal", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-c", state: "cancelled", finished_at: 100, state_changed_at: 100 });
    const ctl = control(db);

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-c", now: 500 });

    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(result.initiative.finishedAt, 100, "repetir cancelled no reescribe finished_at");
    assert.strictEqual(rowOf(db, "i-c").finished_at, 100);
    assert.strictEqual(rowOf(db, "i-c").state_changed_at, 100);
  });

  it("succeeded|failed|expired → INITIATIVE_STATE_CONFLICT sin escritura", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-s", state: "succeeded", finished_at: 100, result: "r" });
    insertInitiative(db, { id: "i-f", state: "failed", finished_at: 100, failure_reason: "x" });
    insertInitiative(db, { id: "i-e", state: "expired", finished_at: 100 });
    const ctl = control(db);

    for (const id of ["i-s", "i-f", "i-e"]) {
      assert.throws(
        () => ctl.cancelInitiative({ agentName: "alice", initiativeId: id, now: 500 }),
        isDomainError("INITIATIVE_STATE_CONFLICT"),
        `${id} no debe cancelarse`,
      );
    }
    assert.strictEqual(rowOf(db, "i-s").state, "succeeded");
    assert.strictEqual(rowOf(db, "i-f").state, "failed");
    assert.strictEqual(rowOf(db, "i-e").state, "expired");
  });

  it("inexistente → INITIATIVE_NOT_FOUND", () => {
    const db = openMemoryDb();
    assert.throws(
      () => control(db).cancelInitiative({ agentName: "alice", initiativeId: "no-existe", now: 500 }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
  });

  it("un ID de otro Agent es indistinguible de inexistente → INITIATIVE_NOT_FOUND", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "alice-i", agent_name: "alice", state: "queued" });
    const ctl = control(db);

    assert.throws(
      () => ctl.cancelInitiative({ agentName: "bob", initiativeId: "alice-i", now: 500 }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
    assert.strictEqual(rowOf(db, "alice-i").state, "queued", "la Initiative de Alice queda intacta");
  });

  it("running con turn_id y abort true → {status:'cancellation_requested'} y NINGÚN UPDATE a initiatives", () => {
    const raw = openMemoryDb();
    const { db, updates } = updateSpy(raw);
    insertInitiative(raw, { id: "i-run", state: "running", turn_id: "turn-1", started_at: 100 });
    const ctl = control(db, abortFake(() => true));

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-run", now: 200 });

    assert.strictEqual(result.status, "cancellation_requested");
    assert.strictEqual(result.initiative.state, "running", "la fila no se escribe: el terminal lo escribirá T6");
    assert.deepEqual(updates, [], "running NO se cancela con un write optimista");
    const row = rowOf(raw, "i-run");
    assert.strictEqual(row.state, "running");
    assert.strictEqual(row.turn_id, "turn-1");
    assert.strictEqual(row.finished_at, null);
  });

  it("running sin turn_id → INITIATIVE_INVARIANT_VIOLATION, abort no se llama y no hay UPDATE", () => {
    const raw = openMemoryDb();
    const { db, updates } = updateSpy(raw);
    insertInitiative(raw, { id: "i-run", state: "running", turn_id: null, started_at: 100 });
    let abortCalls = 0;
    const ctl = control(db, {
      abort: (): boolean => {
        abortCalls += 1;
        return true;
      },
    });

    assert.throws(
      () => ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-run", now: 200 }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    assert.strictEqual(abortCalls, 0, "sin turn_id no hay turno que abortar");
    assert.deepEqual(updates, []);
    assert.strictEqual(rowOf(raw, "i-run").state, "running");
  });

  it("running, abort=false y relectura ya cancelled → éxito idempotente sin UPDATE de Control", () => {
    const raw = openMemoryDb();
    const { db, updates } = updateSpy(raw);
    insertInitiative(raw, { id: "i-run", state: "running", turn_id: "turn-1", started_at: 100 });
    const ctl = control(db, {
      abort: (): boolean => {
        // T6 (u otro camino) ya escribió el terminal mientras tanto.
        raw.prepare(
          "UPDATE initiatives SET state='cancelled', finished_at=300, state_changed_at=300 WHERE id='i-run'",
        ).run();
        return false;
      },
    });

    const result = ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-run", now: 200 });

    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(result.initiative.state, "cancelled");
    assert.strictEqual(result.initiative.finishedAt, 300);
    assert.deepEqual(updates, [], "la cancelación la escribió T6, no Control");
  });

  it("running, abort=false y relectura cambió a otro estado → INITIATIVE_STATE_CONFLICT sin UPDATE", () => {
    const raw = openMemoryDb();
    const { db, updates } = updateSpy(raw);
    insertInitiative(raw, { id: "i-run", state: "running", turn_id: "turn-1", started_at: 100 });
    const ctl = control(db, {
      abort: (): boolean => {
        raw.prepare(
          "UPDATE initiatives SET state='succeeded', finished_at=300, state_changed_at=300, result='done' WHERE id='i-run'",
        ).run();
        return false;
      },
    });

    assert.throws(
      () => ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-run", now: 200 }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    assert.deepEqual(updates, []);
    assert.strictEqual(rowOf(raw, "i-run").state, "succeeded");
  });

  it("running, abort=false y relectura sigue running → INITIATIVE_STATE_CONFLICT (ventana connecting, P4) sin UPDATE", () => {
    const raw = openMemoryDb();
    const { db, updates } = updateSpy(raw);
    insertInitiative(raw, { id: "i-run", state: "running", turn_id: "turn-1", started_at: 100 });
    const ctl = control(db, abortFake(() => false));

    assert.throws(
      () => ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-run", now: 200 }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    assert.deepEqual(updates, [], "no se falsea una cancelación: la ventana connecting queda visible");
    assert.strictEqual(rowOf(raw, "i-run").state, "running");
  });

  it("CAS perdido: queued se vuelve running entre la lectura de Control y el CAS → INITIATIVE_STATE_CONFLICT sin cancelación ficticia", () => {
    const raw = openMemoryDb();
    insertInitiative(raw, { id: "i-race", state: "queued", available_at: 100 });
    let mutated = false;
    const raced = raceDb(raw, () => {
      if (mutated) return;
      mutated = true;
      // El Loop gana la carrera antes de que el repositorio aplique el CAS.
      raw.prepare(
        "UPDATE initiatives SET state='running', turn_id='turn-race', state_changed_at=150 WHERE id='i-race'",
      ).run();
    });
    const ctl = control(raced);

    assert.throws(
      () => ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-race", now: 500 }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    assert.strictEqual(rowOf(raw, "i-race").state, "running", "la carrera no deja una cancelación ficticia");
    assert.strictEqual(rowOf(raw, "i-race").turn_id, "turn-race");
  });

  it("la Initiative cancelada se ve en la historia de la proyección, no en la agenda", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-q", state: "queued", available_at: 100 });
    const ctl = control(db);

    ctl.cancelInitiative({ agentName: "alice", initiativeId: "i-q", now: 500 });

    const snapshot = new AgendaRepository(db).projection.snapshotForAgent("alice", 600);
    assert.deepEqual(snapshot.agenda.map(({ initiative }) => initiative.id), [], "cancelada ya no está en la agenda");
    assert.strictEqual(snapshot.initiatives[0].state, "cancelled");
    assert.strictEqual(snapshot.initiatives[0].id, "i-q");
  });
});

describe("AutonomyControl.respondToInitiative (P1.6, plan P1 §6.3)", () => {
  it("respond feliz: waiting_human → queued con pending, key y hash; conserva sesión/modelo/intent", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "i-wh", state: "waiting_human", summary: "¿procedo?",
      session_key: "sk-sesion", bound_model: "gpt-5", intent: "pregunta al humano",
      state_changed_at: 100, available_at: 100,
    });
    const ctl = control(db);

    const result = ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "sí", idempotencyKey: "k-1", now: 500,
    });

    assert.strictEqual(result.replayed, false);
    assert.strictEqual(result.initiative.state, "queued");
    const row = rowOf(db, "i-wh");
    assert.strictEqual(row.state, "queued");
    assert.strictEqual(row.pending_human_input, "sí");
    assert.strictEqual(row.human_response_idempotency_key, "k-1");
    assert.strictEqual(row.human_response_command_hash, respondHash("i-wh", "sí"));
    assert.strictEqual(row.available_at, 500);
    assert.strictEqual(row.state_changed_at, 500);
    // §6.3: la respuesta llega al hilo que preguntó — misma sesión, mismo modelo.
    assert.strictEqual(row.session_key, "sk-sesion");
    assert.strictEqual(row.bound_model, "gpt-5");
    assert.strictEqual(row.intent, "pregunta al humano");
  });

  it("replay antes del claim: misma key y misma answer → replayed:true sin reencolar ni tocar disco", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "i-wh", state: "waiting_human", summary: "s", pending_human_input: "sí",
      human_response_idempotency_key: "k-1", human_response_command_hash: respondHash("i-wh", "sí"),
      available_at: 100, state_changed_at: 500,
    });
    const ctl = control(db);

    const result = ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "sí", idempotencyKey: "k-1", now: 900,
    });

    assert.strictEqual(result.replayed, true);
    // No se reencola otra vez: la fila no cambia su available_at/state_changed_at.
    const row = rowOf(db, "i-wh");
    assert.strictEqual(row.available_at, 100);
    assert.strictEqual(row.state_changed_at, 500);
    assert.strictEqual(row.pending_human_input, "sí");
  });

  it("replay después del claim: el claim consumió el pending pero la misma key sigue absorbiéndose sin reencolar", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-wh", state: "waiting_human", summary: "s", available_at: 100 });
    const ctl = control(db);
    // 1. Respuesta normal: waiting_human → queued con pending.
    const first = ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "respuesta", idempotencyKey: "k-1", now: 500,
    });
    assert.strictEqual(first.replayed, false);
    // 2. El Loop la reclamó: pending consumido, key/hash conservados (§6.4).
    const repo = new AgendaRepository(db);
    const claim = repo.claimInitiative({
      initiativeId: "i-wh", turnId: "turn-1", idempotencyKey: "idem-loop", now: 600,
    });
    assert.strictEqual(claim.dispatchInput, "respuesta");
    assert.strictEqual(rowOf(db, "i-wh").pending_human_input, null);
    assert.strictEqual(rowOf(db, "i-wh").human_response_idempotency_key, "k-1", "la key persiste tras el claim");

    // 3. El cliente perdió la respuesta HTTP y repite: replay, no segunda reanudación.
    const replay = ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "respuesta", idempotencyKey: "k-1", now: 700,
    });
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.initiative.state, "running", "no se vuelve a encolar ni toca el estado");
  });

  it("misma key con answer distinta → IDEMPOTENCY_CONFLICT", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "i-wh", state: "waiting_human", summary: "s",
      human_response_idempotency_key: "k-1", human_response_command_hash: respondHash("i-wh", "sí"),
    });
    const ctl = control(db);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-wh", answer: "NO, cancela", idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("IDEMPOTENCY_CONFLICT"),
    );
  });

  it("segundo respondedor: key nueva tras una respuesta ya absorbida → INITIATIVE_STATE_CONFLICT", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-wh", state: "waiting_human", summary: "s", available_at: 100 });
    const ctl = control(db);
    ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "primera", idempotencyKey: "k-1", now: 400,
    });

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-wh", answer: "segunda", idempotencyKey: "k-2", now: 500,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    // La primera respuesta sigue intacta: primera key gana.
    const row = rowOf(db, "i-wh");
    assert.strictEqual(row.pending_human_input, "primera");
    assert.strictEqual(row.human_response_idempotency_key, "k-1");
  });

  it("estado incorrecto con key nueva (queued sin respuesta previa) → INITIATIVE_STATE_CONFLICT", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-q", state: "queued", available_at: 100 });
    const ctl = control(db);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-q", answer: "sí", idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
  });

  it("estado incorrecto con key nueva (running) → INITIATIVE_STATE_CONFLICT", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-run", state: "running", turn_id: "t-1", started_at: 100 });
    const ctl = control(db);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-run", answer: "sí", idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
  });

  it("otro Agent es indistinguible de inexistente → INITIATIVE_NOT_FOUND", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "alice-wh", agent_name: "alice", state: "waiting_human", summary: "s" });
    const ctl = control(db);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "bob", initiativeId: "alice-wh", answer: "sí", idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
  });

  it("answer vacía o fuera del límite interno → INITIATIVE_INVARIANT_VIOLATION sin tocar la fila", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-wh", state: "waiting_human", summary: "s" });
    const ctl = control(db);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-wh", answer: "", idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-wh", answer: "x".repeat(4001), idempotencyKey: "k-1", now: 500,
      }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
    assert.strictEqual(rowOf(db, "i-wh").state, "waiting_human");
  });

  it("CAS perdido: la respuesta que pierde la carrera no deposita su pending ni su key", () => {
    const raw = openMemoryDb();
    insertInitiative(raw, { id: "i-race", state: "waiting_human", summary: "s", state_changed_at: 100 });
    let mutated = false;
    const raced = raceDb(raw, () => {
      if (mutated) return;
      mutated = true;
      // Otro respondedor gana la carrera entre la lectura y el CAS de este:
      // el estado durable deja de ser waiting_human.
      raw.prepare(
        `UPDATE initiatives
            SET state='queued', available_at=400, state_changed_at=400,
                pending_human_input='ganadora',
                human_response_idempotency_key='k-ganador',
                human_response_command_hash=?
          WHERE id='i-race'`,
      ).run(respondHash("i-race", "ganadora"));
    });
    const ctl = control(raced);

    assert.throws(
      () => ctl.respondToInitiative({
        agentName: "alice", initiativeId: "i-race", answer: "perdedora", idempotencyKey: "k-perdedor", now: 500,
      }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    // La respuesta del perdedor NO se depositó: el ROLLBACK no deja ni su
    // pending ni su key — la fila no lleva ningún vestigio del write perdido.
    const row = rowOf(raw, "i-race");
    assert.notStrictEqual(row.pending_human_input, "perdedora");
    assert.notStrictEqual(row.human_response_idempotency_key, "k-perdedor");
  });

  it("la Initiative respondida vuelve a la agenda de la proyección, no al inbox", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-wh", state: "waiting_human", summary: "s", available_at: 100 });
    const ctl = control(db);

    ctl.respondToInitiative({
      agentName: "alice", initiativeId: "i-wh", answer: "sí", idempotencyKey: "k-1", now: 500,
    });

    const snapshot = new AgendaRepository(db).projection.snapshotForAgent("alice", 600);
    assert.deepEqual(snapshot.inbox.map(({ id }) => id), [], "respondida ya no está en el inbox");
    assert.deepEqual(snapshot.agenda.map(({ initiative }) => initiative.id), ["i-wh"]);
    assert.strictEqual(snapshot.agenda[0].initiative.pendingHumanInput, "sí", "la proyección interna conserva el pending (sin redactar)");
  });
});
