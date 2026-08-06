import type { SqliteDb } from "../storage/sqlite.ts";
import {
  InitiativeRepository,
  type Initiative,
  type TransitionCommand,
} from "./initiatives.ts";
import { TriggerRepository, type DueScheduleTrigger, type Trigger } from "./triggers.ts";
import { CallbackRepository } from "./callbacks.ts";
import { TurnRepository, type ReserveResult, type TurnFinalState, type FailureCause } from "./turns.ts";
import { sqliteErrcode } from "./turns.ts";
import { recoverRunningOnStartup, type StartupRecoveryResult } from "./recovery.ts";
import { canTransition, type InitiativeState } from "./state.ts";
import { DomainError } from "./errors.ts";
import { AutonomyControl, type CreateTriggerCommand, type CreateTriggerResult, type RevokeTriggerCommand, type CancelInitiativeCommand, type CancelInitiativeResult } from "./autonomy-control.ts";
import type { EffectiveTriggerAuthority } from "./triggers.ts";
import {
  AutonomyProjection,
  DEFAULT_HISTORY_LIMIT,
  type InternalAutonomySnapshot,
  type InternalInitiative,
  type InternalTrigger,
} from "./autonomy-projection.ts";

/**
 * Comando estrecho de claim (plan de Fase 3 §4.5, Fase 3.4): el Loop despacha
 * una Initiative reservando T7 (idempotencia) y aplicando T2 (`queued→running`
 * con `turnId`) en la **misma** transacción. El caller entrega solo los datos
 * del despacho; el `agent_name` del turno se toma de la Initiative, nunca del
 * caller, para que la pareja `(agent_name, turn_id)` de la reserva sea la del
 * dueño real de la Agenda.
 *
 * `boundModel` queda **sin fijar** en v1 (el Loop pasa `undefined`; el Agent
 * usa su `AgentConfig.model`, pendiente 5); si llega, se aplica solo cuando
 * `bound_model` era `NULL` (invariante 4), como `initiatives.transition`.
 */
export interface ClaimInitiativeCommand {
  readonly initiativeId: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly boundModel?: string;
}

/**
 * Repositorio de Agenda: bundle de los repositorios de la capa de dominio
 * Agenda (barrel de `agenda/`).
 *
 * Fases 2.2–2.3 — encapsula el `SqliteDb` que entrega `openManagerStore` para
 * que ningún módulo fuera de `agenda/` y `storage/` vuelva a ver el driver. El
 * contrato de seis pasos (§5 del plan de Fase 2) es el contrato interno de
 * cada método; `recoverRunningOnStartup` es el **único bypass** autorizado
 * (ADR 0007, §5.2). Fase 3.4 — `claimInitiative` compone T7+T2 en una sola tx
 * detrás de este seam (plan §4.5). `triggers.ts`/`callbacks.ts`/`turns.ts`
 * (Fase 2.3) quedan disponibles para la Fase posterior y el Loop (Fase 3); la
 * conexión al arranque, en la 2.4.
 */
export class AgendaRepository {
  /** Repositorio de Initiatives: transiciones por CAS y barridos T9/T10. */
  readonly initiatives: InitiativeRepository;
  /** Repositorio de Triggers: disparo T1 (Initiative + avance en una tx). */
  readonly triggers: TriggerRepository;
  /** Repositorio de Callbacks: entrega T5 (Initiative + fila + reactivación). */
  readonly callbacks: CallbackRepository;
  /** Repositorio de turnos: idempotencia T7 y terminal T6. */
  readonly turns: TurnRepository;

  /**
   * Proyección de Autonomy (P1.2): la lectura única de la Agenda que
   * compartirán `/api/v1` y el panel. Una sola transacción por snapshot y SQL
   * agent-scoped en cada SELECT (plan P1 §3).
   */
  readonly projection: AutonomyProjection;

  /** Driver encapsulado; solo los repos de `agenda/` lo usan. */
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb, options?: { autonomyHistoryLimit?: number }) {
    this.sqlite = sqlite;
    this.initiatives = new InitiativeRepository(sqlite);
    this.triggers = new TriggerRepository(sqlite, this.initiatives);
    this.callbacks = new CallbackRepository(sqlite, this.initiatives);
    this.turns = new TurnRepository(sqlite);
    this.projection = new AutonomyProjection(sqlite, {
      historyLimit: options?.autonomyHistoryLimit ?? DEFAULT_HISTORY_LIMIT,
    });
  }

  /**
   * ADR 0007 + red de seguridad de cadena, en una sola `BEGIN IMMEDIATE`
   * (§7). La Fase 2.4 la insertará en `index.ts` entre `provisionAgents` y
   * `new Supervisor`. `STARTUP_RECOVERY_FAILED` aborta el arranque (§7.4).
   */
  recoverRunningOnStartup(now: number): StartupRecoveryResult {
    return recoverRunningOnStartup(this.sqlite, now);
  }

  /**
   * Claim unificado del despacho (plan de Fase 3 §4.5, Fase 3.4): compone T7
   * (reserva durable de idempotencia, `turns.ts`) y T2 (`queued→running` con
   * `turnId`, `initiatives.ts`) en **una sola** `BEGIN IMMEDIATE`, sin
   * reinventar ni la máquina de estados (`canTransition`, `state.ts`) ni el
   * CAS `WHERE state = :expected_from` de la Fase 2.2 — las sigue usando por
   * dentro.
   *
   * Por qué una sola tx y no two-step (§8.1): si el CAS de T2 perdiera la
   * carrera tras reservar T7, la reserva quedaría huérfana (pendiente 4).
   * Aquí, o el claim queda `running` con su turno, o el `ROLLBACK` no deja
   * nada: la Initiative gana o no hay fotografía que descartar.
   *
   * Devuelve la Initiative ya `running`. Lanza `INITIATIVE_NOT_FOUND` si la
   * Initiative no existe, `INITIATIVE_STATE_CONFLICT` si ya no está `queued`
   * (carrera perdida — el estado durable decide el siguiente `tick`) y
   * `TURN_ID_CONFLICT` si la pareja `(agent_name, turn_id)` o la
   * `idempotency_key` ya están reservadas por otro turno.
   */
  claimInitiative(command: ClaimInitiativeCommand): Initiative {
    const { initiativeId, turnId, idempotencyKey, now } = command;
    const db = this.sqlite;

    // Paso 3 del contrato (§5.1): la autoridad declarativa se llama **antes**
    // de tocar disco. El claim aplica T2, siempre `queued→running`; un fallo
    // aquí es un bug del caller, no una carrera.
    if (!canTransition("queued", "running")) {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `initiative ${initiativeId}: claim queued -> running no es legal (§4.2)`,
      );
    }

    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer la Initiative dentro de la transacción. Su `agent_name`
      // es el dueño de la Agenda y cualifica la reserva de turno.
      const row = db
        .prepare("SELECT agent_name, state, started_at, bound_model FROM initiatives WHERE id = ?")
        .get(initiativeId) as
        | { agent_name: string; state: InitiativeState; started_at: number | null; bound_model: string | null }
        | undefined;
      if (!row) {
        throw new DomainError("INITIATIVE_NOT_FOUND", `initiative ${initiativeId} no existe`);
      }
      if (row.state !== "queued") {
        // El estado durable ya no es el que el claim exige: otro escritor ganó
        // la carrera (§12.4). El ROLLBACK descarta también la reserva T7.
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${initiativeId}: esperaba queued, durable es ${row.state}`,
        );
      }

      // T7 (§6) dentro de la misma tx: reserva durable de idempotencia. El
      // `agent_name` es el de la Initiative, no uno que el caller declare.
      try {
        db.prepare(
          "INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at) VALUES (?,?,?,?)",
        ).run(row.agent_name, turnId, idempotencyKey, now);
      } catch (error) {
        throw this.turnConflictOf(error, row.agent_name, turnId, idempotencyKey);
      }

      // T2 (§6): `queued→running` con `turnId`, por CAS `WHERE state='queued'`
      // (autoridad operativa, Fase 2.2). `started_at`/`bound_model` solo si
      // eran NULL (invariante 4), como `buildPatch` de `initiatives.ts`.
      const patch: Record<string, string | number | null> = {
        state: "running",
        state_changed_at: now,
        turn_id: turnId,
      };
      if (row.started_at === null) patch.started_at = now;
      if (row.bound_model === null && command.boundModel !== undefined) {
        patch.bound_model = command.boundModel;
      }
      const columns = Object.keys(patch);
      const sets = columns.map((c) => `${c} = ?`).join(", ");
      const values = columns.map((c) => patch[c]);
      const result = db
        .prepare(`UPDATE initiatives SET ${sets} WHERE id = ? AND state = 'queued'`)
        .run(...values, initiativeId);
      if (Number(result.changes) !== 1) {
        // Guard defensivo: dentro de `BEGIN IMMEDIATE` nadie más pudo cambiar
        // la fila entre la lectura y el UPDATE; si aun así no fue exactamente
        // una, la carrera se perdió y el ROLLBACK no deja reserva huérfana.
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${initiativeId}: el CAS del claim no cambió exactamente una fila (${String(result.changes)})`,
        );
      }

      db.exec("COMMIT"); // paso 6: reserva y transición se confirman juntas.
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.initiatives.get(initiativeId);
  }

  /**
   * Traduce la violación de unicidad de la reserva T7 al catálogo de dominio,
   * distinguiendo los dos casos como `reserveIdempotency` (`turns.ts`): si la
   * `idempotency_key` ya está reservada por otro turno, o si la pareja
   * `(agent_name, turn_id)` ya existe con otra key. Ambos son
   * `TURN_ID_CONFLICT` para el claim (el plan §4.5 no contempla el duplicado
   * del two-step: el Loop genera keys frescas). Cualquier otro error se
   * re-propaga tal cual.
   */
  private turnConflictOf(
    error: unknown,
    agentName: string,
    turnId: string,
    idempotencyKey: string,
  ): unknown {
    const errcode = sqliteErrcode(error);
    if (errcode !== 2067 && errcode !== 1555) return error;
    const existing = this.sqlite
      .prepare("SELECT turn_id FROM turns WHERE idempotency_key = ?")
      .get(idempotencyKey) as { turn_id: string } | undefined;
    if (existing !== undefined) {
      return new DomainError(
        "TURN_ID_CONFLICT",
        `claim (${agentName}, ${turnId}): idempotency_key ya reservada por el turno ${existing.turn_id}`,
      );
    }
    return new DomainError(
      "TURN_ID_CONFLICT",
      `claim (${agentName}, ${turnId}): la pareja ya existe con otra idempotency_key`,
    );
  }
}

export {
  InitiativeRepository,
  TriggerRepository,
  CallbackRepository,
  TurnRepository,
  AutonomyProjection,
  AutonomyControl,
};
export type {
  Initiative,
  TransitionCommand,
  StartupRecoveryResult,
  ReserveResult,
  TurnFinalState,
  FailureCause,
  DueScheduleTrigger,
  Trigger,
  CreateTriggerCommand,
  CreateTriggerResult,
  RevokeTriggerCommand,
  CancelInitiativeCommand,
  CancelInitiativeResult,
  EffectiveTriggerAuthority,
  InternalAutonomySnapshot,
  InternalInitiative,
  InternalTrigger,
};
