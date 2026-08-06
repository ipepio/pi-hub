/**
 * Composición del arranque del Manager — Fase 2.4 del plan de Fase 2
 * (`/tmp/f2plan.md` §11 "Fase 2.4", con el detalle en §7 "Recuperación al
 * arranque", §7.1 posición exacta, §7.4 qué pasa si falla).
 *
 * Orden fijado por el plan (§7.1 + P1.4 §5.3): `openManagerStore →
 * reconcileAuthority → initialize → provision → recoverRunningOnStartup (+
 * barrido `chain_deadline_at`) → Supervisor.startAll → serve`. La
 * reconciliación de autoridad (P1.4) corre justo después de migrar y **antes**
 * de cualquier Provider/Runner/HTTP/Loop: si falla, el Manager aborta sin
 * arrancar (mismo principio que `STARTUP_RECOVERY_FAILED`). La recuperación
 * corre sobre `store.agenda` **entre** `provision` y la construcción del
 * Supervisor: ningún Runner acepta un turno de una Initiative que en disco ya
 * es `failed`, y ninguna petición HTTP despacha antes de que el estado durable
 * sea consistente (ADR 0007).
 *
 * Si `recoverRunningOnStartup` lanza —`STARTUP_RECOVERY_FAILED`, §7.4— la
 * excepción propaga y ni `createSupervisor`/`startAll` ni `createApp`/`serve`
 * llegan a ejecutarse: el Manager aborta sin publicar HTTP y systemd
 * reintenta. El orden importa: **recuperar → arrancar agentes → servir**, no
 * al revés.
 *
 * El `agenda` queda inyectable a través del `store` devuelto: las fases
 * posteriores (rutas, Loop) lo consumirán desde ahí. Esta fase no crea ningún
 * consumidor fuera del arranque.
 */

import type { StartupRecoveryResult } from "./agenda/recovery.ts";
import type { EffectiveTriggerAuthority } from "./agenda/triggers.ts";

/** Superficie mínima de Providers que la composición toca (`initialize`). */
export interface ProviderLike {
  initialize(): Promise<void>;
}

/** Superficie mínima del Supervisor que la composición toca (`startAll`). */
export interface SupervisorLike {
  startAll(): Promise<void>;
}

/** Superficie mínima del Loop (Fase 3.5) que la composición toca (`start`/`stop`). */
export interface LoopLike {
  start(): void;
  stop(options?: { graceMs?: number }): Promise<void>;
}

/** Superficie mínima del servidor HTTP que devuelve `serve` (`close`). */
export interface ServerLike {
  close(): void;
}

/**
 * Superficie del almacén que la composición usa: el `agenda` para la
 * recuperación y `close` (shutdown). Estructural a propósito: los tests
 * pueden pasar un fake de `agenda` y producción pasa el `ManagerStore` real.
 */
export interface StartupStore {
  /** Repositorio de Agenda — inyectable para las fases posteriores. */
  readonly agenda: {
    /** ADR 0007 + barrido `chain_deadline_at` en una sola tx (§7.2). */
    recoverRunningOnStartup(now: number): StartupRecoveryResult;
    /** P1.4 (§5.2): autoridad efectiva en todos los Triggers, antes de cualquier efecto observable. */
    triggers: {
      reconcileAuthority(authority: EffectiveTriggerAuthority, now: number): number;
    };
  };
  close(): void;
}

/**
 * Dependencias inyectables de la composición (fakes en test, reales en `index.ts`).
 * Fase 3.5 (§9.5, D2/D8): el `TurnExecution` compartido se crea **antes** de
 * `createApp` (la ruta HTTP y el Loop comparten la misma instancia) y el Loop
 * se compone y arranca **después** de `serve`.
 */
export interface StartupDeps<
  S extends StartupStore,
  P extends ProviderLike,
  Sup extends SupervisorLike,
  O,
  T,
  Loop extends LoopLike,
  A,
> {
  /** Abre el almacén (`openManagerStore`): pragmas + migraciones. */
  openStore: () => Promise<S>;
  /** Providers del runtime; `initialize()` corre antes de la recuperación (protocolo §7.1). */
  providers: P;
  /** Provisión declarativa de agentes (`provisionAgents(env)`). */
  provision: () => Promise<void>;
  /** Construye el Supervisor (`new Supervisor(env)`). */
  createSupervisor: () => Sup;
  /** Construye el `TurnExecution` compartido antes de `createApp` (D2); `store.agenda` queda disponible. */
  createTurns: (deps: { store: S }) => T;
  /** Construye el OAuthService con los providers. */
  createOAuth: (providers: P) => O;
  /** Construye la app HTTP (`createApi`); recibe el `TurnExecution` compartido (D8) y el store para autonomía (P2.3). */
  createApp: (deps: { providers: P; supervisor: Sup; oauth: O; turns: T; store: S }) => A;
  /** Construye el `AgendaLoop` con el repo, el Supervisor y el `TurnExecution` compartidos. */
  createLoop: (deps: { store: S; supervisor: Sup; turns: T }) => Loop;
  /** Publica HTTP (`serve`) — el último paso: nada despacha antes de recuperar. */
  serve: (app: A) => ServerLike;
}

/** Piezas del arranque que `index.ts` conserva para shutdown y fases posteriores. */
export interface StartupRuntime<
  S extends StartupStore,
  Sup extends SupervisorLike,
  T,
  Loop extends LoopLike,
  A,
> {
  /** Almacén abierto; `store.agenda` queda inyectable (sin consumidor todavía). */
  readonly store: S;
  readonly supervisor: Sup;
  /** `TurnExecution` compartido (ruta HTTP y Loop, D8). */
  readonly turns: T;
  /** `AgendaLoop` arrancado tras `serve` (Fase 3.5, D2); `shutdown` lo para antes de `stopAll`. */
  readonly loop: Loop;
  readonly app: A;
  readonly server: ServerLike;
  /** Resultado observable de la recuperación (log §7.3). */
  readonly recovery: StartupRecoveryResult;
}

/**
 * Superficie del shutdown (Fase 3.7, §9.7): las cuatro piezas que se cierran en
 * orden. Estructural a propósito: el test pasa fakes sin el arranque y `index.ts`
 * pasa el `StartupRuntime` real (el `store` solo necesita `close` aquí).
 */
export interface ShutdownRuntime {
  readonly loop: LoopLike;
  readonly supervisor: { stopAll(): Promise<void> };
  readonly store: { close(): void };
  readonly server: ServerLike;
}

/** Log estructurado del resultado de la recuperación (§7.3). */
function logRecovery(result: StartupRecoveryResult): void {
  if (result.runningRecovered.length === 0 && result.deadlineExpired === 0) {
    console.log("[pihub] STARTUP_RECOVERY_CLEAN running=0 deadline=0");
    return;
  }
  console.log(
    `[pihub] STARTUP_RECOVERY_APPLIED running=${result.runningRecovered.join(",") || "-"} deadline=${result.deadlineExpired}`,
  );
}

/**
 * Ejecuta la secuencia de arranque completa en el orden del §7.1 + P1.4 §5.3.
 * No importa ni ejecuta `index.ts`: los tests pasan fakes por la misma interfaz
 * que producción (plan §10.3).
 *
 * P1.4 (§5.3) inserta la **reconciliación de autoridad** justo después de
 * `openStore` y **antes** de cualquier Provider, Runner, HTTP o Loop — el modo
 * (`panelEnabled`) se deriva una vez en `index.ts` y se pasa como
 * `effectiveTriggerAuthority`. Un fallo de reconciliación propaga y aborta
 * antes de `providers.initialize`, `startAll`, `serve` y `loop.start`: mejor
 * no arrancar que servir con autoridad incoherente (mismo principio que
 * `STARTUP_RECOVERY_FAILED`).
 *
 * Fase 3.5 (§9.5): el `TurnExecution` compartido se crea **antes** de
 * `createApp` (D2; la ruta HTTP y el Loop comparten la instancia, D8) y el
 * `AgendaLoop` se compone y arranca **después** de `serve` (D2) — la
 * autonomía no se ata al socket HTTP, pero el Loop no despacha antes de que
 * el estado durable sea consistente ni antes de que los Runners estén en
 * marcha.
 */
export async function runStartup<
  S extends StartupStore,
  P extends ProviderLike,
  Sup extends SupervisorLike,
  O,
  T,
  Loop extends LoopLike,
  A,
>(
  deps: StartupDeps<S, P, Sup, O, T, Loop, A>,
  effectiveTriggerAuthority: EffectiveTriggerAuthority,
): Promise<StartupRuntime<S, Sup, T, Loop, A>> {
  const store = await deps.openStore(); //  1. openManagerStore (migraciones)

  // 2. P1.4 (§5.3): reconciliar la autoridad de todos los Triggers antes de
  //    cualquier efecto observable. Si falla, el Manager aborta sin Providers,
  //    Runner, HTTP ni Loop (§5.3; decisión cerrada "mejor no arrancar que
  //    servir con autoridad incoherente").
  store.agenda.triggers.reconcileAuthority(effectiveTriggerAuthority, Date.now());

  await deps.providers.initialize(); //    3. Providers.initialize
  await deps.provision(); //              4. provisionAgents

  // 5. Recuperación al arranque (§7.1): entre `provision` y `new Supervisor`.
  //    ADR 0007 + barrido `chain_deadline_at` en una sola tx (§7.2). Si lanza,
  //    `STARTUP_RECOVERY_FAILED` propaga y ni `startAll` ni `serve` se ejecutan
  //    (§7.4): el Manager aborta sin publicar HTTP y systemd reintenta.
  const recovery = store.agenda.recoverRunningOnStartup(Date.now());
  logRecovery(recovery);

  const supervisor = deps.createSupervisor(); // 6. new Supervisor
  await supervisor.startAll(); //              7. Supervisor.startAll

  // 8. TurnExecution compartido (Fase 3.5, D2): ANTES de createApp para que la
  //    ruta HTTP y el Loop consuman la misma instancia (D8, §6.3).
  const turns = deps.createTurns({ store });
  const oauth = deps.createOAuth(deps.providers); // 9. OAuthService
  const app = deps.createApp({ providers: deps.providers, supervisor, oauth, turns, store }); // 10. createApi + autonomía (P2.3)
  const server = deps.serve(app); //               11. serve — HTTP público

  // 12. Fase 3.5 (§1.2, D2): el Loop se compone y arranca DESPUÉS de `serve`.
  const loop = deps.createLoop({ store, supervisor, turns });
  loop.start();

  return { store, supervisor, turns, loop, app, server, recovery };
}

/**
 * Orden del apagado (§1.3, D3; criterio verificable de Fase 3.7):
 * `loop.stop` PRIMERO — gracia acotada + abort de los turnos en vuelo; nunca
 * se escribe `failed` en shutdown — después `supervisor.stopAll()` (mata
 * Runners), `store.close()` (SQLite) y `server.close()` (HTTP). `loop.stop`
 * primero es lo que evita que un apagado marque como `failed` turnos que solo
 * fueron interrumpidos. `index.ts` la llama desde SIGTERM/SIGINT y luego sale.
 */
export async function shutdownRuntime(runtime: ShutdownRuntime): Promise<void> {
  await runtime.loop.stop();
  console.log("[pihub] parando agentes...");
  await runtime.supervisor.stopAll();
  runtime.store.close();
  runtime.server.close();
}
