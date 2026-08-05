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
import { runMigrations, SCHEMA_VERSION, type Migration } from "../src/storage/migrations.ts";

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
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
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

function insertTrigger(db: SqliteDb, overrides: Partial<TriggerRow> = {}): void {
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
    row.id, row.agent_name, row.kind, row.definition_json, row.intent, row.mode,
    row.suggested_skill, row.created_by, row.authority, row.proposal_state, row.enabled,
    row.next_fire_at, row.last_fired_at, row.created_at, row.updated_at,
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

function insertInitiative(db: SqliteDb, overrides: Partial<InitiativeRow> = {}): void {
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
    row.id, row.agent_name, row.state, row.origin, row.trigger_id, row.intent, row.mode,
    row.session_key, row.available_at, row.bound_model, row.turn_id, row.chain_depth,
    row.chain_deadline_at, row.visible_effects_declared, row.summary, row.ask_correlation,
    row.failure_reason, row.result, row.created_at, row.state_changed_at, row.started_at,
    row.finished_at,
  );
}

interface CallbackRow {
  id: string;
  parent_id: string;
  result: string;
  created_at: number;
}

function insertCallback(db: SqliteDb, overrides: Partial<CallbackRow> = {}): void {
  const row: CallbackRow = { id: "cb-1", parent_id: "parent-1", result: "{}", created_at: 1000, ...overrides };
  db.prepare("INSERT INTO callbacks (id, parent_id, result, created_at) VALUES (?,?,?,?)").run(
    row.id, row.parent_id, row.result, row.created_at,
  );
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
  ).run(row.agent_name, row.turn_id, row.idempotency_key, row.final_state, row.result, row.claimed_at, row.finished_at);
}

function userVersion(db: SqliteDb): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function indexSql(db: SqliteDb, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  assert.ok(row, `índice ${name} presente con DDL`);
  return (row as { sql: string }).sql;
}

const normaliseSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("almacén SQLite del Manager", () => {
  it("crea la base en ${dataDir}/manager/agenda.sqlite3", async () => {
    const dataDir = await tmpDataDir();
    const store = await openStore(dataDir);
    assert.strictEqual(store.file, path.join(dataDir, "manager", "agenda.sqlite3"));
    await assert.doesNotReject(fs.access(store.file));
  });

  it("aplica los pragmas obligatorios (foreign_keys y WAL)", async () => {
    const db = await openRaw(await tmpDataDir());
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.strictEqual(fk.foreign_keys, 1);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.strictEqual(journal.journal_mode, "wal");
  });

  it("crea las cuatro tablas y los índices declarados", async () => {
    const db = await openRaw(await tmpDataDir());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    for (const name of ["triggers", "initiatives", "callbacks", "turns"]) {
      assert.ok(tables.some((t) => t.name === name), `tabla ${name} presente`);
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
    ];
    for (const name of expected) {
      assert.ok(indexes.some((i) => i.name === name), `índice ${name} presente`);
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
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    assert.strictEqual(version, 0);
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get();
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
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    assert.strictEqual(version, 1);
    const t2 = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't2'").get();
    assert.strictEqual(t2, undefined);
    db.close();
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

    it("rechaza que el Agent cree sin propuesta pendiente", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTrigger(db, { created_by: "agent" }));
      assert.throws(() => insertTrigger(db, { created_by: "agent", proposal_state: "bogus" }));
    });

    it("rechaza que owner/control_plane creen como propuesta", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertTrigger(db, { created_by: "owner", proposal_state: "proposed" }));
      assert.throws(() => insertTrigger(db, { created_by: "control_plane", proposal_state: "proposed" }));
    });

    it("acepta las combinaciones válidas de autoría y propuesta", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, { id: "a", created_by: "owner" });
      insertTrigger(db, { id: "b", created_by: "control_plane" });
      insertTrigger(db, { id: "c", created_by: "agent", proposal_state: "proposed" });
      insertTrigger(db, { id: "d", created_by: "agent", proposal_state: "approved" });
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
      assert.throws(() => insertInitiative(db, { origin: "trigger", trigger_id: null }));
      assert.throws(() => insertInitiative(db, { origin: "callback", trigger_id: "trg-ref" }));
      assert.throws(() => insertInitiative(db, { origin: "human", trigger_id: "trg-ref" }));
      insertInitiative(db, { id: "ok-trigger", origin: "trigger", trigger_id: "trg-ref" });
      insertInitiative(db, { id: "ok-callback", origin: "callback" });
      insertInitiative(db, { id: "ok-human", origin: "human" });
    });

    it("invariante 2: estado terminal exige finished_at y los vivos lo prohíben", async () => {
      const db = await openRaw(await tmpDataDir());
      for (const terminal of ["succeeded", "failed", "expired", "cancelled"]) {
        assert.throws(() => insertInitiative(db, { state: terminal }));
      }
      for (const vivo of ["queued", "running", "waiting_human", "waiting_agent"]) {
        assert.throws(() => insertInitiative(db, { state: vivo, finished_at: 1 }));
      }
      insertInitiative(db, { id: "ok-terminal", state: "succeeded", finished_at: 2000 });
      insertInitiative(db, { id: "ok-vivo", state: "waiting_human", summary: "resumen" });
    });

    it("waiting_human exige summary para conservarlo si caduca", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { state: "waiting_human" }));
      insertInitiative(db, { id: "ok", state: "waiting_human", summary: "resumen" });
    });

    it("rechaza chain_depth negativo y un booleano no binario", async () => {
      const db = await openRaw(await tmpDataDir());
      assert.throws(() => insertInitiative(db, { chain_depth: -1 }));
      assert.throws(() => insertInitiative(db, { visible_effects_declared: 2 }));
    });

    it("la FK a triggers usa ON DELETE RESTRICT", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTrigger(db, { id: "trg-fk" });
      insertInitiative(db, { id: "ini-fk", origin: "trigger", trigger_id: "trg-fk" });
      assert.throws(() => db.exec("DELETE FROM triggers WHERE id = 'trg-fk'"));
    });
  });

  describe("`callbacks` como especialización 1:1", () => {
    it("rechaza que el Callback sea su propio parent (CHECK parent_id <> id)", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-self", origin: "callback" });
      assert.throws(() => insertCallback(db, { id: "cb-self", parent_id: "cb-self" }));
    });

    it("la FK a initiatives valida id y parent_id", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-1", origin: "callback" });
      insertInitiative(db, { id: "parent-1" });
      assert.throws(() => insertCallback(db, { id: "inexistente", parent_id: "parent-1" }));
      assert.throws(() => insertCallback(db, { id: "cb-1", parent_id: "inexistente" }));
      insertCallback(db, { id: "cb-1", parent_id: "parent-1" });
    });

    it("borrar el parent está RESTRICT y borrar la Initiative del Callback CASCADEA su fila", async () => {
      const db = await openRaw(await tmpDataDir());
      insertInitiative(db, { id: "cb-1", origin: "callback" });
      insertInitiative(db, { id: "parent-1" });
      insertCallback(db, { id: "cb-1", parent_id: "parent-1" });
      assert.throws(() => db.exec("DELETE FROM initiatives WHERE id = 'parent-1'"));
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
      insertTurn(db, { agent_name: "alice", turn_id: "turn-1", idempotency_key: "idem-1" });
      assert.throws(() => insertTurn(db, { agent_name: "bob", turn_id: "turn-2", idempotency_key: "idem-1" }));
    });

    it("la PK compuesta (agent_name, turn_id) rechaza duplicados", async () => {
      const db = await openRaw(await tmpDataDir());
      insertTurn(db, { agent_name: "alice", turn_id: "turn-1", idempotency_key: "idem-1" });
      assert.throws(() => insertTurn(db, { agent_name: "alice", turn_id: "turn-1", idempotency_key: "idem-2" }));
    });
  });
});
