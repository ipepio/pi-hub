import type { SqliteDb } from "../storage/sqlite.ts";
import { InitiativeRepository, type Initiative, type TransitionCommand } from "./initiatives.ts";
import { TriggerRepository } from "./triggers.ts";
import { CallbackRepository } from "./callbacks.ts";
import { TurnRepository, type ReserveResult, type TurnFinalState } from "./turns.ts";
import { recoverRunningOnStartup, type StartupRecoveryResult } from "./recovery.ts";

/**
 * Repositorio de Agenda: bundle de los repositorios de la capa de dominio
 * Agenda (barrel de `agenda/`).
 *
 * Fases 2.2–2.3 — encapsula el `SqliteDb` que entrega `openManagerStore` para
 * que ningún módulo fuera de `agenda/` y `storage/` vuelva a ver el driver. El
 * contrato de seis pasos (§5 del plan de Fase 2) es el contrato interno de
 * cada método; `recoverRunningOnStartup` es el **único bypass** autorizado
 * (ADR 0007, §5.2). `triggers.ts`/`callbacks.ts`/`turns.ts` (Fase 2.3) quedan
 * disponibles para la Fase posterior y el Loop (Fase 3); la conexión al
 * arranque, en la 2.4.
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

  /** Driver encapsulado; solo los repos de `agenda/` lo usan. */
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
    this.initiatives = new InitiativeRepository(sqlite);
    this.triggers = new TriggerRepository(sqlite, this.initiatives);
    this.callbacks = new CallbackRepository(sqlite, this.initiatives);
    this.turns = new TurnRepository(sqlite);
  }

  /**
   * ADR 0007 + red de seguridad de cadena, en una sola `BEGIN IMMEDIATE`
   * (§7). La Fase 2.4 la insertará en `index.ts` entre `provisionAgents` y
   * `new Supervisor`. `STARTUP_RECOVERY_FAILED` aborta el arranque (§7.4).
   */
  recoverRunningOnStartup(now: number): StartupRecoveryResult {
    return recoverRunningOnStartup(this.sqlite, now);
  }
}

export {
  InitiativeRepository,
  TriggerRepository,
  CallbackRepository,
  TurnRepository,
};
export type {
  Initiative,
  TransitionCommand,
  StartupRecoveryResult,
  ReserveResult,
  TurnFinalState,
};
