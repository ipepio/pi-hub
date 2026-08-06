// P1.2 — AutonomyProjection transaccional y agent-scoped (plan P1 §3).
//
// La lectura que compartirán `/api/v1` y el panel. Se cruza **siempre** por
// `AgendaRepository.projection.snapshotForAgent`, nunca por `db` ni por un
// segundo camino de lectura (§3.4). Los invariantes convertidos en tests:
//
//   - agenda = solo `queued`, orden `(available_at, id)`, posiciones 1-based;
//   - inbox = solo `waiting_human`, orden `(state_changed_at, id)`;
//   - los no terminales nunca se truncan, la historia se acota con `LIMIT+1`;
//   - cada SELECT es agent-scoped (`agent_name = ?`), nunca carga global y
//     filtra en JS;
//   - una sola transacción `BEGIN` por snapshot: la fotografía es coherente
//     aunque otra conexión WAL confirme una mutación a mitad de lectura;
//   - rollback de lectura ante un SELECT fallido;
//   - los objetos internos NO se redactan aquí (P2 presentará por allowlist).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { openTestDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import type { InternalAutonomySnapshot } from "../src/agenda/autonomy-projection.ts";
import { DomainError } from "../src/agenda/errors.ts";

const openDbs: SqliteDb[] = [];
const tempDirs: string[] = [];

/** Fixture de `:memory:` con el esquema aplicado (patrón `agenda-initiatives.test.ts`). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

async function tmpDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-autonomy-projection-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

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
  human_question?: string | null;
  human_expires_at?: number | null;
  human_request_id?: string | null;
  pending_human_input?: string | null;
  human_response_idempotency_key?: string | null;
  human_response_command_hash?: string | null;
}

/** Siembra una fila `initiatives` (setup de fixture, no comportamiento bajo prueba). */
function insertInitiative(db: SqliteDb, seed: InitiativeSeed): void {
  const row = {
    id: seed.id,
    agent_name: seed.agent_name ?? "alice",
    state: seed.state ?? "queued",
    origin: seed.origin ?? "human",
    trigger_id: seed.trigger_id ?? null,
    intent: seed.intent ?? "di hola",
    mode: seed.mode ?? "solo",
    session_key: seed.session_key ?? "sk-1",
    available_at: seed.available_at ?? 1,
    bound_model: seed.bound_model ?? null,
    turn_id: seed.turn_id ?? null,
    chain_depth: seed.chain_depth ?? 0,
    chain_deadline_at: seed.chain_deadline_at ?? null,
    visible_effects_declared: seed.visible_effects_declared ?? 0,
    summary: seed.summary ?? null,
    ask_correlation: seed.ask_correlation ?? null,
    failure_reason: seed.failure_reason ?? null,
    result: seed.result ?? null,
    created_at: seed.created_at ?? 1000,
    state_changed_at: seed.state_changed_at ?? 1000,
    started_at: seed.started_at ?? null,
    finished_at: seed.finished_at ?? null,
    human_question: seed.human_question ?? null,
    human_expires_at: seed.human_expires_at ?? null,
    human_request_id: seed.human_request_id ?? null,
    pending_human_input: seed.pending_human_input ?? null,
    human_response_idempotency_key: seed.human_response_idempotency_key ?? null,
    human_response_command_hash: seed.human_response_command_hash ?? null,
  };
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at,
        human_question, human_expires_at, human_request_id, pending_human_input,
        human_response_idempotency_key, human_response_command_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.agent_name, row.state, row.origin, row.trigger_id, row.intent,
    row.mode, row.session_key, row.available_at, row.bound_model, row.turn_id,
    row.chain_depth, row.chain_deadline_at, row.visible_effects_declared,
    row.summary, row.ask_correlation, row.failure_reason, row.result,
    row.created_at, row.state_changed_at, row.started_at, row.finished_at,
    row.human_question, row.human_expires_at, row.human_request_id,
    row.pending_human_input, row.human_response_idempotency_key,
    row.human_response_command_hash,
  );
}

interface TriggerSeed {
  id: string;
  agent_name?: string;
  kind?: string;
  definition_json?: string;
  intent?: string;
  mode?: string;
  suggested_skill?: string | null;
  created_by?: string;
  authority?: string;
  proposal_state?: string | null;
  enabled?: number;
  next_fire_at?: number | null;
  last_fired_at?: number | null;
  created_at?: number;
  updated_at?: number;
  create_idempotency_key?: string | null;
  create_command_hash?: string | null;
}

/** Siembra una fila `triggers` (setup de fixture, no comportamiento bajo prueba). */
function insertTrigger(db: SqliteDb, seed: TriggerSeed): void {
  const row = {
    id: seed.id,
    agent_name: seed.agent_name ?? "alice",
    kind: seed.kind ?? "schedule",
    definition_json:
      seed.definition_json ??
      JSON.stringify({ version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" }),
    intent: seed.intent ?? "di hola",
    mode: seed.mode ?? "solo",
    suggested_skill: seed.suggested_skill ?? null,
    created_by: seed.created_by ?? "owner",
    authority: seed.authority ?? "owner",
    proposal_state: seed.proposal_state ?? null,
    enabled: seed.enabled ?? 1,
    next_fire_at: seed.next_fire_at ?? null,
    last_fired_at: seed.last_fired_at ?? null,
    created_at: seed.created_at ?? 1000,
    updated_at: seed.updated_at ?? 1000,
    create_idempotency_key: seed.create_idempotency_key ?? null,
    create_command_hash: seed.create_command_hash ?? null,
  };
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at, last_fired_at,
        created_at, updated_at, create_idempotency_key, create_command_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.agent_name, row.kind, row.definition_json, row.intent, row.mode,
    row.suggested_skill, row.created_by, row.authority, row.proposal_state,
    row.enabled, row.next_fire_at, row.last_fired_at, row.created_at,
    row.updated_at, row.create_idempotency_key, row.create_command_hash,
  );
}

/** Adapter de test alrededor de `SqliteDb` para instrumentar SELECTs y provocar fallos. */
function spyDb(
  db: SqliteDb,
  hooks: {
    onSelect?: (sql: string) => void;
    shouldFailSecondSelect?: () => boolean;
    afterFirstSelect?: () => void;
    onExec?: (sql: string) => void;
  } = {},
): SqliteDb {
  let selectCount = 0;
  return {
    exec(sql: string): void {
      hooks.onExec?.(sql);
      db.exec(sql);
    },
    close(): void {
      db.close();
    },
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const isSelect = /^\s*SELECT/i.test(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...args),
        run: (...args: unknown[]) => stmt.run(...args),
        all: (...args: unknown[]) => {
          if (!isSelect) return stmt.all(...args);
          hooks.onSelect?.(sql);
          selectCount += 1;
          if (selectCount === 2 && hooks.shouldFailSecondSelect?.()) {
            throw new Error("fallo sintético del segundo SELECT");
          }
          const result = stmt.all(...args);
          if (selectCount === 1) hooks.afterFirstSelect?.();
          return result;
        },
      };
    },
  };
}

function ids(snapshot: InternalAutonomySnapshot): string[] {
  return snapshot.initiatives.map((initiative) => initiative.id);
}

function agendaIds(snapshot: InternalAutonomySnapshot): string[] {
  return snapshot.agenda.map(({ initiative }) => initiative.id);
}

function inboxIds(snapshot: InternalAutonomySnapshot): string[] {
  return snapshot.inbox.map((initiative) => initiative.id);
}

describe("AutonomyProjection.snapshotForAgent (P1.2, plan P1 §3)", () => {
  it("agenda: mezcla los ocho estados; solo `queued` aparece en agenda, en (available_at, id), con posiciones 1-based", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-q1", state: "queued", available_at: 50, created_at: 100 });
    insertInitiative(db, { id: "i-q2", state: "queued", available_at: 10, created_at: 200 });
    insertInitiative(db, { id: "i-q3", state: "queued", available_at: 10, created_at: 150 });
    insertInitiative(db, { id: "i-r", state: "running", created_at: 300 });
    insertInitiative(db, { id: "i-wh", state: "waiting_human", summary: "resumen", created_at: 400 });
    insertInitiative(db, { id: "i-wa", state: "waiting_agent", created_at: 500 });
    insertInitiative(db, { id: "i-s", state: "succeeded", finished_at: 2000, created_at: 600 });
    insertInitiative(db, { id: "i-f", state: "failed", failure_reason: "x", finished_at: 3000, created_at: 700 });
    const repo = new AgendaRepository(db);

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.strictEqual(snapshot.asOf, 9000);
    assert.deepEqual(ids(snapshot), ["i-q1", "i-q3", "i-q2", "i-r", "i-wh", "i-wa", "i-f", "i-s"]);
    assert.deepEqual(agendaIds(snapshot), ["i-q2", "i-q3", "i-q1"]);
    assert.deepEqual(
      snapshot.agenda.map((entry) => entry.position),
      [1, 2, 3],
    );
    assert.strictEqual(snapshot.agenda[0].initiative.availableAt, 10);
    assert.strictEqual(snapshot.agenda[1].initiative.availableAt, 10);
    assert.strictEqual(snapshot.agenda[2].initiative.availableAt, 50);
    assert.strictEqual(snapshot.historyTruncated, false);
  });

  it("inbox: solo `waiting_human`; `waiting_agent` sigue en initiatives pero nunca en inbox", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "w1", state: "waiting_human", summary: "s1", state_changed_at: 300 });
    insertInitiative(db, { id: "w2", state: "waiting_human", summary: "s2", state_changed_at: 100 });
    insertInitiative(db, { id: "w3", state: "waiting_human", summary: "s3", state_changed_at: 100 });
    insertInitiative(db, { id: "wa", state: "waiting_agent", state_changed_at: 50 });
    const repo = new AgendaRepository(db);

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.deepEqual(inboxIds(snapshot), ["w2", "w3", "w1"]);
    assert.ok(ids(snapshot).includes("wa"), "waiting_agent presente en initiatives");
    assert.ok(!inboxIds(snapshot).includes("wa"), "waiting_agent nunca en inbox");
  });

  it("con historyLimit=2 los no terminales siguen presentes completos", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "live-1", state: "queued", session_key: "sk-live-1", pending_human_input: "pending-live-1" });
    insertInitiative(db, { id: "live-2", state: "running", bound_model: "bm-live-2", turn_id: "turn-live-2" });
    insertInitiative(db, { id: "live-3", state: "waiting_human", summary: "s3" });
    insertInitiative(db, { id: "live-4", state: "waiting_agent" });
    const repo = new AgendaRepository(db, { autonomyHistoryLimit: 2 });

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    for (const id of ["live-1", "live-2", "live-3", "live-4"]) {
      assert.ok(ids(snapshot).includes(id), `no terminal ${id} nunca se trunca`);
    }
    const live1 = snapshot.initiatives.find((initiative) => initiative.id === "live-1");
    assert.strictEqual(live1?.sessionKey, "sk-live-1");
    assert.strictEqual(live1?.pendingHumanInput, "pending-live-1");
    const live2 = snapshot.initiatives.find((initiative) => initiative.id === "live-2");
    assert.strictEqual(live2?.boundModel, "bm-live-2");
    assert.strictEqual(live2?.turnId, "turn-live-2");
  });

  it("historia acotada: límite 2 con 3 terminales devuelve los dos recientes y historyTruncated=true", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "t-1", state: "succeeded", finished_at: 1000 });
    insertInitiative(db, { id: "t-2", state: "failed", failure_reason: "x", finished_at: 3000 });
    insertInitiative(db, { id: "t-3", state: "cancelled", finished_at: 2000 });
    const repo = new AgendaRepository(db, { autonomyHistoryLimit: 2 });

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.deepEqual(ids(snapshot), ["t-2", "t-3"]);
    assert.strictEqual(snapshot.historyTruncated, true);
  });

  it("historia acotada: límite 2 con exactamente 2 terminales devuelve ambos y historyTruncated=false", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "t-1", state: "succeeded", finished_at: 1000 });
    insertInitiative(db, { id: "t-2", state: "failed", failure_reason: "x", finished_at: 3000 });
    const repo = new AgendaRepository(db, { autonomyHistoryLimit: 2 });

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.deepEqual(ids(snapshot), ["t-2", "t-1"]);
    assert.strictEqual(snapshot.historyTruncated, false);
  });

  it("scope SQL: cada SELECT lleva agent_name=? y el snapshot de Alice no contiene ningún sentinel de Bob", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "alice-ini-1", state: "queued", session_key: "SK_ALICE_SENTINEL",
      pending_human_input: "PENDING_ALICE_SENTINEL", bound_model: "MODEL_ALICE_SENTINEL",
      turn_id: "TURN_ALICE_SENTINEL", human_request_id: "HR_ALICE_SENTINEL",
      ask_correlation: "AC_ALICE_SENTINEL",
    });
    insertInitiative(db, {
      id: "bob-ini-1", agent_name: "bob", state: "queued", session_key: "SK_BOB_SENTINEL",
      pending_human_input: "PENDING_BOB_SENTINEL", bound_model: "MODEL_BOB_SENTINEL",
      turn_id: "TURN_BOB_SENTINEL", human_request_id: "HR_BOB_SENTINEL",
      ask_correlation: "AC_BOB_SENTINEL",
    });
    insertTrigger(db, { id: "trg-alice", agent_name: "alice", create_idempotency_key: "K_ALICE" });
    insertTrigger(db, { id: "trg-bob", agent_name: "bob", create_idempotency_key: "K_BOB" });

    const selects: string[] = [];
    const repo = new AgendaRepository(spyDb(db, { onSelect: (sql) => selects.push(sql) }));

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.strictEqual(selects.length, 3, "tres SELECTs: triggers, vivos, terminales");
    for (const sql of selects) {
      assert.ok(/agent_name\s*=\s*\?/.test(sql), `SELECT agent-scoped: ${sql}`);
    }
    const serialized = JSON.stringify(snapshot);
    assert.ok(serialized.includes("SK_ALICE_SENTINEL"));
    assert.ok(serialized.includes("trg-alice"));
    assert.ok(!serialized.includes("BOB_SENTINEL"), "ningún campo de Bob en el snapshot de Alice");
    assert.ok(!serialized.includes("trg-bob"), "ningún trigger de Bob en el snapshot de Alice");
    assert.deepEqual(snapshot.triggers.map((trigger) => trigger.id), ["trg-alice"]);
  });

  it("fotografía única: una mutación confirmada por otra conexión WAL a mitad de lectura no se ve en este snapshot", async () => {
    const dataDir = await tmpDataDir();
    const db = await openTestDb(dataDir);
    openDbs.push(db);
    insertInitiative(db, { id: "early", state: "queued", available_at: 1, created_at: 100 });

    const file = path.join(dataDir, "manager", "agenda.sqlite3");
    const second = new DatabaseSync(file);
    openDbs.push(second);
    second.exec("PRAGMA busy_timeout = 5000");

    let hookFired = false;
    const repo = new AgendaRepository(
      spyDb(db, {
        afterFirstSelect: () => {
          if (hookFired) return;
          hookFired = true;
          // Confirmada en la segunda conexión después del primer SELECT de la
          // proyección: el snapshot de la tx ya estaba fijado en ese instante.
          insertInitiative(second, {
            id: "late", state: "queued", available_at: 1, created_at: 200,
            session_key: "SK_LATE_SENTINEL",
          });
        },
      }),
    );

    const first = repo.projection.snapshotForAgent("alice", 9000);
    assert.deepEqual(ids(first), ["early"]);
    assert.deepEqual(agendaIds(first), ["early"]);
    assert.ok(!JSON.stringify(first).includes("SK_LATE_SENTINEL"));

    const after = repo.projection.snapshotForAgent("alice", 9000);
    assert.deepEqual(ids(after), ["early", "late"]);
    assert.deepEqual(agendaIds(after), ["early", "late"]);
  });

  it("rollback de lectura: un SELECT fallido provoca ROLLBACK y la siguiente llamada funciona", () => {
    const db = openMemoryDb();
    insertInitiative(db, { id: "i-1", state: "queued" });
    const execs: string[] = [];
    const state = { failSecond: true };
    const repo = new AgendaRepository(
      spyDb(db, {
        onExec: (sql) => execs.push(sql),
        shouldFailSecondSelect: () => state.failSecond,
      }),
    );

    assert.throws(
      () => repo.projection.snapshotForAgent("alice", 9000),
      /fallo sintético del segundo SELECT/,
    );
    assert.ok(execs.includes("ROLLBACK"), "se observa ROLLBACK tras el fallo de lectura");

    state.failSecond = false;
    const snapshot = repo.projection.snapshotForAgent("alice", 9000);
    assert.deepEqual(ids(snapshot), ["i-1"]);
  });

  it("interno, no HTTP: no se redactan sessionKey, pending input, boundModel, turnId ni correlación", () => {
    const db = openMemoryDb();
    insertInitiative(db, {
      id: "i-secret", state: "queued", session_key: "SK_SENTINEL_ALICE",
      pending_human_input: "PENDING_SENTINEL_ALICE", bound_model: "BOUND_SENTINEL_ALICE",
      turn_id: "TURN_SENTINEL_ALICE", human_request_id: "HR_SENTINEL_ALICE",
      ask_correlation: "ASK_SENTINEL_ALICE", summary: "SUMMARY_SENTINEL_ALICE",
      human_question: "QUESTION_SENTINEL_ALICE",
    });
    insertTrigger(db, { id: "trg-1", create_idempotency_key: "IDEM_KEY_SENTINEL", create_command_hash: "HASH_SENTINEL" });
    const repo = new AgendaRepository(db);

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    const initiative = snapshot.agenda[0].initiative;
    assert.strictEqual(initiative.sessionKey, "SK_SENTINEL_ALICE");
    assert.strictEqual(initiative.pendingHumanInput, "PENDING_SENTINEL_ALICE");
    assert.strictEqual(initiative.boundModel, "BOUND_SENTINEL_ALICE");
    assert.strictEqual(initiative.turnId, "TURN_SENTINEL_ALICE");
    assert.strictEqual(initiative.humanRequestId, "HR_SENTINEL_ALICE");
    assert.strictEqual(initiative.askCorrelation, "ASK_SENTINEL_ALICE");
    assert.strictEqual(initiative.humanQuestion, "QUESTION_SENTINEL_ALICE");
    assert.strictEqual((initiative as { toJSON?: unknown }).toJSON, undefined, "sin toJSON accidental");
    assert.strictEqual(snapshot.triggers[0].createIdempotencyKey, "IDEM_KEY_SENTINEL");
    assert.strictEqual(snapshot.triggers[0].createCommandHash, "HASH_SENTINEL");
  });

  it("un Agent sin filas devuelve snapshot vacío", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);

    const snapshot = repo.projection.snapshotForAgent("alice", 9000);

    assert.deepEqual(snapshot, {
      asOf: 9000,
      initiatives: [],
      agenda: [],
      inbox: [],
      triggers: [],
      historyTruncated: false,
    });
  });

  it("una fila de Trigger con definition_json ilegible aborta con STORAGE_CORRUPT", () => {
    const db = openMemoryDb();
    insertTrigger(db, { id: "trg-corrupt", definition_json: "{no es json}" });
    insertInitiative(db, { id: "i-1", state: "queued" });
    const repo = new AgendaRepository(db);

    assert.throws(
      () => repo.projection.snapshotForAgent("alice", 9000),
      (error: unknown) => error instanceof DomainError && error.code === "STORAGE_CORRUPT",
    );
  });
});
