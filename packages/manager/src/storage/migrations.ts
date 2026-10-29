import type { SqliteDb } from "./sqlite.ts";

export const SCHEMA_VERSION = 7;

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

// Schema v4 (slice (c) part 2a, channels-and-mcp): outbox durable de mensajes
// salientes hacia un Channel (`specs/pihub-manager-channels` → “Outbox — SQLite
// migration v4”, design §2.2).
//
// Es una tabla NUEVA y puramente aditiva: ninguna fila existente se toca y ningún
// CHECK anterior cambia, así que `up` no necesita `disableForeignKeys` (no hay
// rebuild). No hay FK a `agents` porque el Manager no tiene tabla de Agents — el
// nombre de Agent es texto, como en `triggers`/`initiatives`.
//
// La fila es a la vez reserva y registro de entrega, copiando la disciplina de
// `human_request_deliveries` (v2, `:149-162`):
//
// - `id` ES la reserva: `pending:<uuid>` de por vida. El CHECK de prefijo hace que
//   el formato sea dato, no comentario — una fila sin reserva no puede existir.
// - `state` es la máquina de §2.2 (`pending → in_flight → delivered | pending |
//   dead`); fuera de esos cuatro valores no entra nada (diagrama normativo).
// - `attempts` + `next_attempt_at` dan el backoff exponencial; `attempts >= 8`
//   llega a `dead` (decisión del worker, no de la tabla).
// - `external_message_id` es el mensaje REAL devuelto por el transporte: su índice
//   único parcial (`WHERE NOT NULL`) es lo que impide entregar dos veces la misma
//   cosa tras “send OK, UPDATE fallido” (at-least-once con idempotencia).
// - `in_flight_at` hace recuperable el lease: tras un crash del Manager la fila
//   vuelve a la cola cuando expira (120 s), nunca se pierde.
// - `last_error`/`delivered_at` son observables (I3) y el estado terminal:
//   un `delivered` sin `delivered_at` o un `in_flight` sin `in_flight_at` son
//   imposibles por CHECK, no por convención.
//
// `channel_exchanges` (design §1.2/§1.4, log de intercambios) va en la MISMA v4:
// nunca se publicó un v4 sin ella, así que añadir la tabla aquí es aditivo sobre
// un esquema no distribuido — y es el par de `channel_outbox`: la cola de salida
// y el espejo que el Dashboard drena projection-in.
//   - `turn_id` UNIQUE: el hook de entrega es at-least-once (igual que el outbox),
//     así que la clave natural del intercambio es lo que impide duplicar la fila.
//   - `origin` excluye `human` a propósito (CHECK): un turno web YA vive en el
//     transcript autoritativo del Dashboard; reflejarlo aquí sería un segundo amo
//     del mismo hecho. Solo entran `telegram` (reply de origen canal) y
//     `proactive` (Iniciativa del agenda).
//   - `user_text`/`reply_text` son texto plano del intercambio: no hay secretos
//     aquí más allá de lo que el propio usuario escribió por el canal.
const V4_CHANNEL_TABLES = `
CREATE TABLE channel_outbox (
  id TEXT NOT NULL PRIMARY KEY CHECK (substr(id, 1, 8) = 'pending:'),
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'telegram'),
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  external_message_id TEXT,
  in_flight_at INTEGER,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state <> 'in_flight' OR in_flight_at IS NOT NULL),
  CHECK (state <> 'delivered' OR delivered_at IS NOT NULL)
);
CREATE UNIQUE INDEX channel_outbox_external_message
  ON channel_outbox(external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE INDEX channel_outbox_due
  ON channel_outbox(state, next_attempt_at, id);
CREATE INDEX channel_outbox_agent
  ON channel_outbox(agent_name, kind, state, created_at, id);
CREATE TABLE channel_exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('telegram', 'proactive')),
  chat_id TEXT,
  user_text TEXT NOT NULL DEFAULT '',
  reply_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX channel_exchanges_agent
  ON channel_exchanges(agent_name, id);
`;

    // Schema v5 (T3, agent-session-workspace): catálogo durable de sesiones de un
    // Agent y la selección de UNA sesión por superficie.
    //
    // Por qué SQLite y no un fichero por Agent: el catálogo es un hecho del Manager
    // (como `triggers`/`initiatives`) y tiene que sobrevivir al reinicio junto al
    // resto del estado durable; un fichero suelto sería un segundo almacén con su
    // propia atomicidad.
    //
    // Invariantes que el esquema sostiene (no la convención del llamador):
    // - La clave de identidad es `(agent_name, session_id)`: una sesión NUNCA es
    //   global. `session_key` es única POR Agent (`UNIQUE (agent_name, session_key)`),
    //   que es lo que hace que la adopción del `agent:<nombre>:main` y la creación
    //   idempotente de una key legacy no puedan duplicar filas.
    // - `legacy` marca la entrada adoptada del runtime pre-catálogo. Es un hecho
    //   declarado, no inferido: la UI puede decir la verdad sobre su contexto.
    // - La selección es por `(agent_name, channel)`: web y Telegram eligen de forma
    //   independiente sobre el MISMO catálogo (S3). La FK compuesta garantiza que
    //   ninguna superficie pueda quedar seleccionando una sesión de otro Agent.
    //
    // Migración aditiva: dos tablas nuevas, ningún CHECK anterior cambia y ninguna
    // fila existente se toca, así que no hace falta `disableForeignKeys`.
    const V5_AGENT_SESSIONS = `
    CREATE TABLE agent_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
      name TEXT,
      legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id),
      UNIQUE (agent_name, session_key)
    );
    CREATE INDEX agent_sessions_by_agent
      ON agent_sessions (agent_name, created_at, session_id);
    CREATE TABLE agent_session_selection (
      agent_name TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
      session_id TEXT NOT NULL,
      selected_at INTEGER NOT NULL,
      PRIMARY KEY (agent_name, channel),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES agent_sessions (agent_name, session_id) ON DELETE CASCADE
    );
    `;
    
    // Schema v6 (T5a, agent-session-workspace): la mitad DURABLE del transcript,
    // en el mismo espejo `channel_exchanges` que el Dashboard ya drena.
    //
    // Por qué DOS columnas nullable y no un rebuild de `user_text`/`reply_text`:
    // - Las columnas v4 ya guardan la mitad completa de cada lado (el Manager nunca
    //   recortó al escribir; el recorte de preview es del Dashboard). Reconstruirlas
    //   no añadiría un dato: solo reescribiría filas legacy, y la decisión del
    //   usuario (L16) es que las filas legacy son historia INMUTABLE.
    // - Lo que faltaba era la SEÑAL: en v4 una fila vieja y una nueva son
    //   indistinguibles (`user_text NOT NULL DEFAULT ''`). v6 añade el hecho
    //   declarado «esta fila tiene transcripción completa», y NULL es el valor
    //   honesto para todo lo anterior.
    //
    // Aditiva y sin backfill: dos columnas NULLables, ningún CHECK anterior cambia,
    // ninguna fila existente se toca y no hay rebuild ⇒ no hace falta
    // `disableForeignKeys`. El techo de cada mitad lo aplica el escritor
    // (`channels/exchange-log.ts` → `CHANNEL_FULL_TEXT_MAX_CHARS`), porque es una
    // regla de contenido, no de forma.
    const V6_CHANNEL_FULL_TEXT = `
    ALTER TABLE channel_exchanges ADD COLUMN user_full_text TEXT;
    ALTER TABLE channel_exchanges ADD COLUMN reply_full_text TEXT;
    `;

    // Schema v7 (T5b/2, agent-session-workspace): la IDENTIDAD del turno que
    // produjo el intercambio, para que el Dashboard pueda atribuir una fila a una de
    // las sesiones de su Agent (el prerrequisito explícito de §6 de
    // `docs/agent-session-integration.md` de D).
    //
    // Por qué una columna NULLable y aditiva:
    // - Una fila escrita antes de v7 NO tiene identidad conocida. Cualquier valor por
    //   defecto sería una invención (rellenarla con `agent:<nombre>:main` atribuiría
    //   historia a una sesión que no se puede probar), así que el valor honesto para
    //   el pasado es NULL y la migración NO hace backfill. Es la misma decisión que
    //   la v6: la historia anterior es READ-ONLY.
    // - Qué valor tiene NO es una regla de forma: lo escribe el escritor con la key
    //   del turno REAL (`channels/exchange-log.ts` ← `CompletedTurn.sessionKey`), de
    //   modo que el feed nunca re-deriva la identidad de la selección actual.
    const V7_CHANNEL_SESSION_KEY = `
    ALTER TABLE channel_exchanges ADD COLUMN session_key TEXT;
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
    {
        version: 4,
        up: (db) => {
            db.exec(V4_CHANNEL_TABLES);
        },
    },
    {
        version: 5,
        up: (db) => {
            db.exec(V5_AGENT_SESSIONS);
        },
    },
    {
        version: 6,
        up: (db) => {
            db.exec(V6_CHANNEL_FULL_TEXT);
        },
    },
    {
        version: 7,
        up: (db) => {
            db.exec(V7_CHANNEL_SESSION_KEY);
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
