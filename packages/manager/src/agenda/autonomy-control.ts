/**
 * AutonomyControl — P1 del plan P1 (plan §4).
 *
 * Superficie de **escritura** de la autonomía. P1.3 entrega `createTrigger` y
 * P1.4 añade `revokeTrigger`; cancel/respond son sub-fases posteriores que
 * ampliarán esta misma clase.
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
 *   - El modo y la autoridad se **inyectan**, NO se infieren del bearer ni de
 *     la cookie: un Bearer usado por el operador en Gobernador sigue actuando
 *     bajo autoridad `owner`. `AutonomyControl` no autentica, no conoce Hono y
 *     no redacta — es política de dominio configurada, no inferencia de
 *     credenciales (P2 aplicará el principal).
 */

import type { AgendaRepository } from "./index.ts";
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

export class AutonomyControl {
  private readonly agenda: AgendaRepository;
  private readonly authority: EffectiveTriggerAuthority;

  /**
   * `authority` es la autoridad efectiva del proceso, derivada **una vez** del
   * modo (`env.panelEnabled`) en el arranque; nunca se infiere por request.
   */
  constructor(options: {
    agenda: AgendaRepository;
    authority: EffectiveTriggerAuthority;
  }) {
    this.agenda = options.agenda;
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
}
