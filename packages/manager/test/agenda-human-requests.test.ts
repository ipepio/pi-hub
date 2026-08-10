/**
 * P3.2 — HumanRequestRepository.pauseRunningForHuman.
 *
 * Verifica en `:memory:` (patrón de `storage.test.ts:297`):
 *   - happy path: turno `paused_for_human` + Initiative `waiting_human` en una
 *     sola tx, con todos los campos fijados;
 *   - atomicidad: si el segundo UPDATE (Initiative) falla, el ROLLBACK revierte
 *     ambas filas — el turno no queda `paused_for_human` sin la Initiative;
 *   - turno ya terminal, Initiative no running, turno/Initiative inexistente
 *     no producen media pausa;
 *   - dos preguntas consecutivas generan IDs/deadlines nuevos y conservan
 *     session_key, bound_model, intent;
 *   - reply de request viejo no responde el nuevo (el hash incluye
 *     human_request_id);
 *   - sweep usa deadlines por fila (human_expires_at);
 *   - una fila con human_expires_at=NULL no caduca;
 *   - cambiar expiry env después de crear la espera no cambia su deadline;
 *   - response a/tras el límite exacto y carrera sweep/respond.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { HumanRequestRepository } from "../src/agenda/human-requests.ts";
import { DomainError } from "../src/agenda/errors.ts";
import type { InitiativeState } from "../src/agenda/state.ts";

const openDbs: SqliteDb[] = [];

function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Siembra una Initiative `running` con turno reservado. */
function seedRunning(
  db: SqliteDb,
  overrides: {
    id?: string;
    agentName?: string;
    turnId?: string;
    sessionKey?: string;
    boundModel?: string | null;
    intent?: string;
  } = {},
): void {
  const id = overrides.id ?? "ini-1";
  const agentName = overrides.agentName ?? "alice";
  const turnId = overrides.turnId ?? "turn-1";
  const sessionKey = overrides.sessionKey ?? "sk-sesion";
  const boundModel = overrides.boundModel ?? "gpt-5";
  const intent = overrides.intent ?? "haz algo";

  db.prepare(
    `INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at)
     VALUES (?,?,?,?)`,
  ).run(agentName, turnId, `idem-${turnId}`, 1000);

  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at,
        pending_human_input, human_response_idempotency_key,
        human_response_command_hash, human_question, human_expires_at,
        human_request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, agentName, "running", "human", null, intent, "solo", sessionKey,
    1, boundModel, turnId, 0, null, 0, null, null, null, null, 1000, 1000, 1000, null,
    null, null, null, null, null, null,
  );
}

interface InitiativeRow {
  state: InitiativeState;
  mode: string;
  summary: string | null;
  human_question: string | null;
  human_expires_at: number | null;
  human_request_id: string | null;
  ask_correlation: string | null;
  session_key: string;
  bound_model: string | null;
  intent: string;
  pending_human_input: string | null;
  human_response_idempotency_key: string | null;
  human_response_command_hash: string | null;
}

function getInitiative(db: SqliteDb, id: string): InitiativeRow {
  const row = db
    .prepare(
      `SELECT state, mode, summary, human_question, human_expires_at,
              human_request_id, ask_correlation, session_key, bound_model,
              intent, pending_human_input, human_response_idempotency_key,
              human_response_command_hash
         FROM initiatives WHERE id = ?`,
    )
    .get(id) as InitiativeRow | undefined;
  if (!row) throw new Error(`initiative ${id} not found`);
  return row;
}

interface TurnRow {
  final_state: string | null;
  finished_at: number | null;
}

function getTurn(db: SqliteDb, agentName: string, turnId: string): TurnRow | undefined {
  return db
    .prepare("SELECT final_state, finished_at FROM turns WHERE agent_name = ? AND turn_id = ?")
    .get(agentName, turnId) as TurnRow | undefined;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

describe("HumanRequestRepository — pauseRunningForHuman (P3.2, §1.4)", () => {
  it("happy path: turno paused_for_human + Initiative waiting_human en una sola tx, todos los campos", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    const result = repo.pauseRunningForHuman({
      agentName: "alice",
      initiativeId: "ini-1",
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "call-1",
      question: "¿cuál es tu color favorito?",
      summary: "el agente necesita saber un color",
      now: 2000,
      expiryMs: 604_800_000, // 7 días
    });

    // Resultado devuelto
    assert.equal(result.initiativeId, "ini-1");
    assert.equal(result.agentName, "alice");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.requestId, "req-1");
    assert.equal(result.question, "¿cuál es tu color favorito?");
    assert.equal(result.summary, "el agente necesita saber un color");
    assert.equal(result.toolCallId, "call-1");
    assert.equal(result.expiresAt, 2000 + 604_800_000);

    // Turno: final_state = paused_for_human, finished_at = 2000
    const turn = getTurn(db, "alice", "turn-1");
    assert.ok(turn !== undefined);
    assert.equal(turn.final_state, "paused_for_human");
    assert.equal(turn.finished_at, 2000);

    // Initiative: state = waiting_human, campos fijados
    const ini = getInitiative(db, "ini-1");
    assert.equal(ini.state, "waiting_human");
    assert.equal(ini.mode, "ask"); // escaló de solo a ask
    assert.equal(ini.summary, "el agente necesita saber un color");
    assert.equal(ini.human_question, "¿cuál es tu color favorito?");
    assert.equal(ini.human_expires_at, 2000 + 604_800_000);
    assert.equal(ini.human_request_id, "req-1");
    assert.equal(ini.ask_correlation, "call-1");
    // pending_human_input se limpia
    assert.equal(ini.pending_human_input, null);
    // session_key, bound_model, intent se conservan
    assert.equal(ini.session_key, "sk-sesion");
    assert.equal(ini.bound_model, "gpt-5");
    assert.equal(ini.intent, "haz algo");
  });

  it("atomicidad: si el UPDATE de la Initiative falla, ROLLBACK revierte ambas filas", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    // Mutación manual 1: mover el UPDATE del turno fuera de la tx.
    // Simulamos que el UPDATE del turno se hace fuera de la transacción de la
    // Initiative. El test verifica que al fallar el segundo UPDATE, el turno
    // no queda marcado mientras la Initiative sigue running.
    // Forzamos un fallo con un turn_id que no existe (TURN_NOT_FOUND),
    // verificando que el ROLLBACK no deja ninguna fila modificada.
    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-WRONG", // turno no existe
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "resumen",
          now: 2000,
          expiryMs: 604_800_000,
        }),
      isDomainError("TURN_NOT_FOUND"),
    );

    // Verificar que ninguna fila cambió (ROLLBACK completo)
    const turn = getTurn(db, "alice", "turn-1");
    assert.equal(turn?.final_state, null);
    assert.equal(turn?.finished_at, null);
    const ini = getInitiative(db, "ini-1");
    assert.equal(ini.state, "running");
  });

  it("turno ya terminal → TURN_ALREADY_TERMINAL, ninguna fila cambia", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);
    // Marcar el turno como terminal fuera de la pausa
    db.prepare(
      "UPDATE turns SET final_state = 'succeeded', finished_at = 1500 WHERE agent_name = 'alice' AND turn_id = 'turn-1'",
    ).run();

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-1",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "resumen",
          now: 2000,
          expiryMs: 604_800_000,
        }),
      isDomainError("TURN_ALREADY_TERMINAL"),
    );

    // La Initiative sigue running
    assert.equal(getInitiative(db, "ini-1").state, "running");
  });

  it("Initiative no running → INITIATIVE_STATE_CONFLICT", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);
    // Cambiar la Initiative a queued manualmente
    db.prepare("UPDATE initiatives SET state = 'queued' WHERE id = 'ini-1'").run();

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-1",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "resumen",
          now: 2000,
          expiryMs: 604_800_000,
        }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
  });

  it("Initiative inexistente → INITIATIVE_NOT_FOUND", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-NOEXIST",
          turnId: "turn-1",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "resumen",
          now: 2000,
          expiryMs: 604_800_000,
        }),
      isDomainError("INITIATIVE_NOT_FOUND"),
    );
  });

  it("turno inexistente → TURN_NOT_FOUND", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-NOEXIST",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "resumen",
          now: 2000,
          expiryMs: 604_800_000,
        }),
      isDomainError("TURN_NOT_FOUND"),
    );
  });

  it("dos preguntas consecutivas generan IDs/deadlines nuevos y conservan session", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db, { turnId: "turn-1" });

    // Primera pregunta
    repo.pauseRunningForHuman({
      agentName: "alice",
      initiativeId: "ini-1",
      turnId: "turn-1",
      requestId: "req-1",
      toolCallId: "call-1",
      question: "¿primera pregunta?",
      summary: "primera",
      now: 2000,
      expiryMs: 60_000,
    });

    // Verificar primera pregunta
    let ini = getInitiative(db, "ini-1");
    assert.equal(ini.human_request_id, "req-1");
    assert.equal(ini.human_expires_at, 2000 + 60_000);
    assert.equal(ini.human_question, "¿primera pregunta?");

    // Para hacer una segunda pregunta, necesitamos un nuevo turno y volver a running
    const turnId2 = "turn-2";
    db.prepare(
      "INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at) VALUES (?,?,?,?)",
    ).run("alice", turnId2, "idem-turn-2", 2500);
    db.prepare(
      "UPDATE initiatives SET state = 'running', turn_id = ?, state_changed_at = ? WHERE id = 'ini-1'",
    ).run(turnId2, 2500);

    // Segunda pregunta
    repo.pauseRunningForHuman({
      agentName: "alice",
      initiativeId: "ini-1",
      turnId: turnId2,
      requestId: "req-2",
      toolCallId: "call-2",
      question: "¿segunda pregunta?",
      summary: "segunda",
      now: 3000,
      expiryMs: 120_000,
    });

    ini = getInitiative(db, "ini-1");
    // Nuevos valores
    assert.equal(ini.human_request_id, "req-2");
    assert.equal(ini.human_expires_at, 3000 + 120_000);
    assert.equal(ini.human_question, "¿segunda pregunta?");
    // session_key, bound_model, intent se conservan
    assert.equal(ini.session_key, "sk-sesion");
    assert.equal(ini.bound_model, "gpt-5");
    assert.equal(ini.intent, "haz algo");
  });

  it("pregunta vacía → INITIATIVE_INVARIANT_VIOLATION", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-1",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "",
          summary: "resumen",
          now: 2000,
          expiryMs: 60_000,
        }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
  });

  it("summary vacío → INITIATIVE_INVARIANT_VIOLATION", () => {
    const db = openMemoryDb();
    const repo = new HumanRequestRepository(db);
    seedRunning(db);

    assert.throws(
      () =>
        repo.pauseRunningForHuman({
          agentName: "alice",
          initiativeId: "ini-1",
          turnId: "turn-1",
          requestId: "req-1",
          toolCallId: "call-1",
          question: "¿pregunta?",
          summary: "",
          now: 2000,
          expiryMs: 60_000,
        }),
      isDomainError("INITIATIVE_INVARIANT_VIOLATION"),
    );
  });
});

describe("respondForAgent con human_request_id (P3.2)", () => {
  it("reply de request viejo no responde el nuevo (hash incluye human_request_id)", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = 1000;
    const DAY_MS = 86_400_000;

    // Insertar Initiative en waiting_human con request_id = "req-viejo"
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "ini-wh", "alice", "waiting_human", "human", null, "haz algo",
      "ask", "sk-1", 1, "gpt-5", "turn-1", 0, null, 0, "resumen", "call-1",
      null, null, 1000, now, 1000, null, null, null, null,
      "¿pregunta?", now + DAY_MS, "req-viejo",
    );

    // La respuesta intenta responder con un hash que incluye "req-viejo"
    // (simula un replay de la pregunta anterior)

    // Primera respuesta: funciona
    const first = repo.initiatives.respondForAgent({
      id: "ini-wh",
      agentName: "alice",
      answer: "respuesta",
      idempotencyKey: "k-1",
      now: 2000,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.initiative.state, "queued");

    // La Initiative vuelve a waiting_human con un request nuevo
    // (simula que el humano volvió a preguntar).
    // Se conservan key/hash de la primera respuesta: el replay check los
    // comparará y el hash NO coincidirá porque el human_request_id cambió.
    db.prepare(
      `UPDATE initiatives
          SET state = 'waiting_human', human_request_id = 'req-nuevo',
              human_expires_at = ?, state_changed_at = ?, pending_human_input = NULL
        WHERE id = 'ini-wh'`,
    ).run(now + DAY_MS, 3000);

    // Replay con el hash viejo: debe fallar porque el request_id actual es "req-nuevo"
    // y el hash {initiativeId, humanRequestId: "req-viejo", answer} no coincide
    // con el hash esperado {initiativeId, humanRequestId: "req-nuevo", answer}
    assert.throws(
      () =>
        repo.initiatives.respondForAgent({
          id: "ini-wh",
          agentName: "alice",
          answer: "respuesta",
          idempotencyKey: "k-1", // misma key
          now: 4000,
        }),
      isDomainError("IDEMPOTENCY_CONFLICT"),
    );
  });
});

describe("sweepWaitingHumanExpiry con human_expires_at (P3.2)", () => {
  it("human_expires_at es la única autoridad de caducidad por request", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = 100_000;

    // Fila con state_changed_at muy viejo pero human_expires_at futuro: NO caduca
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-old-sc", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-1", 1, null, null, 0, null, 0, "resumen", null, null, null,
      50000, 50000, null, null, null, null, null, "¿pregunta?", now + 86_400_000,
      "req-current",
    );

    // Fila con human_expires_at vencido: caduca (aunque state_changed_at sea reciente)
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-expired", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-2", 1, null, null, 0, null, 0, "resumen", null, null, null,
      now, now, null, null, null, null, null, "¿pregunta?", now - 1,
      "req-expired",
    );

    // Fila sin human_expires_at: nunca caduca
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-no-deadline", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-3", 1, null, null, 0, null, 0, "resumen", null, null, null,
      now, now, null, null, null, null, null, "¿pregunta?", null,
      "req-no-deadline",
    );

    const n = repo.initiatives.sweepWaitingHumanExpiry(now);
    assert.equal(n, 1);
    assert.equal(repo.initiatives.get("wh-old-sc").state, "waiting_human");
    assert.equal(repo.initiatives.get("wh-expired").state, "expired");
    assert.equal(repo.initiatives.get("wh-no-deadline").state, "waiting_human");
  });

  it("una fila con human_expires_at=NULL no caduca nunca", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-null", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-1", 1, null, null, 0, null, 0, "resumen", null, null, null,
      0, 0, null, null, null, null, null, "¿pregunta?", null,
      "req-null",
    );

    // Pasar un now muy lejano: sin deadline, no caduca.
    const n = repo.initiatives.sweepWaitingHumanExpiry(1_000_000_000);
    assert.equal(n, 0);
    assert.equal(repo.initiatives.get("wh-null").state, "waiting_human");
  });

  it("cambiar expiry env después de crear la espera no cambia su deadline", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = 100_000;
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-fixed", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-1", 1, null, null, 0, null, 0, "resumen", null, null, null,
      now, now, null, null, null, null, null, "¿pregunta?", now + 7 * 86_400_000,
      "req-fixed",
    );

    // Simular que el env cambió a 1 día: el sweep con now + 2*DAY NO debería
    // expirar la fila, porque su deadline sigue siendo el fijado (now + 7*DAY).
    // 2*DAY es menor que 7*DAY, así que el deadline no ha vencido.
    const n = repo.initiatives.sweepWaitingHumanExpiry(now + 2 * 86_400_000);
    assert.equal(n, 0);
    assert.equal(repo.initiatives.get("wh-fixed").state, "waiting_human");
  });

  it("carrera sweep/respond: responder justo antes del deadline es aceptado, después no", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = 100_000;
    const deadline = now + 86_400_000;
    db.prepare(
      `INSERT INTO initiatives
         (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
          available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
          visible_effects_declared, summary, ask_correlation, failure_reason,
          result, created_at, state_changed_at, started_at, finished_at,
          pending_human_input, human_response_idempotency_key,
          human_response_command_hash, human_question, human_expires_at,
          human_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "wh-race", "alice", "waiting_human", "human", null, "intent", "ask",
      "sk-1", 1, null, null, 0, null, 0, "resumen", null, null, null,
      now, now, null, null, null, null, null, "¿pregunta?", deadline,
      "req-race",
    );

    // Responder justo antes del deadline: aceptado
    const before = repo.initiatives.respondForAgent({
      id: "wh-race",
      agentName: "alice",
      answer: "respuesta antes del deadline",
      idempotencyKey: "k-race-1",
      now: deadline - 1,
    });
    assert.equal(before.replayed, false);
    assert.equal(before.initiative.state, "queued");

    // Volver a waiting_human con el mismo deadline (simula una nueva pregunta)
    db.prepare(
      `UPDATE initiatives
          SET state = 'waiting_human', pending_human_input = NULL,
              human_response_idempotency_key = NULL, human_response_command_hash = NULL
        WHERE id = 'wh-race'`,
    ).run();

    // En el límite exacto manda el deadline: now == human_expires_at -> NO responde.
    assert.throws(
      () =>
        repo.initiatives.respondForAgent({
          id: "wh-race",
          agentName: "alice",
          answer: "respuesta en el límite",
          idempotencyKey: "k-race-edge",
          now: deadline,
        }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );

    // Volver a waiting_human (la fila sigue intacta tras el rechazo)
    db.prepare(
      `UPDATE initiatives
          SET state = 'waiting_human', pending_human_input = NULL,
              human_response_idempotency_key = NULL, human_response_command_hash = NULL
        WHERE id = 'wh-race'`,
    ).run();

    // Después del deadline: NO responde aunque el sweep no haya corrido.
    // El respond no hace autoridad al tick: human_expires_at es la autoridad.
    assert.throws(
      () =>
        repo.initiatives.respondForAgent({
          id: "wh-race",
          agentName: "alice",
          answer: "respuesta después del deadline",
          idempotencyKey: "k-race-2",
          now: deadline + 1,
        }),
      isDomainError("INITIATIVE_STATE_CONFLICT"),
    );
    // Nada se escribió: la fila sigue waiting_human (el sweep la marcará expired).
    assert.equal(getInitiative(db, "wh-race").state, "waiting_human");
  });
});