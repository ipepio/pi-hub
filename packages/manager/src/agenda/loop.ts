/**
 * AgendaLoop — Fase 3.5 del plan de Fase 3
 * (`docs/design-autonomia-loop-schedule.md` §2, §4, §5, §6, §9.5).
 *
 * El dispatcher central: saca Initiatives `queued` de las Agendas y las
 * ejecuta como turnos por `TurnExecution`, respetando el dial de concurrencia
 * global y la exclusión por Agent (ADR 0004: nunca dos Initiatives del mismo
 * Agent en paralelo; un humano sí puede conversar mientras una corre). Vive en
 * `agenda/loop.ts` (D1), arranca después de `serve` (D2) y compone el cierre
 * de `runStartup` **antes** de `stopAll` (§1.3, D3).
 *
 * Orden del `tick` (§2.1): barridos T9/T10 → disparo de Triggers `schedule`
 * vencidos → despacho de Initiatives `queued`. Cada paso es idempotente: sus
 * efectos viven en transacciones atómicas del repo; si el `tick` cae a mitad,
 * el siguiente recoloca. El `tick` es síncrono y breve (no espera al Runner:
 * el terminal llega asíncrono por `turns.complete`, §4.4) y se auto-programa
 * con `setTimeout(tick, tickIntervalMs)` — no `setInterval` (evita reentrada).
 *
 * Dial de concurrencia (§2.2): `listRunning()` en disco es la fuente de
 * verdad (la misma que ya ve la recuperación ADR 0007 y `turns.complete`). El
 * `Set` en memoria de los `TurnHandle` que ESTE Loop despachó sirve **solo**
 * para disparar un `tick` inmediato cuando uno resuelve (wakeup); no es
 * fuente de verdad — si se pierde, el próximo `tick` periódico reevalúa desde
 * disco. Es una optimización de latencia, no de corrección.
 *
 * Selección (§2.3): round-robin entre Agents con cursor efímero en memoria y
 * FIFO dentro de cada Agent (`listDue` ya devuelve por `(available_at, id)`).
 * El cursor se pierde al reiniciar sin afectar corrección.
 *
 * Matriz del estado del Agent (§5.1, D12/D13): `running` → despacha;
 * `stopped`/arrancando → sigue `queued` (reevalúa); **`errored` → `failed`**
 * con `failure_reason='agent_errored'` (decisión del coordinador). Un Agent
 * inexistente devuelve `stopped` en `supervisor.state` y se trata igual que
 * `stopped` (tensión señalada en §5.1, no resuelta: se queda `queued`).
 *
 * Despacho (§4.5, §4.2): claim unificado (`claimInitiative`, T7+T2 en una
 * sola tx) y después `TurnExecution.startTurn`. El Loop consume **solo**
 * `completion`: al recibir el terminal no cierra nada — `turns.complete` ya
 * cerró la Initiative en la misma tx de T6 (§4.4). Nada más que log y wakeup.
 * Un `startTurn` que lanza **tras** el claim escribe `failed` vía T6 con
 * `dispatch_failed` (§5.2); un claim que falla se descarta y el siguiente
 * `tick` reevalúa la fotografía durable. `bound_model` queda sin fijar (D17):
 * el Agent usa su `AgentConfig.model` (pendiente 5).
 *
 * El **único** cambio de P1 en este Loop (plan P1 §6.4): el `message` que se
 * entrega a `TurnExecution` es `claimed.dispatchInput`, no `intent`. Así una
 * Initiative respondida (pendiente en `queued`) reanuda con la respuesta exacta
 * en lugar de reejecutar el Intent; `dispatchInput` se calcula dentro de la
 * transacción del claim (§6.4). No cambia tick, dial, round-robin, Triggers,
 * barridos ni shutdown.
 *
 * Shutdown (§1.3, D3): `stop({ graceMs })` pone el flag `stopping` (ningún
 * `tick` nuevo reclama ni dispara Triggers), deja terminar los terminales
 * **naturales** hasta `graceMs` (los Runners siguen vivos durante la gracia),
 * luego `abort()` cada `TurnHandle` vivo (el Runner emite `turn-aborted` → T6
 * escribe `cancelled`), espera un margen corto y acotado a esos `turn-aborted`
 * y resuelve. Nunca escribe `failed` en shutdown; lo que quede `running` lo
 * recupera el siguiente arranque (ADR 0007). `stop()` es idempotente y no
 * lanza (§1.3).
 */

import { randomUUID } from "node:crypto";
import type { AgentRunState } from "@pihub/shared";
import { DomainError } from "./errors.ts";
import type { Initiative, TransitionCommand } from "./initiatives.ts";
import type { DueScheduleTrigger } from "./triggers.ts";
import type { FailureCause, TurnFinalState } from "./turns.ts";
import type { StartTurnCommand, TimerHandle, TurnHandle } from "./turn-execution.ts";
import type { ClaimInitiativeCommand, ClaimInitiativeResult } from "./index.ts";

/** Superficie de `Supervisor` que el Loop observa (§6: observa, no controla). */
export interface LoopSupervisor {
  state(name: string): { state: AgentRunState; pid?: number };
  /** Puerto del Runner (`AgentConfig.port`); `undefined` si el Agent no está despachable. */
  runnerPortOf(name: string): number | undefined;
}

/** Superficie de `TurnExecution` que el Loop usa (compartida con la ruta HTTP, D8). */
export interface LoopTurnExecution {
  startTurn(command: StartTurnCommand): TurnHandle;
  abort(agentName: string, turnId: string): boolean;
}

/** Superficie de `AgendaRepository` que el Loop usa (estructural: tests con fakes). */
export interface LoopAgenda {
  readonly initiatives: {
    listRunning(): readonly Initiative[];
    listDue(now: number): readonly Initiative[];
    transition(command: TransitionCommand): Initiative;
    sweepChainDeadline(now: number): number;
    sweepWaitingHumanExpiry(now: number): number;
  };
  readonly triggers: {
    listDueSchedule(now: number): readonly DueScheduleTrigger[];
    fireTrigger(triggerId: string, now: number): Initiative;
  };
  readonly turns: {
    complete(
      agentName: string,
      turnId: string,
      finalState: TurnFinalState,
      result: string | null,
      now: number,
      failureCause?: FailureCause,
    ): void;
  };
  claimInitiative(command: ClaimInitiativeCommand): ClaimInitiativeResult;
}

/** Opciones del Loop (todo lo temporal es inyectable, §7.1: el test no duerme). */
export interface AgendaLoopOptions {
  /** Dial global: cuántas Initiatives vuelan a la vez (§2.2). Default 1 (secuencial puro). */
  readonly dispatchConcurrency?: number;
  /** Periodicidad del `tick` (§2.4). Default 1000 ms. */
  readonly tickIntervalMs?: number;
  /** Gracia del shutdown (§1.3): 0 = abort inmediato. Calibración (§10). */
  readonly graceMs?: number;
  /** Margen corto y acotado a los `turn-aborted` tras la gracia (§1.3). Calibración (§10). */
  readonly postAbortMarginMs?: number;
  /**
   * Caducidad de `waiting_human` en ms (§6, CONTEXT.md:39-40): el barrido T10
   * recibe el corte `now - waitingHumanExpiryMs`, no `now`. Default 7 días.
   */
  readonly waitingHumanExpiryMs?: number;
  /** Reloj inyectable (§7.1). Default `Date.now`. */
  readonly now?: () => number;
  /** Scheduler inyectable del `tick` (§7.1). Default `setTimeout`. */
  readonly schedule?: (callback: () => void, ms: number) => TimerHandle;
  /** Cancelador inyectable del scheduler. Default `clearTimeout`. */
  readonly cancel?: (handle: TimerHandle) => void;
}

/** Turno en vuelo despachado por ESTE Loop (solo wakeup + abort en shutdown). */
interface TurnoLocal {
  readonly handle: TurnHandle;
  readonly agentName: string;
  readonly turnId: string;
}

export class AgendaLoop {
  private readonly agenda: LoopAgenda;
  private readonly supervisor: LoopSupervisor;
  private readonly turns: LoopTurnExecution;
  private readonly now: () => number;
  private readonly dispatchConcurrency: number;
  private readonly tickIntervalMs: number;
  private readonly graceMs: number;
  private readonly postAbortMarginMs: number;
  private readonly waitingHumanExpiryMs: number;
  private readonly schedule: (callback: () => void, ms: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;

  /** Turnos que ESTE Loop despachó y siguen en vuelo (solo wakeup, §2.2). */
  private readonly enVueloLocal = new Set<TurnoLocal>();
  /** Cursor efímero de round-robin entre Agents (§2.3); se pierde al reiniciar. */
  private lastServedAgent: string | undefined;
  /** Agents `errored` ya avisados en log (WARN una vez, §6.2). */
  private readonly avisadosErrored = new Set<string>();

  private started = false;
  private stopping = false;
  private stopped = false;
  private tickRunning = false;
  private tickHandle: TimerHandle | undefined;

  constructor(
    agenda: LoopAgenda,
    supervisor: LoopSupervisor,
    turns: LoopTurnExecution,
    options: AgendaLoopOptions = {},
  ) {
    this.agenda = agenda;
    this.supervisor = supervisor;
    this.turns = turns;
    this.now = options.now ?? Date.now;
    this.dispatchConcurrency = options.dispatchConcurrency ?? 1;
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.graceMs = options.graceMs ?? 5000;
    this.postAbortMarginMs = options.postAbortMarginMs ?? 1000;
    this.waitingHumanExpiryMs = options.waitingHumanExpiryMs ?? 604_800_000;
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Pone en marcha el bucle: programa el primer `tick` en `tickIntervalMs`.
   * A partir de ahí el `tick` se auto-programa (§2.1). Idempotente.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.stopped = false;
    this.tickHandle = this.schedule(() => this.tick(), this.tickIntervalMs);
  }

  /**
   * Apaga el Loop (D3, §1.3). Pone el flag `stopping` —ningún `tick` nuevo
   * reclama ni dispara Triggers—, deja terminar los terminales naturales hasta
   * `graceMs`, aborta los turnos vivos y espera un margen corto a los
   * `turn-aborted`. Idempotente y no lanza (§1.3).
   */
  async stop(options: { graceMs?: number } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = true;
    if (this.tickHandle !== undefined) {
      this.cancel(this.tickHandle);
      this.tickHandle = undefined;
    }
    if (this.enVueloLocal.size === 0) return;

    const graceMs = options.graceMs ?? this.graceMs;

    // 1. Terminales naturales hasta `graceMs`: los Runners siguen vivos durante
    //    la gracia y cada terminal natural escribe su `turns.complete`.
    if (graceMs > 0) await this.awaitTurnosO(graceMs);

    // 2. Al vencer la gracia, `abort()` en cada turno vivo: el Runner emite
    //    `turn-aborted` → T6 escribe `cancelled` (solo entonces hay `cancelled`;
    //    nunca se escribe `failed` en shutdown, §1.3).
    for (const local of [...this.enVueloLocal]) {
      this.turns.abort(local.agentName, local.turnId);
    }

    // 3. Margen corto y acotado a esos `turn-aborted`.
    await this.awaitTurnosO(this.postAbortMarginMs);
  }

  /** Un `tick`: barridos T9/T10 → Triggers vencidos → despacho (§2.1). */
  private tick(): void {
    if (!this.started || this.stopping || this.stopped) return;
    if (this.tickRunning) return; // sin reentrada: solo una lectura activa a la vez
    this.tickRunning = true;
    try {
      this.sweepStep();
      this.triggerStep();
      this.dispatchStep();
    } finally {
      this.tickRunning = false;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (!this.started || this.stopping || this.stopped) return;
    this.tickHandle = this.schedule(() => this.tick(), this.tickIntervalMs);
  }

  /** Barridos T9/T10 (§2.1 paso 1): caducidad de cadena y de `waiting_human`. */
  private sweepStep(): void {
    const now = this.now();
    this.safeRun("sweepChainDeadline", () => this.agenda.initiatives.sweepChainDeadline(now));
    this.safeRun("sweepWaitingHumanExpiry", () => this.agenda.initiatives.sweepWaitingHumanExpiry(now - this.waitingHumanExpiryMs));
  }

  /** Disparo de Triggers `schedule` vencidos (§3): una Initiative por Trigger. */
  private triggerStep(): void {
    const now = this.now();
    const due = this.safeRun("triggers.listDueSchedule", () => this.agenda.triggers.listDueSchedule(now));
    if (!due) return;
    for (const trigger of due) {
      // Un `TRIGGER_NOT_DISPARABLE` no corta el resto del `tick` (§5.2): el
      // Trigger se reevalúa en el siguiente.
      this.safeRun(`triggers.fireTrigger(${trigger.id})`, () => this.agenda.triggers.fireTrigger(trigger.id, now));
    }
  }

  /** Despacho de Initiatives `queued` respetando el dial (§2.2). */
  private dispatchStep(): void {
    const now = this.now();
    const enVuelo = this.safeRun("initiatives.listRunning", () => this.agenda.initiatives.listRunning());
    if (!enVuelo) return;
    const ocupados = new Set(enVuelo.map((ini) => ini.agentName));
    const capacidad = this.dispatchConcurrency - enVuelo.length;
    if (capacidad <= 0) return;
    const due = this.safeRun("initiatives.listDue", () => this.agenda.initiatives.listDue(now));
    if (!due || due.length === 0) return;
    for (const ini of this.seleccionar(due, ocupados, capacidad)) {
      this.despacharOEvaluar(ini, now);
    }
  }

  /**
   * Aplica la matriz del estado del Agent (§5.1) a la Initiative ya elegida:
   * `running` → despacha; `errored` → `failed` con `agent_errored`; el resto
   * (`stopped`, arrancando, inexistente) → sigue `queued`, se reevalúa.
   */
  private despacharOEvaluar(ini: Initiative, now: number): void {
    const { state } = this.supervisor.state(ini.agentName);
    if (state === "errored") {
      this.marcarErrored(ini, now);
      return;
    }
    if (state !== "running") {
      // `stopped`/arrancando → `queued` (§5.1): indisponibilidad transitoria
      // gobernada por el Supervisor; se reevalúa en el siguiente `tick`.
      return;
    }
    this.dispatch(ini);
  }

  /**
   * Agent `errored` → Initiative `failed` con `failure_reason='agent_errored'`
   * (§5.3): transición `queued→failed` legal (función pura) sin turno
   * reservado. WARN la primera vez por Agent (§6.2).
   */
  private marcarErrored(ini: Initiative, now: number): void {
    if (!this.avisadosErrored.has(ini.agentName)) {
      this.avisadosErrored.add(ini.agentName);
      console.warn(
        `[pihub] LOOP_AGENT_ERRORED ${ini.agentName}: Agent declarado errored; sus Initiatives pasan a failed (agent_errored)`,
      );
    }
    try {
      this.agenda.initiatives.transition({
        id: ini.id,
        from: "queued",
        to: "failed",
        now,
        failureReason: "agent_errored",
      });
    } catch (error) {
      // Carrera perdida: otro escritor ganó; la fotografía deja de valer.
      if (error instanceof DomainError && error.code === "INITIATIVE_STATE_CONFLICT") return;
      console.error(`[pihub] LOOP_AGENT_ERRORED_WRITE ${ini.id}:`, error);
    }
  }

  /** Round-robin entre Agents + FIFO dentro de cada Agent (§2.3). */
  private seleccionar(
    due: readonly Initiative[],
    ocupados: ReadonlySet<string>,
    capacidad: number,
  ): readonly Initiative[] {
    const elegidas: Initiative[] = [];
    const ocupado = new Set(ocupados);
    const porAgente = new Map<string, Initiative[]>();
    for (const ini of due) {
      const cola = porAgente.get(ini.agentName);
      if (cola) cola.push(ini);
      else porAgente.set(ini.agentName, [ini]);
    }
    const agentes = [...porAgente.keys()].filter((name) => !ocupado.has(name));
    // Rotar empezando después del último Agent servido (cursor efímero).
    if (this.lastServedAgent !== undefined) {
      const idx = agentes.indexOf(this.lastServedAgent);
      if (idx >= 0) agentes.push(...agentes.splice(0, idx + 1));
    }
    for (const agent of agentes) {
      if (elegidas.length >= capacidad) break;
      const primera = porAgente.get(agent)![0];
      if (!primera) continue;
      elegidas.push(primera);
      ocupado.add(agent); // la elegida ocupa a su Agent dentro de este mismo `tick`
      this.lastServedAgent = agent;
    }
    return elegidas;
  }

  /** Claim unificado (T7+T2) y `TurnExecution.startTurn` (§4.5, §4.2). */
  private dispatch(ini: Initiative): void {
    const turnId = randomUUID();
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    const now = this.now();

    let claimed: ClaimInitiativeResult;
    try {
      claimed = this.agenda.claimInitiative({
        initiativeId: ini.id,
        turnId,
        idempotencyKey,
        now,
      });
    } catch (error) {
      // Carrera perdida o error transitorio: se descarta esta fotografía; el
      // siguiente `tick` reevalúa desde el estado durable (§5.2). Los códigos
      // de carrera no son fallos que loguear.
      const code = error instanceof DomainError ? error.code : undefined;
      if (code !== "INITIATIVE_STATE_CONFLICT" && code !== "TURN_ID_CONFLICT") {
        console.error(`[pihub] LOOP_CLAIM_FAILED ${ini.id}:`, error);
      }
      return;
    }
    const { initiative: running, dispatchInput } = claimed;

    const runnerPort = this.supervisor.runnerPortOf(running.agentName);
    if (runnerPort === undefined) {
      // `state()==='running'` pero sin puerto: la reserva no puede quedarse
      // `running` colgada — se cierra con `dispatch_failed` (§5.2).
      this.cerrarFallido(running, turnId, "dispatch_failed");
      return;
    }

    let handle: TurnHandle;
    try {
      handle = this.turns.startTurn({
        agentName: running.agentName,
        turnId,
        idempotencyKey,
        correlationId,
        sessionKey: running.sessionKey,
        message: dispatchInput,
        runnerPort,
        eventProfile: "basic",
        origin: { kind: "initiative", initiativeId: running.id, cause: running.origin },
      });
    } catch (error) {
      // §5.2: `startTurn` lanza tras el claim → `failed` vía T6 con
      // `dispatch_failed` (la reserva de T7 no puede quedarse sin terminal).
      console.error(`[pihub] LOOP_DISPATCH_FAILED ${running.agentName}:${turnId}:`, error);
      this.cerrarFallido(running, turnId, "dispatch_failed");
      return;
    }

    const local: TurnoLocal = { handle, agentName: running.agentName, turnId };
    this.enVueloLocal.add(local);
    void handle.completion.then(
      () => {
        this.enVueloLocal.delete(local);
        this.wakeup();
      },
      () => {
        this.enVueloLocal.delete(local);
        this.wakeup();
      },
    );
  }

  /** Cierra la reserva como `failed`/`dispatch_failed` sin dividir la tx de T6. */
  private cerrarFallido(ini: Initiative, turnId: string, cause: FailureCause): void {
    try {
      this.agenda.turns.complete(ini.agentName, turnId, "failed", null, this.now(), cause);
    } catch (error) {
      console.error(`[pihub] LOOP_DISPATCH_FAILED_WRITE ${ini.agentName}:${turnId}:`, error);
    }
  }

  /**
   * Wakeup al liberar un slot (§2.2): un `TurnHandle` de ESTE Loop resolvió;
   * se programa un `tick` inmediato para no esperar `tickIntervalMs`. No es
   * fuente de verdad: si se pierde, el próximo `tick` periódico reevalúa.
   */
  private wakeup(): void {
    if (!this.started || this.stopping || this.stopped) return;
    if (this.tickRunning) return; // el `tick` en curso ya recoloca al terminar
    if (this.tickHandle !== undefined) this.cancel(this.tickHandle);
    this.tickHandle = this.schedule(() => this.tick(), 0);
  }

  /** Espera a los turnos vivos o a que venza `ms` (§1.3), lo que ocurra primero. */
  private async awaitTurnosO(ms: number): Promise<void> {
    const vivos = [...this.enVueloLocal];
    if (vivos.length === 0) return;
    const terminaron = Promise.all(vivos.map((t) => t.handle.completion)).then(() => undefined);
    const plazo = new Promise<void>((resolve) => {
      this.schedule(() => resolve(), ms);
    });
    await Promise.race([terminaron, plazo]);
  }

  /** Ejecuta `fn` y loguea el fallo sin romper el resto del `tick` (§5.2). */
  private safeRun<T>(label: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      console.error(`[pihub] LOOP_${label} ${detalle}`);
      return undefined;
    }
  }
}
