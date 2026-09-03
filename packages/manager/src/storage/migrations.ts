import type { SqliteDb } from "./sqlite.ts";

export const SCHEMA_VERSION = 3;

export interface Migration {
    version: number;
    up(db: SqliteDb): void;
    /**
     * Rebuild de una tabla con FKs entrantes (p.ej. `triggers`, referenciado por
     * `initiatives`): SQLite exige `PRAGMA foreign_keys=OFF` FUERA de la
     * transacción para poder `DROP TABLE` + `RENAME` sin violar la FK RESTRICT.
     * Solo esta migración lo activa; el runner lo apaga, ejecuta y valida con
     * `foreign_key_check` dentro de la misma transacción (R1-010), restaurando el
     * valor previo en un `finally`.
     */
    disableForeignKeys?: boolean;
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

// Schema v2 (plan P1 §2): reserva durable para P3/P4, sin comportamiento.
// - Columnas de idempotencia/gestión en `triggers` e `initiatives`, todas
//   nullable para que las filas legacy sigan válidas.
// - `human_expires_at` se backfillea para las filas ya en `waiting_human` con
//   `state_changed_at + 604800000` (7 días). El barrido del Loop NO cambia en
//   P1: la autoridad de expiración es decisión de P3.
// - `human_request_deliveries` (correlación Telegram) y `runtime_admission`
//   (admisión P4) se crean y quedan dormidas.
// - `turns` se reconstruye para admitir `paused_for_human`; P3 la escribirá.
const V2_ALTER_TRIGGERS = `
ALTER TABLE triggers ADD COLUMN create_idempotency_key TEXT;
ALTER TABLE triggers ADD COLUMN create_command_hash TEXT;
CREATE UNIQUE INDEX triggers_create_idempotency
  ON triggers(agent_name, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;
`;

const V2_ALTER_INITIATIVES = `
ALTER TABLE initiatives ADD COLUMN human_question TEXT;
ALTER TABLE initiatives ADD COLUMN human_expires_at INTEGER;
ALTER TABLE initiatives ADD COLUMN human_request_id TEXT;
ALTER TABLE initiatives ADD COLUMN pending_human_input TEXT;
ALTER TABLE initiatives ADD COLUMN human_response_idempotency_key TEXT;
ALTER TABLE initiatives ADD COLUMN human_response_command_hash TEXT;
CREATE UNIQUE INDEX initiatives_human_request
  ON initiatives(human_request_id)
  WHERE human_request_id IS NOT NULL;
CREATE INDEX initiatives_autonomy_live
  ON initiatives(agent_name, state, available_at, id)
  WHERE state IN ('queued','running','waiting_human','waiting_agent');
CREATE INDEX initiatives_autonomy_history
  ON initiatives(agent_name, finished_at DESC, id DESC)
  WHERE state IN ('succeeded','failed','expired','cancelled');
`;

const V2_BACKFILL_HUMAN_EXPIRES = `
UPDATE initiatives
SET human_expires_at = state_changed_at + 604800000
WHERE state = 'waiting_human';
`;

const V2_TRIGGERS_BY_AGENT = `
CREATE INDEX triggers_by_agent
  ON triggers(agent_name, created_at, id);
`;

const V2_HUMAN_REQUEST_DELIVERIES = `
CREATE TABLE human_request_deliveries (
  human_request_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  initiative_id TEXT NOT NULL REFERENCES initiatives (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel = 'telegram'),
  external_chat_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_chat_id, external_message_id),
  UNIQUE (human_request_id, channel)
);
CREATE INDEX human_request_deliveries_by_initiative
  ON human_request_deliveries(initiative_id, created_at);
`;

const V2_RUNTIME_ADMISSION = `
CREATE TABLE runtime_admission (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('open','draining')),
  changed_at INTEGER NOT NULL
);
INSERT INTO runtime_admission(singleton,state,changed_at) VALUES (1,'open',0);
`;

const V2_REBUILD_TURNS = `
CREATE TABLE turns_v2 (
  agent_name TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  final_state TEXT CHECK (final_state IN ('succeeded', 'failed', 'cancelled', 'paused_for_human')),
  result TEXT,
  claimed_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (agent_name, turn_id)
);
INSERT INTO turns_v2 (agent_name, turn_id, idempotency_key, final_state, result, claimed_at, finished_at)
  SELECT agent_name, turn_id, idempotency_key, final_state, result, claimed_at, finished_at FROM turns;
DROP TABLE turns;
ALTER TABLE turns_v2 RENAME TO turns;
`;

// Schema v3 (P2.4a): autoridad efectiva `agent` (pihub step 2a).
//
// - La columna `authority` admite `'agent'` además de `'owner'`/`'control_plane'`.
// - Se relaja el CHECK que forzaba `created_by='agent' => proposal_state IS NOT
//   NULL`. ADR 0035: un Trigger creado por un agente que pasa el gate de
//   política se ACTIVA de inmediato (proposal_state NULL, como las filas
//   owner/control_plane). `proposal_state='proposed'` conserva su semántica
//   para flujos futuros de propuesta de agente — hoy no se usa.
//
// SQLite no puede modificar un CHECK en su sitio; se reconstruye la tabla
//   `triggers` (copy + DROP + RENAME) recreando sus tres índices. `initiatives`
//   referencia `triggers` vía `trigger_id` (ON DELETE RESTRICT), por eso esta
//   migración declara `disableForeignKeys` y el runner la ejecuta con FKs OFF,
//   re-valida con `foreign_key_check`. No se borra ni se migra dato: toda fila
//   v2 satisface ya el CHECK v3 (owner/control_plane con NULL; agente con
//   `proposal_state` NOT NULL o NULL).
const V3_REBUILD_TRIGGERS = `
    CREATE TABLE triggers_v3 (
      id TEXT NOT NULL PRIMARY KEY,
      agent_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      intent TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('solo', 'ask')),
      suggested_skill TEXT,
      created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'control_plane', 'agent')),
      authority TEXT NOT NULL CHECK (authority IN ('owner', 'control_plane', 'agent')),
      proposal_state TEXT CHECK (proposal_state IN ('proposed', 'approved')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_fire_at INTEGER,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      create_idempotency_key TEXT,
      create_command_hash TEXT,
      CHECK (
        (created_by IN ('owner', 'control_plane') AND proposal_state IS NULL)
        OR (created_by = 'agent')
      )
    );
    INSERT INTO triggers_v3
      (id, agent_name, kind, definition_json, intent, mode, suggested_skill, created_by,
       authority, proposal_state, enabled, next_fire_at, last_fired_at, created_at,
       updated_at, create_idempotency_key, create_command_hash)
      SELECT id, agent_name, kind, definition_json, intent, mode, suggested_skill, created_by,
             authority, proposal_state, enabled, next_fire_at, last_fired_at, created_at,
             updated_at, create_idempotency_key, create_command_hash
        FROM triggers;
    DROP TABLE triggers;
    ALTER TABLE triggers_v3 RENAME TO triggers;
    `;

const V3_TRIGGERS_INDEXES = `
CREATE INDEX schedule_triggers_due ON triggers (next_fire_at)
  WHERE enabled = 1 AND kind = 'schedule' AND (proposal_state IS NULL OR proposal_state = 'approved');
CREATE INDEX triggers_by_agent ON triggers (agent_name, created_at, id);
CREATE UNIQUE INDEX triggers_create_idempotency
  ON triggers(agent_name, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
    { version: 1, up: (db) => db.exec(V1_DDL) },
    {
        version: 2,
        up: (db) => {
            db.exec(V2_ALTER_TRIGGERS);
            db.exec(V2_ALTER_INITIATIVES);
            db.exec(V2_BACKFILL_HUMAN_EXPIRES);
            db.exec(V2_TRIGGERS_BY_AGENT);
            db.exec(V2_HUMAN_REQUEST_DELIVERIES);
            db.exec(V2_RUNTIME_ADMISSION);
            db.exec(V2_REBUILD_TURNS);
        },
    },
    {
        version: 3,
        disableForeignKeys: true,
        up: (db) => {
            db.exec(V3_REBUILD_TRIGGERS);
            db.exec(V3_TRIGGERS_INDEXES);
        },
    },
];

/**
 * Aplica, en orden, cada migración pendiente sobre la base ya abierta. Cada
 * versión corre dentro de `BEGIN IMMEDIATE` y confirma su DDL/DML junto con el
 * `PRAGMA user_version` en el mismo `COMMIT`: si falla una sentencia, SQLite
 * hace `ROLLBACK` y ni los cambios de esa versión ni su versión quedan
 * confirmados; el siguiente arranque repite la migración completa.
 */
export function runMigrations(
    db: SqliteDb,
    migrations: readonly Migration[] = MIGRATIONS,
    supportedVersion: number = SCHEMA_VERSION,
): void {
    const row = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
    };
    const diskVersion = Number(row.user_version);
    if (diskVersion > supportedVersion) {
        throw new Error(
            `El esquema SQLite del Manager en disco (v${diskVersion}) supera el soportado (v${supportedVersion}); abortando`,
        );
    }
    for (const migration of migrations) {
        if (migration.version <= diskVersion) continue;
        // Un rebuild de tabla con FKs entrantes exige `foreign_keys=OFF` FUERA de la
        // transacción. Se recuerda el estado previo para no forzar FK ON en conexiones
        // que las tenían OFF (p.ej. los `:memory:` de test).
        let foreignKeysWereOn = false;
        if (migration.disableForeignKeys) {
            foreignKeysWereOn =
                Number(
                    (
                        db.prepare("PRAGMA foreign_keys").get() as {
                            foreign_keys: number;
                        }
                    ).foreign_keys,
                ) === 1;
            db.exec("PRAGMA foreign_keys = OFF");
        }
        try {
            db.exec("BEGIN IMMEDIATE");
            try {
                migration.up(db);
                // R1-010: la validación de FKs corre DENTRO de la transacción (funciona con
                // foreign_keys=OFF, es un chequeo diagnóstico), ANTES del COMMIT: si hay
                // violaciones, el throw hace ROLLBACK durable — nada queda confirmado.
                if (migration.disableForeignKeys) {
                    const violations = db
                        .prepare("PRAGMA foreign_key_check")
                        .all() as unknown[];
                    if (violations.length > 0) {
                        throw new Error(
                            `Migración v${migration.version}: foreign_key_check detectó ${violations.length} violaciones`,
                        );
                    }
                }
                db.exec(`PRAGMA user_version = ${migration.version}`);
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        } finally {
            // R1-010: restaurar el valor previo de foreign_keys también en el camino de
            // error — nunca dejar la conexión con FKs apagadas tras una migración fallida.
            if (migration.disableForeignKeys && foreignKeysWereOn) {
                db.exec("PRAGMA foreign_keys = ON");
            }
        }
    }
}
