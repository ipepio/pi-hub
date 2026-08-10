/**
 * AutonomyControl — P1 del plan P1 (plan §4).
 *
 * Superficie de **escritura** de la autonomía. P1.3 entrega `createTrigger`,
 * P1.4 añade `revokeTrigger` y P1.5 añade `cancelInitiative`.
 *
 * Decisiones cerradas del plan P1:
 *
 *   - Solo create `version: 2` (`daily`/`weekly`); `version: 1` es
 *     read/execute-only — se lee y se dispara, no se crea.
 *   - La key de idempotencia va scoped por Agent; el hash es sobre el comando
 *     canónico. La misma key en otro Agent crea otro Trigger (correcto, no un
 *     bug).
 *   - El caller no aporta `created_by`, `authority`, ID, `enabled` ni el
 *     próximo disparo: los materializa el repositorio.
 *   - Revoke deshabilita el Trigger y anula `next_fire_at`; repetirlo es éxito
 *     y nunca reescribe `created_by`.
 *   - Cancelar una Initiative `running` SOLO por `TurnExecution.abort` +
 *     terminal T6: no existe un write optimista `running→cancelled`. La
 *     ventana connecting (abort no encuentra el handle) queda expuesta como
 *     `INITIATIVE_STATE_CONFLICT` hasta P4.
 *   - El modo y la autoridad se **inyectan**, NO se infieren del bearer ni de
 *     la cookie: un Bearer usado por el operador en Gobernador sigue actuando
 *     bajo autoridad `owner`. `AutonomyControl` no autentica, no conoce Hono y
 *     no redacta — es política de dominio configurada, no inferencia de
 *     credenciales (P2 aplicará el principal).
 */

import type { AgendaRepository } from "./index.ts";
import type { Initiative } from "./initiatives.ts";
import type { TurnExecution } from "./turn-execution.ts";
import { DomainError } from "./errors.ts";
import type {
  CreateTriggerCommand as RepositoryCreateTriggerCommand,
  CreateTriggerResult,
  EffectiveTriggerAuthority,
  RevokeTriggerCommand as RepositoryRevokeTriggerCommand,
  Trigger,
} from "./triggers.ts";

/**
 * Comando público de `createTrigger` (plan P1 §4.1): recibe `agentName`,
 * `definition` v2, `intent`, `mode`, `suggestedSkill`, `idempotencyKey` y
 * `now`. No recibe principal, token, cookie, Hono ni un `SqliteDb`; y no
 * aporta `authority`/`created_by` — se inyectan en el constructor.
 */
export type CreateTriggerCommand = Omit<RepositoryCreateTriggerCommand, "authority">;

/**
 * Comando público de `revokeTrigger` (plan P1 §4.2): recibe `agentName`,
 * `triggerId` y `now`; la `authority` se inyecta en el constructor.
 */
export type RevokeTriggerCommand = Omit<RepositoryRevokeTriggerCommand, "authority">;

/** Resultado de `createTrigger`: el Trigger creado o reencontrado y si fue replay. */
export type { CreateTriggerResult } from "./triggers.ts";

/**
 * Comando de `cancelInitiative` (plan P1 §6.2): `agentName`, `initiativeId` y
 * `now`. No recibe principal, token, cookie, Hono ni un `SqliteDb`; el abort
 * del turno se inyecta en el constructor.
 */
export interface CancelInitiativeCommand {
  readonly agentName: string;
  readonly initiativeId: string;
  readonly now: number;
}

/**
 * Resultado de `cancelInitiative`:
 *
 * - `{status:"cancelled"}` — la Initiative quedó `cancelled` (CAS de un estado
 *   en reposo) o ya lo estaba (éxito idempotente, sin escritura).
 * - `{status:"cancellation_requested"}` — la Initiative `running` tiene un
 *   turno vivo y `TurnExecution.abort` lo marcó para abortar; el terminal
 *   `running→cancelled` lo escribirá TurnExecution/terminal T6, nunca Control.
 */
export type CancelInitiativeResult =
  | { readonly status: "cancelled"; readonly initiative: Initiative }
  | { readonly status: "cancellation_requested"; readonly initiative: Initiative };

/**
 * Comando de `respondToInitiative` (plan P1 §6.3): `agentName`, `initiativeId`,
 * `answer`, `idempotencyKey` y `now`. No recibe principal, token, cookie, Hono
 * ni un `SqliteDb`. La respuesta no se loguea y el hash es sobre la forma
 * canónica `{initiativeId, answer}`.
 */
export interface RespondInitiativeCommand {
  readonly agentName: string;
  readonly initiativeId: string;
  readonly answer: string;
  readonly idempotencyKey: string;
  readonly now: number;
  /** P3.2/B1: request humano que el respondedor declara contestar (opcional). */
  readonly expectedHumanRequestId?: string | null;
}

/**
 * Resultado de `respondToInitiative`: la Initiative y si fue replay idempotente.
 * `replayed:true` no reencola: la respuesta ya se había absorbido (también
 * después de un claim, gracias a que la key/hash persisten).
 */
export type RespondInitiativeResult = {
  readonly initiative: Initiative;
  readonly replayed: boolean;
};

export class AutonomyControl {
  private readonly agenda: AgendaRepository;
  private readonly turns: Pick<TurnExecution, "abort">;
  private readonly authority: EffectiveTriggerAuthority;

  /**
   * `authority` es la autoridad efectiva del proceso, derivada **una vez** del
   * modo (`env.panelEnabled`) en el arranque; nunca se infiere por request.
   * `turns` es solo el `abort` que la cancelación de una Initiative `running`
   * necesita (plan P1 §4): es el único camino de cancelación de un turno vivo.
   */
  constructor(options: {
    agenda: AgendaRepository;
    turns: Pick<TurnExecution, "abort">;
    authority: EffectiveTriggerAuthority;
  }) {
    this.agenda = options.agenda;
    this.turns = options.turns;
    this.authority = options.authority;
  }

  /**
   * Crea un Trigger schedule v2 idempotente. Delega el CAS de idempotencia al
   * repositorio y materializa aquí la autoridad efectiva inyectada. Devuelve
   * `{ trigger, replayed }`: `replayed=true` cuando la misma key y el mismo
   * comando canónico ya existían (mismo ID, sin segunda fila).
   */
  createTrigger(command: CreateTriggerCommand): CreateTriggerResult {
    return this.agenda.triggers.createTrigger({
      ...command,
      authority: this.authority,
    });
  }

  /**
   * Revoca un Trigger (plan P1 §4.2). Deshabilita el Trigger y anula
   * `next_fire_at`; repetirlo es éxito idempotente y nunca reescribe
   * `created_by`. Un ID de otro Agent es indistinguible de inexistente
   * (`TRIGGER_NOT_FOUND`); un Trigger cuya `authority` no coincide con la
   * efectiva es `TRIGGER_AUTHORITY_CONFLICT` (fail-closed). Delega el CAS al
   * repositorio y materializa aquí la autoridad efectiva inyectada.
   */
  revokeTrigger(command: RevokeTriggerCommand): Trigger {
    return this.agenda.triggers.revokeTrigger({
      ...command,
      authority: this.authority,
    });
  }

  /**
   * Cancela una Initiative (plan P1 §6.2, matriz completa). Toda lectura y
   * UPDATE va scoped por `(id, agent_name)`: un ID de otra Agenda es
   * `INITIATIVE_NOT_FOUND`, indistinguible de uno inexistente.
   *
   * Estados en reposo (`queued`, `waiting_human`, `waiting_agent`) → CAS
   * directo a `cancelled` por el repositorio. `cancelled` repetido es éxito
   * idempotente sin escritura; `succeeded|failed|expired` es
   * `INITIATIVE_STATE_CONFLICT`.
   *
   * `running` → **solo** por `TurnExecution.abort` + terminal T6; nunca se
   * escribe `cancelled` en la fila mientras el turno sigue generando. Si el
   * abort encuentra el handle devuelve `{status:"cancellation_requested"}`
   * (T6 escribirá el terminal). Si no lo encuentra (ventana connecting, P4),
   * se relee: `cancelled` es éxito idempotente; cualquier otro estado durable
   * es `INITIATIVE_STATE_CONFLICT` — nunca se falsea una cancelación.
   */
  cancelInitiative(command: CancelInitiativeCommand): CancelInitiativeResult {
    const { agentName, initiativeId, now } = command;
    // Lectura inicial agent-scoped: decide el camino (reposo → CAS; running → abort).
    const observed = this.agenda.initiatives.getForAgent(initiativeId, agentName);
    if (observed.state === "running") {
      return this.cancelRunning(observed);
    }
    const initiative = this.agenda.initiatives.cancelForAgent(initiativeId, agentName, now);
    return { status: "cancelled", initiative };
  }

  /**
   * Camino de una Initiative durablemente `running` (§6.2): abort + relectura.
   * Ninguna rama escribe la fila: el terminal `running→cancelled` lo escribe
   * TurnExecution (T6), no Control.
   */
  private cancelRunning(initiative: Initiative): CancelInitiativeResult {
    if (initiative.turnId === null) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `initiative ${initiative.id}: running sin turn_id no tiene turno que abortar`,
      );
    }
    const aborted = this.turns.abort(initiative.agentName, initiative.turnId);
    if (aborted) {
      return { status: "cancellation_requested", initiative };
    }
    // Abort no encontró el handle: releer para no falsear una cancelación.
    const current = this.agenda.initiatives.getForAgent(initiative.id, initiative.agentName);
    if (current.state === "cancelled") {
      // T6 (u otro camino) ya la canceló mientras tanto: éxito idempotente.
      return { status: "cancelled", initiative: current };
    }
    throw new DomainError(
      "INITIATIVE_STATE_CONFLICT",
      `initiative ${initiative.id}: abort no encontró el turno y durable sigue ${current.state}`,
    );
  }

  /**
   * Responde a una Initiative en `waiting_human` (plan P1 §6.3): la vuelve a
   * `queued` con la `answer` depositada como pending, para que el Loop la
   * retome con su dispatch normal. Control no despacha ni llama al Runner: el
   * Loop sigue siendo el dispatcher único y la Initiative conserva su
   * `session_key` — la respuesta llega al hilo que preguntó, no a uno nuevo.
   *
   * La idempotencia es de respuesta (primera key gana): el replay de la misma
   * key se absorbe sea cual sea el estado actual; una key nueva cuando ya salió
   * de `waiting_human` es `INITIATIVE_STATE_CONFLICT`. Delega el CAS al
   * repositorio (`initiatives.respondForAgent`).
   */
  respondToInitiative(command: RespondInitiativeCommand): RespondInitiativeResult {
    return this.agenda.initiatives.respondForAgent({
      id: command.initiativeId,
      agentName: command.agentName,
      answer: command.answer,
      idempotencyKey: command.idempotencyKey,
      now: command.now,
      expectedHumanRequestId: command.expectedHumanRequestId,
    });
  }
}
