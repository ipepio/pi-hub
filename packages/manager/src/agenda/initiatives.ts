/**
 * InitiativeRepository — Fase 2.2 del plan de Fase 2 (`/tmp/f2plan.md`).
 *
 * Todo comando de escritura sigue el contrato de seis pasos del §5, sin
 * excepción:
 *   1. `BEGIN IMMEDIATE`
 *   2. leer la Initiative dentro de la transacción
 *   3. `canTransition` (autoridad declarativa, §5.1) decide antes de tocar
 *      disco — o `INITIATIVE_TRANSITION_ILLEGAL`
 *   4. validar invariantes multi-fila (4 y 6 del esquema; los `CHECK` de fila
 *      ya los cubre el motor)
 *   5. escribir por CAS: `UPDATE ... WHERE id=:id AND state=:expected_from`;
 *      si no cambia **exactamente una fila** → `INITIATIVE_STATE_CONFLICT` y
 *      rollback
 *   6. confirmar todas las filas relacionadas en el mismo `COMMIT`
 *
 * `canTransition` es la autoridad declarativa (qué es legal); el `WHERE
 * state=:expected_from` es la autoridad operativa (quién gana la carrera,
 * §5.1). La legalidad se juzga sobre el `from` **declarado por el caller**:
 * si el estado durable ya no es ese, no es un bug sino una carrera
 * (`INITIATIVE_STATE_CONFLICT`, distinto de `INITIATIVE_TRANSITION_ILLEGAL`,
 * §12.4).
 *
 * El único bypass del contrato es `recoverRunningOnStartup` (ADR 0007, §5.2),
 * que vive en `recovery.ts`. No hay ningún otro camino que escriba estado sin
 * pasar por la función pura: los barridos T9/T10 solo tocan filas cuyo estado
 * está en `legalSourcesFor(...)` — la propia `canTransition` aplicada en lote.
 */

import type { SqliteDb } from "../storage/sqlite.ts";
import {
  canTransition,
  canChangeMode,
  legalSourcesFor,
  type InitiativeMode,
  type InitiativeState,
} from "./state.ts";
import { DomainError } from "./errors.ts";

/** Initiative tal y como la expone el repositorio (columnas en camelCase). */
export interface Initiative {
  readonly id: string;
  readonly agentName: string;
  readonly state: InitiativeState;
  readonly origin: "trigger" | "callback" | "human";
  readonly triggerId: string | null;
  readonly intent: string;
  readonly mode: InitiativeMode;
  readonly sessionKey: string;
  readonly availableAt: number;
  readonly boundModel: string | null;
  readonly turnId: string | null;
  readonly chainDepth: number;
  readonly chainDeadlineAt: number | null;
  readonly visibleEffectsDeclared: boolean;
  readonly summary: string | null;
  readonly askCorrelation: string | null;
  readonly failureReason: string | null;
  readonly result: string | null;
  readonly createdAt: number;
  readonly stateChangedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * Comando tipado de transición (§5 paso 3). `from` es el estado que el caller
 * leyó; `to`, el destino. Los campos opcionales se interpretan según el par
 * (`from`,`to`) — ver `buildPatch`. Un campo obligatorio ausente para esa
 * transición lanza `INITIATIVE_INVARIANT_VIOLATION` (§5 paso 4).
 */
export interface TransitionCommand {
  readonly id: string;
  readonly from: InitiativeState;
  readonly to: InitiativeState;
  readonly now: number;
  /** `running→waiting_human` — obligatorio (el `CHECK` del motor lo respalda). */
  readonly summary?: string;
  /** `running→waiting_human` — se conserva si llega (forma: pendiente 11). */
  readonly askCorrelation?: string;
  /** `running→waiting_agent` — obligatorio (invariante 6). */
  readonly chainDeadlineAt?: number;
  /** `waiting_human|waiting_agent→queued` (reanudación) — obligatorio. */
  readonly availableAt?: number;
  /** `queued→running` — enlaza el turno despachado. */
  readonly turnId?: string;
  /** `queued→running` — solo se fija si `bound_model` era NULL (invariante 4). */
  readonly boundModel?: string;
  /** `running→succeeded` — el resultado observado en el terminal. */
  readonly result?: string;
  /** `→failed` — obligatorio; `failure_reason` es un dato estable (§9.1). */
  readonly failureReason?: string;
}

/** Fila cruda de `initiatives` (snake_case, tal y como la devuelve el driver). */
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
}

const SELECT_INITIATIVE = `
  SELECT id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at
    FROM initiatives
`;

function mapRow(row: InitiativeRow): Initiative {
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
  };
}

export class InitiativeRepository {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  /** Lee una Initiative por `id`; `INITIATIVE_NOT_FOUND` si no existe (§9.1). */
  get(id: string): Initiative {
    const row = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE id = ?`)
      .get(id) as InitiativeRow | undefined;
    if (!row) {
      throw new DomainError("INITIATIVE_NOT_FOUND", `initiative ${id} no existe`);
    }
    return mapRow(row);
  }

  /** `queued` con `available_at` vencido, por orden de disponibilidad (índice `initiatives_due`). */
  listDue(now: number): readonly Initiative[] {
    const rows = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE state = 'queued' AND available_at <= ? ORDER BY available_at, id`)
      .all(now) as InitiativeRow[];
    return rows.map(mapRow);
  }

  /** Todas las Initiatives `running` (índice parcial `initiatives_running_at_startup`). */
  listRunning(): readonly Initiative[] {
    const rows = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE state = 'running' ORDER BY id`)
      .all() as InitiativeRow[];
    return rows.map(mapRow);
  }

  /**
   * Contrato de seis pasos (§5) para una transición. Devuelve la Initiative ya
   * confirmada. Lanza `INITIATIVE_TRANSITION_ILLEGAL` antes de tocar disco
   * (bug del caller), `INITIATIVE_NOT_FOUND` si no existe, `INITIATIVE_STATE_CONFLICT`
   * si la carrera se perdió y `INITIATIVE_INVARIANT_VIOLATION` si falta un
   * campo obligatorio de la transición.
   */
  transition(command: TransitionCommand): Initiative {
    // Paso 3 del contrato (§5.1): `canTransition` es la autoridad declarativa,
    // se llama **antes** del `UPDATE` y sin tocar disco. Un comando ilegal es
    // un bug del caller: se rechaza incluso antes de tomar el lock de
    // escritura. La legalidad se juzga sobre el `from` declarado — si el
    // estado durable ya no es ese, es una carrera, no un bug (§12.4).
    if (!canTransition(command.from, command.to)) {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `initiative ${command.id}: transición ${command.from} -> ${command.to} no es legal (§4.2)`,
      );
    }

    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer la Initiative dentro de la transacción.
      const row = db
        .prepare(`${SELECT_INITIATIVE} WHERE id = ?`)
        .get(command.id) as InitiativeRow | undefined;
      if (!row) {
        throw new DomainError("INITIATIVE_NOT_FOUND", `initiative ${command.id} no existe`);
      }
      // El estado durable ya no es el que el caller declaró: otro escritor
      // ganó la carrera (el `from` era válido al leer, §5.1).
      if (row.state !== command.from) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: esperaba ${command.from}, durable es ${row.state}`,
        );
      }
      // Paso 4: invariantes multi-fila de la transición (4, 6 y campos
      // obligatorios del comando). Los `CHECK` de fila los cubre el motor.
      const patch = this.buildPatch(command, row);
      // Paso 5: CAS con optimistic locking (`WHERE state = :expected_from`).
      const changes = this.applyPatch(db, command.id, command.from, patch);
      if (changes !== 1) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: el CAS no cambió exactamente una fila (${changes})`,
        );
      }
      db.exec("COMMIT"); // paso 6
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.get(command.id);
  }

  /**
   * T9 (§6): red de seguridad de cadena. Pasa a `failed` con
   * `failure_reason='chain_deadline_exceeded'` toda Initiative no terminal con
   * `chain_deadline_at` vencido. Devuelve el nº de filas afectadas.
   *
   * El `WHERE state IN (...)` se deriva de `legalSourcesFor('failed')`: solo se
   * tocan filas donde la propia `canTransition` dice que la transición a
   * `failed` es legal — la función pura aplicada en lote (§5.2).
   */
  sweepChainDeadline(now: number): number {
    const from = legalSourcesFor("failed");
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = from.map(() => "?").join(", ");
      const result = db
        .prepare(
          `UPDATE initiatives
              SET state = 'failed', failure_reason = 'chain_deadline_exceeded',
                  finished_at = ?, state_changed_at = ?
            WHERE state IN (${placeholders})
              AND chain_deadline_at IS NOT NULL AND chain_deadline_at <= ?`,
        )
        .run(now, now, ...from, now);
      db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * T10 (§6): caducidad de Agent Policy. Pasa a `expired` toda Initiative
   * `waiting_human` cuyo `state_changed_at` venció. Devuelve el nº de filas.
   *
   * El `WHERE state IN (...)` se deriva de `legalSourcesFor('expired')` — solo
   * `waiting_human` caduca (`CONTEXT.md:40`); de nuevo, la función pura
   * aplicada en lote, nunca un hardcode aparte.
   */
  sweepWaitingHumanExpiry(now: number): number {
    const from = legalSourcesFor("expired");
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = from.map(() => "?").join(", ");
      const result = db
        .prepare(
          `UPDATE initiatives
              SET state = 'expired', finished_at = ?, state_changed_at = ?
            WHERE state IN (${placeholders})
              AND state_changed_at <= ?`,
        )
        .run(now, now, ...from, now);
      db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Patch SQL de la transición (paso 4: invariantes y campos obligatorios). */
  private buildPatch(
    command: TransitionCommand,
    row: InitiativeRow,
  ): Record<string, string | number | null> {
    const patch: Record<string, string | number | null> = {
      state: command.to,
      state_changed_at: command.now,
    };
    switch (command.to) {
      case "running": {
        // T2 (queued→running): `started_at` y `bound_model` solo si eran NULL
        // (invariante 4); el turno despachado se enlaza.
        if (row.started_at === null) patch.started_at = command.now;
        if (row.bound_model === null && command.boundModel !== undefined) {
          patch.bound_model = command.boundModel;
        }
        if (command.turnId !== undefined) patch.turn_id = command.turnId;
        break;
      }
      case "waiting_human": {
        // §4.1: el `CHECK state<>'waiting_human' OR summary IS NOT NULL` exige
        // summary en la misma tx; el escalado es solo→ask (nunca ask→solo).
        if (typeof command.summary !== "string" || command.summary.length === 0) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: waiting_human exige summary (CHECK del esquema)`,
          );
        }
        patch.summary = command.summary;
        if (command.askCorrelation !== undefined) patch.ask_correlation = command.askCorrelation;
        if (canChangeMode(row.mode, "ask")) patch.mode = "ask";
        break;
      }
      case "waiting_agent": {
        // Invariante 6: delegar fija `chain_deadline_at`.
        if (command.chainDeadlineAt === undefined) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: delegar exige chain_deadline_at (invariante 6)`,
          );
        }
        patch.chain_deadline_at = command.chainDeadlineAt;
        break;
      }
      case "queued": {
        // Reanudación (waiting_human/waiting_agent → queued, §4.1): fija
        // `available_at`; `session_key` y `bound_model` se conservan porque no
        // se tocan. El Loop recoloca el despacho bajo su control (ADR 0004).
        if (command.availableAt === undefined) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: reanudar exige available_at`,
          );
        }
        patch.available_at = command.availableAt;
        break;
      }
      case "succeeded": {
        patch.finished_at = command.now;
        if (command.result !== undefined) patch.result = command.result;
        break;
      }
      case "failed": {
        // `failure_reason` es un dato estable (§9.1), nunca NULL en una fila
        // `failed` creada por una transición.
        if (command.failureReason === undefined || command.failureReason.length === 0) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: failed exige failure_reason`,
          );
        }
        patch.failure_reason = command.failureReason;
        patch.finished_at = command.now;
        break;
      }
      case "expired":
      case "cancelled": {
        patch.finished_at = command.now;
        break;
      }
    }
    return patch;
  }

  /**
   * CAS del paso 5: `UPDATE ... WHERE id=:id AND state=:expected_from`. El
   * retorno es el nº de filas cambiadas (debe ser exactamente 1).
   */
  private applyPatch(
    db: SqliteDb,
    id: string,
    expectedFrom: InitiativeState,
    patch: Record<string, string | number | null>,
  ): number {
    const columns = Object.keys(patch);
    const sets = columns.map((c) => `${c} = ?`).join(", ");
    const values = columns.map((c) => patch[c]);
    const result = db
      .prepare(`UPDATE initiatives SET ${sets} WHERE id = ? AND state = ?`)
      .run(...values, id, expectedFrom);
    return Number(result.changes);
  }
}
