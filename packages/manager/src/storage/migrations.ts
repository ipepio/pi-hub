import type { SqliteDb } from "./sqlite.ts";

export const SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  up(db: SqliteDb): void;
}

const V1_DDL = `
CREATE TABLE triggers (
  id TEXT NOT NULL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('solo', 'ask')),
  suggested_skill TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'control_plane', 'agent')),
  authority TEXT NOT NULL CHECK (authority IN ('owner', 'control_plane')),
  proposal_state TEXT CHECK (proposal_state IN ('proposed', 'approved')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_fire_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (created_by = 'agent' AND proposal_state IS NOT NULL)
    OR (created_by IN ('owner', 'control_plane') AND proposal_state IS NULL)
  )
);
CREATE INDEX schedule_triggers_due ON triggers (next_fire_at)
  WHERE enabled = 1 AND kind = 'schedule' AND (proposal_state IS NULL OR proposal_state = 'approved');
CREATE TABLE initiatives (
  id TEXT NOT NULL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_human', 'waiting_agent', 'succeeded', 'failed', 'expired', 'cancelled')),
  origin TEXT NOT NULL CHECK (origin IN ('trigger', 'callback', 'human')),
  trigger_id TEXT REFERENCES triggers (id) ON DELETE RESTRICT,
  intent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('solo', 'ask')),
  session_key TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  bound_model TEXT,
  turn_id TEXT,
  chain_depth INTEGER NOT NULL CHECK (chain_depth >= 0),
  chain_deadline_at INTEGER,
  visible_effects_declared INTEGER NOT NULL CHECK (visible_effects_declared IN (0, 1)),
  summary TEXT,
  ask_correlation TEXT,
  failure_reason TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK (
    (origin = 'trigger' AND trigger_id IS NOT NULL)
    OR (origin IN ('callback', 'human') AND trigger_id IS NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'failed', 'expired', 'cancelled') AND finished_at IS NOT NULL)
    OR (state IN ('queued', 'running', 'waiting_human', 'waiting_agent') AND finished_at IS NULL)
  ),
  CHECK (state <> 'waiting_human' OR summary IS NOT NULL)
);
CREATE INDEX initiatives_due ON initiatives (available_at) WHERE state = 'queued';
CREATE INDEX initiatives_waiting_human_expiry ON initiatives (state_changed_at) WHERE state = 'waiting_human';
CREATE INDEX initiatives_chain_deadline_due ON initiatives (chain_deadline_at)
  WHERE state IN ('queued', 'running', 'waiting_agent', 'waiting_human');
CREATE INDEX initiatives_running_at_startup ON initiatives (id) WHERE state = 'running';
CREATE INDEX initiatives_by_turn ON initiatives (agent_name, turn_id) WHERE turn_id IS NOT NULL;
CREATE TABLE callbacks (
  id TEXT NOT NULL PRIMARY KEY REFERENCES initiatives (id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE RESTRICT,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (parent_id <> id)
);
CREATE INDEX callbacks_by_parent ON callbacks (parent_id);
CREATE TABLE turns (
  agent_name TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  final_state TEXT CHECK (final_state IN ('succeeded', 'failed', 'cancelled')),
  result TEXT,
  claimed_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (agent_name, turn_id)
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(V1_DDL) },
];

/**
 * Aplica, en orden, cada migración pendiente sobre la base ya abierta. Cada
 * versión corre dentro de `BEGIN IMMEDIATE` y confirma su DDL/DML junto con el
 * `PRAGMA user_version` en el mismo `COMMIT`: si falla una sentencia, SQLite
 * hace `ROLLBACK` y ni los cambios de esa versión ni su versión quedan
 * confirmados; el siguiente arranque repite la migración completa.
 */
export function runMigrations(db: SqliteDb, migrations: readonly Migration[] = MIGRATIONS): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const diskVersion = Number(row.user_version);
  if (diskVersion > SCHEMA_VERSION) {
    throw new Error(
      `El esquema SQLite del Manager en disco (v${diskVersion}) supera el soportado (v${SCHEMA_VERSION}); abortando`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= diskVersion) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
