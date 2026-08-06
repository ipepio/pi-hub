/**
 * AutonomyProjection — P1.2 del plan P1 (plan §3).
 *
 * La lectura de la Agenda que compartirán `/api/v1` y el panel (ADR 0013: un
 * solo camino de ejecución, no un segundo protocolo). No autentica, no conoce
 * Hono y no redacta: `InternalAutonomySnapshot`/`InternalInitiative`/
 * `InternalTrigger` son objetos internos completos, sin `toJSON` accidental.
 * P2 construirá presenters allowlist sobre esta única fotografía.
 *
 * Decisión cerrada de §3.2 — **una sola transacción `BEGIN` (deferred, sin
 * writer lock) por snapshot**: los tres `SELECT` corren dentro de esa tx, así
 * que la fotografía es coherente aunque otra conexión WAL confirme una
 * mutación a mitad de lectura. `LIMIT historyLimit+1` decide
 * `historyTruncated` sin un segundo `SELECT`/`COUNT(*)` que pueda rasgar la
 * fotografía.
 *
 * Decisión cerrada de §3.3 — SQL **agent-scoped en cada SELECT**
 * (`WHERE agent_name = ?`): nunca se carga global y se filtra en JS. Un Agent
 * sin filas devuelve snapshot vacío; comprobar que el Agent existe es
 * autorización/lookup del edge en P2, no responsabilidad de Projection.
 *
 * Derivaciones (§3.3): `initiatives` = todos los no terminales (nunca se
 * truncan) en `(created_at, id)` seguidos de los terminales retenidos en
 * `(finished_at DESC, id DESC)`; `agenda` = solo `queued` en `(available_at,
 * id)` con posiciones 1-based; `inbox` = solo `waiting_human` en
 * `(state_changed_at, id)`; `triggers` = habilitados y revocados, con
 * `definition_json` parseado por el mismo parser cerrado de `triggers.ts` — una
 * fila ilegible aborta con `STORAGE_CORRUPT`.
 */

import type { SqliteDb } from "../storage/sqlite.ts";
import { DomainError } from "./errors.ts";
import type { InitiativeMode, InitiativeState } from "./state.ts";
import type { Initiative } from "./initiatives.ts";
import { parseTriggerDefinition, type ParsedSchedule } from "./triggers.ts";

/** Límite de historia retenida por snapshot (plan P1 §3.1): coste y semántica comunes. */
export const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Initiative interna completa, sin redactar. Conserva la fila de dominio
 * incluidas las columnas v2 de reserva de P3; no es un payload HTTP (P2
 * presentará por allowlist).
 */
export interface InternalInitiative extends Initiative {
  readonly humanQuestion: string | null;
  readonly humanExpiresAt: number | null;
  readonly humanRequestId: string | null;
  readonly pendingHumanInput: string | null;
  readonly humanResponseIdempotencyKey: string | null;
  readonly humanResponseCommandHash: string | null;
}

/** Trigger interno completo, sin redactar; conserva la metadata de idempotencia. */
export interface InternalTrigger {
  readonly id: string;
  readonly agentName: string;
  readonly kind: string;
  readonly definition: ParsedSchedule;
  readonly definitionJson: string;
  readonly intent: string;
  readonly mode: InitiativeMode;
  readonly suggestedSkill: string | null;
  readonly createdBy: "owner" | "control_plane" | "agent";
  readonly authority: "owner" | "control_plane";
  readonly proposalState: "proposed" | "approved" | null;
  readonly enabled: boolean;
  readonly nextFireAt: number | null;
  readonly lastFiredAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createIdempotencyKey: string | null;
  readonly createCommandHash: string | null;
}

/** Posición de presentación humana dentro de la agenda, 1-based. */
export interface AgendaEntry {
  readonly position: number;
  readonly initiative: InternalInitiative;
}

/**
 * Fotografía interna de la Agenda de un Agent en `asOf`. Todas las colecciones
 * pertenecen a la transacción que comenzó en la llamada que la produjo.
 */
export interface InternalAutonomySnapshot {
  readonly asOf: number;
  /** No terminales completos (siempre) + terminales retenidos (acotados). */
  readonly initiatives: readonly InternalInitiative[];
  /** Solo `queued`, `(available_at, id)`, posiciones 1..N. */
  readonly agenda: readonly AgendaEntry[];
  /** Solo `waiting_human`, `(state_changed_at, id)`. */
  readonly inbox: readonly InternalInitiative[];
  /** Habilitados y revocados (revocar conserva historia). */
  readonly triggers: readonly InternalTrigger[];
  readonly historyTruncated: boolean;
}

/** Fila cruda de `triggers` (snake_case, tal y como la devuelve el driver). */
interface TriggerRow {
  id: string;
  agent_name: string;
  kind: string;
  definition_json: string;
  intent: string;
  mode: InitiativeMode;
  suggested_skill: string | null;
  created_by: "owner" | "control_plane" | "agent";
  authority: "owner" | "control_plane";
  proposal_state: "proposed" | "approved" | null;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
  create_idempotency_key: string | null;
  create_command_hash: string | null;
}

/** Fila cruda de `initiatives` (snake_case), con las columnas v2 de reserva. */
interface InitiativeRow {
  id: string;
  agent_name: string;
  state: InitiativeState;
  origin: "trigger" | "callback" | "human";
  trigger_id: string | null;
  intent: string;
  mode: InitiativeMode;
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
  human_question: string | null;
  human_expires_at: number | null;
  human_request_id: string | null;
  pending_human_input: string | null;
  human_response_idempotency_key: string | null;
  human_response_command_hash: string | null;
}

const SELECT_INITIATIVE = `
  SELECT id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at,
         human_question, human_expires_at, human_request_id, pending_human_input,
         human_response_idempotency_key, human_response_command_hash
    FROM initiatives
`;

const SELECT_TRIGGERS = `
  SELECT id, agent_name, kind, definition_json, intent, mode, suggested_skill,
         created_by, authority, proposal_state, enabled, next_fire_at,
         last_fired_at, created_at, updated_at, create_idempotency_key,
         create_command_hash
    FROM triggers
`;

/** Los cuatro estados no terminales (nunca se truncan). */
const LIVE_STATES = "('queued','running','waiting_human','waiting_agent')";

/** Los cuatro estados terminales de la historia retenida. */
const HISTORY_STATES = "('succeeded','failed','expired','cancelled')";

function byAvailableAtThenId(a: InternalInitiative, b: InternalInitiative): number {
  if (a.availableAt !== b.availableAt) return a.availableAt - b.availableAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byStateChangedAtThenId(a: InternalInitiative, b: InternalInitiative): number {
  if (a.stateChangedAt !== b.stateChangedAt) return a.stateChangedAt - b.stateChangedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function mapInitiative(row: InitiativeRow): InternalInitiative {
  return {
    id: row.id,
    agentName: row.agent_name,
    state: row.state,
    origin: row.origin,
    triggerId: row.trigger_id,
    intent: row.intent,
    mode: row.mode,
    sessionKey: row.session_key,
    availableAt: row.available_at,
    boundModel: row.bound_model,
    turnId: row.turn_id,
    chainDepth: row.chain_depth,
    chainDeadlineAt: row.chain_deadline_at,
    visibleEffectsDeclared: row.visible_effects_declared === 1,
    summary: row.summary,
    askCorrelation: row.ask_correlation,
    failureReason: row.failure_reason,
    result: row.result,
    createdAt: row.created_at,
    stateChangedAt: row.state_changed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    humanQuestion: row.human_question,
    humanExpiresAt: row.human_expires_at,
    humanRequestId: row.human_request_id,
    pendingHumanInput: row.pending_human_input,
    humanResponseIdempotencyKey: row.human_response_idempotency_key,
    humanResponseCommandHash: row.human_response_command_hash,
  };
}

export class AutonomyProjection {
  private readonly sqlite: SqliteDb;
  private readonly historyLimit: number;

  /**
   * `historyLimit` tiene default cerrado 100; el caller de `snapshotForAgent`
   * no elige un límite por request. Los tests pueden pasar 2.
   */
  constructor(sqlite: SqliteDb, options?: { historyLimit?: number }) {
    this.sqlite = sqlite;
    this.historyLimit = options?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /**
   * Fotografía coherente de la Agenda de `agentName` en `now`. Una sola
   * `BEGIN` (deferred, sin writer lock) abarca los tres `SELECT` (§3.2); ante
   * cualquier error —incluida una definición de Trigger ilegible, que se
   * convierte en `STORAGE_CORRUPT`— se hace `ROLLBACK` y la llamada no devuelve
   * una fotografía parcial.
   */
  snapshotForAgent(agentName: string, now: number): InternalAutonomySnapshot {
    const db = this.sqlite;
    db.exec("BEGIN"); // paso 1: tx de lectura, no toma writer lock
    try {
      // Paso 2: Triggers del Agent, habilitados y revocados, `(created_at, id)`.
      const triggerRows = db
        .prepare(`${SELECT_TRIGGERS} WHERE agent_name = ? ORDER BY created_at, id`)
        .all(agentName) as TriggerRow[];
      const triggers = triggerRows.map((row) => this.mapTrigger(row));

      // Paso 3: no terminales completos, `(created_at, id)`.
      const liveRows = db
        .prepare(
          `${SELECT_INITIATIVE} WHERE agent_name = ? AND state IN ${LIVE_STATES} ORDER BY created_at, id`,
        )
        .all(agentName) as InitiativeRow[];

      // Paso 4: terminales retenidos, `(finished_at DESC, id DESC)`, `LIMIT+1`.
      const terminalRows = db
        .prepare(
          `${SELECT_INITIATIVE} WHERE agent_name = ? AND state IN ${HISTORY_STATES} ORDER BY finished_at DESC, id DESC LIMIT ?`,
        )
        .all(agentName, this.historyLimit + 1) as InitiativeRow[];

      // `LIMIT+1` decide la truncación; solo se devuelven los primeros `historyLimit`.
      const historyTruncated = terminalRows.length > this.historyLimit;
      const retainedTerminalRows = historyTruncated
        ? terminalRows.slice(0, this.historyLimit)
        : terminalRows;

      const live = liveRows.map(mapInitiative);
      const retainedTerminals = retainedTerminalRows.map(mapInitiative);
      const initiatives = [...live, ...retainedTerminals];

      // §3.3: derivaciones sobre la misma fotografía, nunca un segundo SELECT.
      const queued = live
        .filter((initiative) => initiative.state === "queued")
        .slice()
        .sort(byAvailableAtThenId);
      const agenda: AgendaEntry[] = queued.map((initiative, index) => ({
        position: index + 1, // posiciones 1-based de presentación
        initiative,
      }));

      const inbox = live
        .filter((initiative) => initiative.state === "waiting_human")
        .slice()
        .sort(byStateChangedAtThenId);

      db.exec("COMMIT"); // paso 5
      return { asOf: now, initiatives, agenda, inbox, triggers, historyTruncated };
    } catch (error) {
      db.exec("ROLLBACK"); // ante cualquier error, no hay fotografía parcial
      throw error;
    }
  }

  /** `definition_json` se parsea con el parser cerrado de `triggers.ts` (§3.3). */
  private mapTrigger(row: TriggerRow): InternalTrigger {
    let definition: ParsedSchedule;
    try {
      definition = parseTriggerDefinition(row.definition_json);
    } catch (cause) {
      throw new DomainError(
        "STORAGE_CORRUPT",
        `trigger ${row.id} (agent ${row.agent_name}): definition_json ilegible`,
        { cause },
      );
    }
    return {
      id: row.id,
      agentName: row.agent_name,
      kind: row.kind,
      definition,
      definitionJson: row.definition_json,
      intent: row.intent,
      mode: row.mode,
      suggestedSkill: row.suggested_skill,
      createdBy: row.created_by,
      authority: row.authority,
      proposalState: row.proposal_state,
      enabled: row.enabled === 1,
      nextFireAt: row.next_fire_at,
      lastFiredAt: row.last_fired_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createIdempotencyKey: row.create_idempotency_key,
      createCommandHash: row.create_command_hash,
    };
  }
}
