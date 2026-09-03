// Fase 1 — almacén SQLite del Manager.
//
// Verifica los cimientos del diseño `docs/design-autonomia-agenda-sqlite.md`:
// ubicación del fichero, pragmas, versionado de migraciones y las restricciones
// `CHECK` y de integridad referencial que el diseño fija en las tablas
// `triggers`, `initiatives`, `callbacks` y `turns`.
//
// Desde la Fase 2.0, `ManagerStore` no expone `db` (Paso 0): los tests de DDL
// inspeccionan el esquema a través del fixture de solo-test `openTestDb`, que
// devuelve el `SqliteDb` crudo; los tests de comportamiento de Fase 2 cruzarán
// la interfaz del repositorio (`store.agenda`), nunca `db`.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openManagerStore,
  openTestDb,
  type ManagerStore,
  type SqliteDb,
} from "../src/storage/sqlite.ts";
import {
  runMigrations,
  MIGRATIONS,
  SCHEMA_VERSION,
  type Migration,
} from "../src/storage/migrations.ts";

const tempDirs: string[] = [];
const openStores: ManagerStore[] = [];
const openRawDbs: SqliteDb[] = [];

async function tmpDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-storage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const db of openRawDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

async function openStore(dataDir: string): Promise<ManagerStore> {
  const store = await openManagerStore(dataDir);
  openStores.push(store);
  return store;
}

/** Fixture de solo-test: `SqliteDb` crudo para inspeccionar pragmas, índices y `user_version`. */
async function openRaw(dataDir: string): Promise<SqliteDb> {
  const db = await openTestDb(dataDir);
  openRawDbs.push(db);
  return db;
}

interface TriggerRow {
  id: string;
  agent_name: string;
  kind: string;
  definition_json: string;
  intent: string;
  mode: string;
  suggested_skill: string | null;
  created_by: string;
  authority: string;
  proposal_state: string | null;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

function insertTrigger(
  db: SqliteDb,
  overrides: Partial<TriggerRow> = {},
): void {
  const row: TriggerRow = {
    id: "trg-1",
    agent_name: "alice",
    kind: "schedule",
    definition_json: "{}",
    intent: "di hola",
    mode: "solo",
    suggested_skill: null,
    created_by: "owner",
    authority: "owner",
    proposal_state: null,
    enabled: 1,
    next_fire_at: null,
    last_fired_at: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at, last_fired_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.agent_name,
    row.kind,
    row.definition_json,
    row.intent,
    row.mode,
    row.suggested_skill,
    row.created_by,
    row.authority,
    row.proposal_state,
    row.enabled,
    row.next_fire_at,
    row.last_fired_at,
    row.created_at,
    row.updated_at,
  );
}

interface InitiativeRow {
  id: string;
  agent_name: string;
  state: string;
  origin: string;
  trigger_id: string | null;
  intent: string;
  mode: string;
  session_key: string;
  available_at: number;
  bound_model: string | null;
  turn_id: string | null;
  chain_depth: number;
  chain_deadline_at: number | null;
  visible_effects_declared: number;
  summary: string | null;
  ask_correlation: string | null;
  failure_reason: string | null;
  result: string | null;
  created_at: number;
  state_changed_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function insertInitiative(
  db: SqliteDb,
  overrides: Partial<InitiativeRow> = {},
): void {
  const row: InitiativeRow = {
    id: "ini-1",
    agent_name: "alice",
    state: "queued",
    origin: "human",
    trigger_id: null,
    intent: "di hola",
    mode: "solo",
    session_key: "sk-1",
    available_at: 1,
    bound_model: null,
    turn_id: null,
    chain_depth: 0,
    chain_deadline_at: null,
    visible_effects_declared: 0,
    summary: null,
    ask_correlation: null,
    failure_reason: null,
    result: null,
    created_at: 1000,
    state_changed_at: 1000,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key, available_at,
        bound_model, turn_id, chain_depth, chain_deadline_at, visible_effects_declared, summary,
        ask_correlation, failure_reason, result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.agent_name,
    row.state,
    row.origin,
    row.trigger_id,
    row.intent,
    row.mode,
    row.session_key,
    row.available_at,
    row.bound_model,
    row.turn_id,
    row.chain_depth,
    row.chain_deadline_at,
    row.visible_effects_declared,
    row.summary,
    row.ask_correlation,
    row.failure_reason,
    row.result,
    row.created_at,
    row.state_changed_at,
    row.started_at,
    row.finished_at,
  );
}

interface CallbackRow {
  id: string;
  parent_id: string;
  result: string;
  created_at: number;
}

function insertCallback(
  db: SqliteDb,
  overrides: Partial<CallbackRow> = {},
): void {
  const row: CallbackRow = {
    id: "cb-1",
    parent_id: "parent-1",
    result: "{}",
    created_at: 1000,
    ...overrides,
  };
  db.prepare(
    "INSERT INTO callbacks (id, parent_id, result, created_at) VALUES (?,?,?,?)",
  ).run(row.id, row.parent_id, row.result, row.created_at);
}

interface TurnRow {
  agent_name: string;
  turn_id: string;
  idempotency_key: string;
  final_state: string | null;
  result: string | null;
  claimed_at: number;
  finished_at: number | null;
}

function insertTurn(db: SqliteDb, overrides: Partial<TurnRow> = {}): void {
  const row: TurnRow = {
    agent_name: "alice",
    turn_id: "turn-1",
    idempotency_key: "idem-1",
    final_state: null,
    result: null,
    claimed_at: 1000,
    finished_at: null,
    ...overrides,
  };
  db.prepare(
    "INSERT INTO turns (agent_name, turn_id, idempotency_key, final_state, result, claimed_at, finished_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    row.agent_name,
    row.turn_id,
    row.idempotency_key,
    row.final_state,
    row.result,
    row.claimed_at,
    row.finished_at,
  );
}

function userVersion(db: SqliteDb): number {
  return Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
}

function indexSql(db: SqliteDb, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  assert.ok(row, `índice ${name} presente con DDL`);
  return (row as { sql: string }).sql;
}

function tableColumns(db: SqliteDb, table: string): Array<{ name: string }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
}

function tableExists(db: SqliteDb, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

function indexExists(db: SqliteDb, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function countRows(db: SqliteDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

/** node:sqlite devuelve objetos con `null` prototype; `deepEqual` estricto compara prototypes. */
const plain = <T extends object>(row: T): T => ({ ...row });

/** Base v1 sembrada con las cuatro tablas y los ocho estados de Initiative State. */
function seedV1Base(db: SqliteDb): void {
  insertTrigger(db, { id: "trg-owner" });
  insertTrigger(db, {
    id: "trg-control",
    created_by: "control_plane",
    authority: "control_plane",
  });
  insertInitiative(db, { id: "i-queued", state: "queued" });
  insertInitiative(db, { id: "i-running", state: "running" });
  insertInitiative(db, {
    id: "i-waiting-human",
    state: "waiting_human",
    summary: "resumen",
    state_changed_at: 5000,
  });
  insertInitiative(db, { id: "i-waiting-agent", state: "waiting_agent" });
  insertInitiative(db, {
    id: "i-succeeded",
    state: "succeeded",
    finished_at: 2000,
  });
  insertInitiative(db, { id: "i-failed", state: "failed", finished_at: 3000 });
  insertInitiative(db, {
    id: "i-expired",
    state: "expired",
    finished_at: 4000,
  });
  insertInitiative(db, {
    id: "i-cancelled",
    state: "cancelled",
    finished_at: 5000,
  });
  insertInitiative(db, { id: "cb-1", origin: "callback" });
  insertInitiative(db, { id: "parent-1", origin: "human" });
  insertCallback(db, { id: "cb-1", parent_id: "parent-1" });
  insertTurn(db, {
    turn_id: "turn-a",
    idempotency_key: "idem-a",
    final_state: "succeeded",
    finished_at: 2000,
  });
  insertTurn(db, { turn_id: "turn-b", idempotency_key: "idem-b" });
}

const HUMAN_EXPIRY_MS = 604800000;

const normaliseSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("almacén SQLite del Manager", () => {
  it("crea la base en ${dataDir}/manager/agenda.sqlite3", async () => {
    const dataDir = await tmpDataDir();
    const store = await openStore(dataDir);
    assert.strictEqual(
      store.file,
      path.join(dataDir, "manager", "agenda.sqlite3"),
    );
    await assert.doesNotReject(fs.access(store.file));
  });

  it("aplica los pragmas obligatorios (foreign_keys y WAL)", async () => {
    const db = await openRaw(await tmpDataDir());
    const fk = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    assert.strictEqual(fk.foreign_keys, 1);
    const journal = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    assert.strictEqual(journal.journal_mode, "wal");
  });

  it("crea las tablas y los índices declarados", async () => {
    const db = await openRaw(await tmpDataDir());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const name of [
      "triggers",
      "initiatives",
      "callbacks",
      "turns",
      "human_request_deliveries",
      "runtime_admission",
    ]) {
      assert.ok(
        tables.some((t) => t.name === name),
        `tabla ${name} presente`,
      );
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const expected = [
      "schedule_triggers_due",
      "initiatives_due",
      "initiatives_waiting_human_expiry",
      "initiatives_chain_deadline_due",
      "initiatives_running_at_startup",
      "initiatives_by_turn",
      "callbacks_by_parent",
      "triggers_create_idempotency",
      "triggers_by_agent",
      "initiatives_human_request",
      "initiatives_autonomy_live",
      "initiatives_autonomy_history",
      "human_request_deliveries_by_initiative",
    ];
    for (const name of expected) {
      assert.ok(
        indexes.some((i) => i.name === name),
        `índice ${name} presente`,
      );
    }
  });

  it("los índices parciales llevan el predicado WHERE del diseño", async () => {
    const db = await openRaw(await tmpDataDir());
    const predicates: Record<string, string> = {
      schedule_triggers_due:
        "WHERE enabled = 1 AND kind = 'schedule' AND (proposal_state IS NULL OR proposal_state = 'approved')",
      initiatives_due: "WHERE state = 'queued'",
      initiatives_chain_deadline_due:
        "WHERE state IN ('queued', 'running', 'waiting_agent', 'waiting_human')",
      initiatives_by_turn: "WHERE turn_id IS NOT NULL",
      triggers_create_idempotency: "WHERE create_idempotency_key IS NOT NULL",
      initiatives_human_request: "WHERE human_request_id IS NOT NULL",
      initiatives_autonomy_live:
        "WHERE state IN ('queued','running','waiting_human','waiting_agent')",
      initiatives_autonomy_history:
        "WHERE state IN ('succeeded','failed','expired','cancelled')",
    };
    for (const [name, predicate] of Object.entries(predicates)) {
      const sql = normaliseSql(indexSql(db, name));
      assert.ok(
        sql.includes(predicate),
        `índice ${name} con predicado \`${predicate}\`, era \`${sql}\``,
      );
    }
  });

  it("aplica la migración una vez y es idempotente al reabrir", async () => {
    const dataDir = await tmpDataDir();
    const first = await openRaw(dataDir);
    assert.strictEqual(userVersion(first), SCHEMA_VERSION);
    insertTrigger(first, { id: "trg-persistente" });
    first.close();
    openRawDbs.splice(openRawDbs.indexOf(first), 1);

    const second = await openRaw(dataDir);
    assert.strictEqual(userVersion(second), SCHEMA_VERSION);
    const rows = second
      .prepare("SELECT id FROM triggers WHERE id = ?")
      .all("trg-persistente") as Array<{ id: string }>;
    assert.strictEqual(rows.length, 1);
  });

  it("aborta el arranque si la versión en disco supera la soportada", async () => {
    const dataDir = await tmpDataDir();
    const dir = path.join(dataDir, "manager");
    await fs.mkdir(dir, { recursive: true });
    const raw = new DatabaseSync(path.join(dir, "agenda.sqlite3"));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    await assert.rejects(openManagerStore(dataDir), /supera el soportado/);
  });

  it("revierte la migración completa si una versión falla a mitad", () => {
    const db = new DatabaseSync(":memory:");
    const migrations: readonly Migration[] = [
      {
        version: 1,
        up: (d) => {
          d.exec("CREATE TABLE should_rollback (x INTEGER)");
          d.exec("ESTA SENTENCIA NO ES SQL");
        },
      },
    ];
    assert.throws(() => runMigrations(db, migrations));
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    assert.strictEqual(version, 0);
    const exists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
      )
      .get();
    assert.strictEqual(exists, undefined);
    db.close();
  });

  it("no confirma la versión de una migración que falla tras versiones anteriores aplicadas", () => {
    const db = new DatabaseSync(":memory:");
    const migrations: readonly Migration[] = [
      { version: 1, up: (d) => d.exec("CREATE TABLE t1 (x INTEGER)") },
      {
        version: 2,
        up: (d) => {
          d.exec("CREATE TABLE t2 (x INTEGER)");
          d.exec("ESTA SENTENCIA NO ES SQL");
        },
      },
    ];
    assert.throws(() => runMigrations(db, migrations));
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    assert.strictEqual(version, 1);
    const t2 = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't2'",
      )
      .get();
    assert.strictEqual(t2, undefined);
    db.close();
  });

  it("un Manager schema1 simulado rechaza un volumen ya migrado a schema2", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA user_version = 2");
    assert.throws(
      () => runMigrations(db, MIGRATIONS, 1),
      /supera el soportado/,
    );
    db.close();
  });

  describe("migración v1 → v3", () => {
    it("una instalación nueva termina en el último schema con forma, índices y constraints", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.strictEqual(SCHEMA_VERSION, 3);
      assert.strictEqual(userVersion(db), 3);

      const triggersCols = tableColumns(db, "triggers").map((c) => c.name);
      for (const col of ["create_idempotency_key", "create_command_hash"]) {
        assert.ok(
          triggersCols.includes(col),
          `columna triggers.${col} presente`,
        );
      }
      const initiativesCols = tableColumns(db, "initiatives").map(
        (c) => c.name,
      );
      for (const col of [
        "human_question",
        "human_expires_at",
        "human_request_id",
        "pending_human_input",
        "human_response_idempotency_key",
        "human_response_command_hash",
      ]) {
        assert.ok(
          initiativesCols.includes(col),
          `columna initiatives.${col} presente`,
        );
      }

      for (const table of ["human_request_deliveries", "runtime_admission"]) {
        assert.ok(tableExists(db, table), `tabla ${table} presente`);
      }

      const admission = db
        .prepare("SELECT singleton, state, changed_at FROM runtime_admission")
        .all() as Array<{
        singleton: number;
        state: string;
        changed_at: number;
      }>;
      assert.deepEqual(admission.map(plain), [
        { singleton: 1, state: "open", changed_at: 0 },
      ]);
    });

    it("schema v2 conserva los CHECK de v1 y amplía turns a paused_for_human", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, {
        id: "a",
        created_by: "agent",
        proposal_state: "proposed",
      });
      assert.throws(() => insertTrigger(db, { id: "b", created_by: "grupo" }));
      insertInitiative(db, {
        id: "wh",
        state: "waiting_human",
        summary: "resumen",
      });
      assert.throws(() => insertInitiative(db, { id: "x", state: "pending" }));
      insertTurn(db, { final_state: "paused_for_human" });
      assert.throws(() =>
        insertTurn(db, {
          turn_id: "t2",
          idempotency_key: "k2",
          final_state: "running",
        }),
      );
    });

    it("human_request_deliveries aplica CHECK de canal, FKs y unicidades", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "ini-1" });
      const insert = db.prepare(
        `INSERT INTO human_request_deliveries
           (human_request_id, agent_name, initiative_id, channel, external_chat_id, external_message_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      );
      insert.run("hr-1", "alice", "ini-1", "telegram", "chat-1", "msg-1", 1000);
      assert.throws(() =>
        insert.run(
          "hr-1",
          "alice",
          "ini-1",
          "telegram",
          "chat-2",
          "msg-2",
          1000,
        ),
      );
      assert.throws(() =>
        insert.run(
          "hr-2",
          "alice",
          "ini-1",
          "telegram",
          "chat-1",
          "msg-1",
          1000,
        ),
      );
      assert.throws(() =>
        insert.run("hr-3", "alice", "ini-1", "slack", "chat-3", "msg-3", 1000),
      );
      assert.throws(() =>
        insert.run(
          "hr-4",
          "alice",
          "ini-inexistente",
          "telegram",
          "chat-4",
          "msg-4",
          1000,
        ),
      );
    });

    it("runtime_admission es singleton y rechaza estados fuera de open/draining", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() =>
        db.exec(
          "INSERT INTO runtime_admission(singleton,state,changed_at) VALUES (1,'open',1)",
        ),
      );
      assert.throws(() =>
        db.exec(
          "INSERT INTO runtime_admission(singleton,state,changed_at) VALUES (2,'open',1)",
        ),
      );
      assert.throws(() =>
        db.exec("UPDATE runtime_admission SET state = 'bogus'"),
      );
      db.exec("UPDATE runtime_admission SET state = 'draining'");
    });

    it("migra una base v1 conservando contenido, backfilleando human_expires_at y reconstruyendo turns", () => {
      const db = new DatabaseSync(":memory:");
      runMigrations(db, [MIGRATIONS[0]]);
      assert.strictEqual(userVersion(db), 1);
      seedV1Base(db);

      const v2 = MIGRATIONS.find((m) => m.version === 2)!;
      runMigrations(db, [v2]);
      assert.strictEqual(userVersion(db), 2);

      const trg = db
        .prepare(
          "SELECT id, created_by, authority, create_idempotency_key, create_command_hash FROM triggers WHERE id = ?",
        )
        .get("trg-owner") as {
        id: string;
        created_by: string;
        authority: string;
        create_idempotency_key: string | null;
        create_command_hash: string | null;
      };
      assert.deepEqual(plain(trg), {
        id: "trg-owner",
        created_by: "owner",
        authority: "owner",
        create_idempotency_key: null,
        create_command_hash: null,
      });

      const expires = db
        .prepare("SELECT human_expires_at FROM initiatives WHERE id = ?")
        .get("i-waiting-human") as { human_expires_at: number | null };
      assert.strictEqual(expires.human_expires_at, 5000 + HUMAN_EXPIRY_MS);
      const noBackfill = db
        .prepare(
          "SELECT human_expires_at FROM initiatives WHERE id IN (?,?,?,?,?,?,?) ORDER BY id",
        )
        .all(
          "i-queued",
          "i-running",
          "i-waiting-agent",
          "i-succeeded",
          "i-failed",
          "i-expired",
          "i-cancelled",
        ) as Array<{ human_expires_at: number | null }>;
      assert.strictEqual(noBackfill.length, 7);
      for (const row of noBackfill)
        assert.strictEqual(row.human_expires_at, null);

      const wh = db
        .prepare(
          "SELECT human_question, human_request_id, pending_human_input, human_response_idempotency_key, human_response_command_hash FROM initiatives WHERE id = ?",
        )
        .get("i-waiting-human") as Record<string, null>;
      assert.deepEqual(plain(wh), {
        human_question: null,
        human_request_id: null,
        pending_human_input: null,
        human_response_idempotency_key: null,
        human_response_command_hash: null,
      });

      const run = db
        .prepare(
          "SELECT state, summary, state_changed_at, finished_at FROM initiatives WHERE id = ?",
        )
        .get("i-waiting-human") as {
        state: string;
        summary: string;
        state_changed_at: number;
        finished_at: number | null;
      };
      assert.deepEqual(plain(run), {
        state: "waiting_human",
        summary: "resumen",
        state_changed_at: 5000,
        finished_at: null,
      });

      const cb = db
        .prepare(
          "SELECT id, parent_id, result, created_at FROM callbacks WHERE id = ?",
        )
        .get("cb-1") as {
        id: string;
        parent_id: string;
        result: string;
        created_at: number;
      };
      assert.deepEqual(plain(cb), {
        id: "cb-1",
        parent_id: "parent-1",
        result: "{}",
        created_at: 1000,
      });

      const turns = db
        .prepare(
          "SELECT agent_name, turn_id, idempotency_key, final_state, result, claimed_at, finished_at FROM turns ORDER BY turn_id",
        )
        .all() as Array<{
        agent_name: string;
        turn_id: string;
        idempotency_key: string;
        final_state: string | null;
        result: string | null;
        claimed_at: number;
        finished_at: number | null;
      }>;
      assert.deepEqual(turns.map(plain), [
        {
          agent_name: "alice",
          turn_id: "turn-a",
          idempotency_key: "idem-a",
          final_state: "succeeded",
          result: null,
          claimed_at: 1000,
          finished_at: 2000,
        },
        {
          agent_name: "alice",
          turn_id: "turn-b",
          idempotency_key: "idem-b",
          final_state: null,
          result: null,
          claimed_at: 1000,
          finished_at: null,
        },
      ]);
      assert.strictEqual(countRows(db, "runtime_admission"), 1);

      db.close();
    });

    it("migra una base v2 → v3 conservando contenido, relaja el CHECK de agente y rehace índices", () => {
      const db = new DatabaseSync(":memory:");
      runMigrations(db, [MIGRATIONS[0], MIGRATIONS[1]]);
      assert.strictEqual(userVersion(db), 2);
      // Datos v2: una fila de agente con propuesta (válida v2), un trigger
      // referenciado por una Initiative (para probar la FK durante el rebuild).
      seedV1Base(db);
      insertTrigger(db, {
        id: "trg-agent-proposed",
        created_by: "agent",
        authority: "control_plane",
        proposal_state: "proposed",
      });
      insertInitiative(db, {
        id: "i-refs-trigger",
        origin: "trigger",
        trigger_id: "trg-owner",
      });

      const v3 = MIGRATIONS.find((m) => m.version === 3)!;
      runMigrations(db, [v3]);

      assert.strictEqual(userVersion(db), 3);
      assert.strictEqual(countRows(db, "triggers"), 3);
      assert.strictEqual(countRows(db, "initiatives"), 11);

      // Contenido conservado (idempotency_key incluida).
      const kept = db
        .prepare(
          "SELECT id, created_by, authority, proposal_state, create_idempotency_key FROM triggers WHERE id = ?",
        )
        .get("trg-owner") as Record<string, string | null>;
      assert.deepEqual(plain(kept), {
        id: "trg-owner",
        created_by: "owner",
        authority: "owner",
        proposal_state: null,
        create_idempotency_key: null,
      });

      // Índices v3 recreados.
      for (const name of [
        "schedule_triggers_due",
        "triggers_by_agent",
        "triggers_create_idempotency",
      ]) {
        assert.ok(indexExists(db, name), `índice ${name} presente tras v3`);
      }

      // Nuevo CHECK: agente activo con proposal_state NULL ya es válido.
      insertTrigger(db, {
        id: "trg-agent-active",
        created_by: "agent",
        authority: "agent",
        proposal_state: null,
      });
      insertTrigger(db, {
        id: "trg-agent-proposed-v2",
        created_by: "agent",
        authority: "agent",
        proposal_state: "proposed",
      });
      assert.throws(() =>
        insertTrigger(db, {
          id: "trg-bad",
          created_by: "owner",
          proposal_state: "proposed",
        }),
      );
      assert.throws(() =>
        insertTrigger(db, {
          id: "trg-bad2",
          created_by: "agent",
          authority: "root",
        }),
      );

      // La FK a triggers sigue RESTRICT tras el rebuild.
      assert.throws(() =>
        db.exec("DELETE FROM triggers WHERE id = 'trg-owner'"),
      );

      db.close();
    });

    it("una sentencia fallida a mitad de v2 revierte a v1 sin columnas, tablas ni índices v2", () => {
      const db = new DatabaseSync(":memory:");
      runMigrations(db, [MIGRATIONS[0]]);
      assert.strictEqual(userVersion(db), 1);
      seedV1Base(db);

      const realV2Up = MIGRATIONS.find((m) => m.version === 2)!.up;
      const wrapped: Migration = {
        version: 2,
        up: (d) => {
          realV2Up(d);
          d.exec("ESTA SENTENCIA NO ES SQL");
        },
      };
      assert.throws(() => runMigrations(db, [wrapped]));

      assert.strictEqual(userVersion(db), 1);

      const triggersCols = tableColumns(db, "triggers").map((c) => c.name);
      assert.ok(
        !triggersCols.includes("create_idempotency_key"),
        "sin columna v2 en triggers",
      );
      assert.ok(
        !triggersCols.includes("create_command_hash"),
        "sin columna v2 en triggers",
      );
      const initiativesCols = tableColumns(db, "initiatives").map(
        (c) => c.name,
      );
      for (const col of [
        "human_question",
        "human_expires_at",
        "human_request_id",
        "pending_human_input",
        "human_response_idempotency_key",
        "human_response_command_hash",
      ]) {
        assert.ok(
          !initiativesCols.includes(col),
          `sin columna v2 initiatives.${col}`,
        );
      }
      for (const table of ["human_request_deliveries", "runtime_admission"]) {
        assert.ok(!tableExists(db, table), `sin tabla v2 ${table}`);
      }
      for (const name of [
        "triggers_create_idempotency",
        "triggers_by_agent",
        "initiatives_human_request",
        "initiatives_autonomy_live",
        "initiatives_autonomy_history",
        "human_request_deliveries_by_initiative",
      ]) {
        assert.ok(!indexExists(db, name), `sin índice v2 ${name}`);
      }

      assert.throws(() =>
        insertTurn(db, {
          turn_id: "t3",
          idempotency_key: "idem-c",
          final_state: "paused_for_human",
        }),
      );

      assert.strictEqual(countRows(db, "triggers"), 2);
      assert.strictEqual(countRows(db, "initiatives"), 10);
      assert.strictEqual(countRows(db, "callbacks"), 1);
      assert.strictEqual(countRows(db, "turns"), 2);

      db.close();
    });

    it("un fallo DESPUÉS de fijar user_version revierte la versión (atomicidad real)", () => {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA user_version = 1");
      const m: Migration = {
        version: 2,
        up: (d) => {
          d.exec("CREATE TABLE t (x INTEGER)");
          d.exec("PRAGMA user_version = 2");
          d.exec("ESTA SENTENCIA NO ES SQL");
        },
      };
      assert.throws(() => runMigrations(db, [m]));
      assert.strictEqual(
        userVersion(db),
        1,
        "user_version revertido a 1: la versión es atómica con la tx",
      );
      assert.strictEqual(
        tableExists(db, "t"),
        false,
        "el DDL también se revierte",
      );
      db.close();
    });

    it("reabrir un volumen ya migrado al último schema no re-aplica la migración", async () => {
      const dataDir = await tmpDataDir();
      const first = await openRaw(dataDir);
      assert.strictEqual(userVersion(first), 3);
      insertTrigger(first, { id: "trg-keep" });
      first
        .prepare("UPDATE triggers SET create_idempotency_key = ? WHERE id = ?")
        .run("k-1", "trg-keep");
      first.close();
      openRawDbs.splice(openRawDbs.indexOf(first), 1);

      const second = await openRaw(dataDir);
      assert.strictEqual(userVersion(second), 3);
      assert.ok(tableExists(second, "runtime_admission"));
      assert.ok(tableExists(second, "human_request_deliveries"));
      const kept = second
        .prepare("SELECT id, create_idempotency_key FROM triggers WHERE id = ?")
        .all("trg-keep") as Array<{
        id: string;
        create_idempotency_key: string | null;
      }>;
      assert.deepEqual(kept.map(plain), [
        { id: "trg-keep", create_idempotency_key: "k-1" },
      ]);
    });

    it("F9/R1-013: la v3 usa lista de columnas explícita y conserva idempotencia en su columna", () => {
      const db = new DatabaseSync(":memory:");
      runMigrations(db, [MIGRATIONS[0], MIGRATIONS[1]]);
      // Fila v2 con idempotencia + hash (columnas de la Fase 2) para detección
      // de mezcla de columnas en el rebuild v3.
      db.prepare(
        `INSERT INTO triggers
                (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
                 created_by, authority, proposal_state, enabled, next_fire_at, last_fired_at,
                 created_at, updated_at, create_idempotency_key, create_command_hash)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "t-idem",
        "alice",
        "schedule",
        JSON.stringify({
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        }),
        "intent",
        "solo",
        null,
        "owner",
        "owner",
        null,
        1,
        1,
        null,
        1000,
        1000,
        "idem-key-007",
        "hash-abc",
      );
      const v3 = MIGRATIONS.find((m) => m.version === 3)!;
      runMigrations(db, [v3]);
      const row = db
        .prepare(
          "SELECT id, create_idempotency_key, create_command_hash, created_by, authority FROM triggers WHERE id = ?",
        )
        .get("t-idem") as Record<string, string | null>;
      assert.deepEqual(plain(row), {
        id: "t-idem",
        create_idempotency_key: "idem-key-007",
        create_command_hash: "hash-abc",
        created_by: "owner",
        authority: "owner",
      });
      db.close();
    });

    it("F6/R1-010: foreign_key_check dentro de la tx revierte la migración que deja violaciones de FK", () => {
      const db = new DatabaseSync(":memory:");
      runMigrations(db, [MIGRATIONS[0]]);
      const m: Migration = {
        version: 2,
        disableForeignKeys: true,
        up: (d) => {
          // Con FKs OFF el INSERT con referencia rota se acepta en el momento;
          // foreign_key_check (dentro de la tx) debe detectarla y revertir todo.
          d.exec(
            "CREATE TABLE t_fk (x TEXT REFERENCES triggers (id) ON DELETE RESTRICT)",
          );
          d.exec("INSERT INTO t_fk VALUES ('trigger-inexistente')");
        },
      };
      assert.throws(() => runMigrations(db, [m]), /foreign_key_check/);
      // Revertido de forma durable: ni versión ni tabla quedan confirmadas.
      assert.strictEqual(userVersion(db), 1);
      assert.strictEqual(
        tableExists(db, "t_fk"),
        false,
        "tabla revertida por el ROLLBACK",
      );
      // La conexión no queda con FKs apagadas (restaura en finally al valor previo;
      // node:sqlite por defecto tiene foreign_keys=ON).
      const fk = db.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      };
      assert.strictEqual(
        fk.foreign_keys,
        1,
        "FK se restaura al valor previo (ON) tras el fallo",
      );
      db.close();
    });
  });

  describe("CHECK de `triggers`", () => {
    it("rechaza un mode fuera del catálogo", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTrigger(db, { mode: "auto" }));
    });

    it("rechaza created_by inválido y authority inválida", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTrigger(db, { created_by: "grupo" }));
      assert.throws(() => insertTrigger(db, { authority: "root" }));
    });

    it("rechaza un booleano enabled que no es 0 ni 1", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTrigger(db, { enabled: 2 }));
    });

    it("v3: el Agent puede crear activo (proposal_state NULL) y rechaza propuesta inválida", async () => {
      const db = await openRaw(await tmpDataDir());
      // ADR 0035: un Trigger de agente que pasa el gate se activa de inmediato.
      insertTrigger(db, { id: "a", created_by: "agent", proposal_state: null });
      // owner/control_plane siguen sin poder crear como propuesta.
      assert.throws(() =>
        insertTrigger(db, {
          id: "b",
          created_by: "owner",
          proposal_state: "proposed",
        }),
      );
      assert.throws(() =>
        insertTrigger(db, {
          id: "c",
          created_by: "control_plane",
          proposal_state: "proposed",
        }),
      );
      // proposal_state inválida sigue rechazándose.
      assert.throws(() =>
        insertTrigger(db, {
          id: "d",
          created_by: "agent",
          proposal_state: "bogus",
        }),
      );
    });

    it("rechaza que owner/control_plane creen como propuesta", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() =>
        insertTrigger(db, { created_by: "owner", proposal_state: "proposed" }),
      );
      assert.throws(() =>
        insertTrigger(db, {
          created_by: "control_plane",
          proposal_state: "proposed",
        }),
      );
    });

    it("acepta las combinaciones válidas (v3: agente activo incl. NULL)", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, { id: "a", created_by: "owner" });
      insertTrigger(db, { id: "b", created_by: "control_plane" });
      insertTrigger(db, {
        id: "c",
        created_by: "agent",
        proposal_state: "proposed",
      });
      insertTrigger(db, {
        id: "d",
        created_by: "agent",
        proposal_state: "approved",
      });
      insertTrigger(db, { id: "e", created_by: "agent" });
      // La autoridad `agent` es válida como columna.
      insertTrigger(db, {
        id: "f",
        created_by: "agent",
        authority: "agent",
        proposal_state: null,
      });
    });
  });

  describe("CHECK e invariantes de `initiatives`", () => {
    it("rechaza un state fuera de los ocho de Initiative State", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { state: "pending" }));
    });

    it("rechaza un mode fuera del catálogo (solo/ask)", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { mode: "auto" }));
    });

    it("rechaza un origin fuera del catálogo (trigger/callback/human)", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { origin: "system" }));
    });

    it("invariante 1: el origen trigger exige trigger_id y los demás lo prohíben", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, { id: "trg-ref" });
      assert.throws(() => insertInitiative(db, { origin: "trigger" }));
      assert.throws(() =>
        insertInitiative(db, { origin: "trigger", trigger_id: null }),
      );
      assert.throws(() =>
        insertInitiative(db, { origin: "callback", trigger_id: "trg-ref" }),
      );
      assert.throws(() =>
        insertInitiative(db, { origin: "human", trigger_id: "trg-ref" }),
      );
      insertInitiative(db, {
        id: "ok-trigger",
        origin: "trigger",
        trigger_id: "trg-ref",
      });
      insertInitiative(db, { id: "ok-callback", origin: "callback" });
      insertInitiative(db, { id: "ok-human", origin: "human" });
    });

    it("invariante 2: estado terminal exige finished_at y los vivos lo prohíben", async () => {
      const db = await openRaw(await tmpDataDir());
      for (const terminal of ["succeeded", "failed", "expired", "cancelled"]) {
        assert.throws(() => insertInitiative(db, { state: terminal }));
      }
      for (const vivo of [
        "queued",
        "running",
        "waiting_human",
        "waiting_agent",
      ]) {
        assert.throws(() =>
          insertInitiative(db, { state: vivo, finished_at: 1 }),
        );
      }
      insertInitiative(db, {
        id: "ok-terminal",
        state: "succeeded",
        finished_at: 2000,
      });
      insertInitiative(db, {
        id: "ok-vivo",
        state: "waiting_human",
        summary: "resumen",
      });
    });

    it("waiting_human exige summary para conservarlo si caduca", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { state: "waiting_human" }));
      insertInitiative(db, {
        id: "ok",
        state: "waiting_human",
        summary: "resumen",
      });
    });

    it("rechaza chain_depth negativo y un booleano no binario", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { chain_depth: -1 }));
      assert.throws(() =>
        insertInitiative(db, { visible_effects_declared: 2 }),
      );
    });

    it("la FK a triggers usa ON DELETE RESTRICT", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, { id: "trg-fk" });
      insertInitiative(db, {
        id: "ini-fk",
        origin: "trigger",
        trigger_id: "trg-fk",
      });
      assert.throws(() => db.exec("DELETE FROM triggers WHERE id = 'trg-fk'"));
    });
  });

  describe("`callbacks` como especialización 1:1", () => {
    it("rechaza que el Callback sea su propio parent (CHECK parent_id <> id)", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-self", origin: "callback" });
      assert.throws(() =>
        insertCallback(db, { id: "cb-self", parent_id: "cb-self" }),
      );
    });

    it("la FK a initiatives valida id y parent_id", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-1", origin: "callback" });
      insertInitiative(db, { id: "parent-1" });
      assert.throws(() =>
        insertCallback(db, { id: "inexistente", parent_id: "parent-1" }),
      );
      assert.throws(() =>
        insertCallback(db, { id: "cb-1", parent_id: "inexistente" }),
      );
      insertCallback(db, { id: "cb-1", parent_id: "parent-1" });
    });

    it("borrar el parent está RESTRICT y borrar la Initiative del Callback CASCADEA su fila", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-1", origin: "callback" });
      insertInitiative(db, { id: "parent-1" });
      insertCallback(db, { id: "cb-1", parent_id: "parent-1" });
      assert.throws(() =>
        db.exec("DELETE FROM initiatives WHERE id = 'parent-1'"),
      );
      db.exec("DELETE FROM initiatives WHERE id = 'cb-1'");
      const restantes = db
        .prepare("SELECT COUNT(*) AS n FROM callbacks WHERE id = 'cb-1'")
        .get() as { n: number };
      assert.strictEqual(restantes.n, 0);
    });
  });

  describe("`turns` como reserva de idempotencia", () => {
    it("rechaza un final_state fuera de succeeded/failed/cancelled", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTurn(db, { final_state: "running" }));
      insertTurn(db, { final_state: "succeeded", finished_at: 2000 });
    });

    it("idempotency_key es única globalmente, cruzando Agents", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTurn(db, {
        agent_name: "alice",
        turn_id: "turn-1",
        idempotency_key: "idem-1",
      });
      assert.throws(() =>
        insertTurn(db, {
          agent_name: "bob",
          turn_id: "turn-2",
          idempotency_key: "idem-1",
        }),
      );
    });

    it("la PK compuesta (agent_name, turn_id) rechaza duplicados", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTurn(db, {
        agent_name: "alice",
        turn_id: "turn-1",
        idempotency_key: "idem-1",
      });
      assert.throws(() =>
        insertTurn(db, {
          agent_name: "alice",
          turn_id: "turn-1",
          idempotency_key: "idem-2",
        }),
      );
    });
  });
});
