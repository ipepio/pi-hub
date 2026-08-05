/**
 * Composición del arranque del Manager — Fase 2.4 del plan de Fase 2
 * (`/tmp/f2plan.md` §11 "Fase 2.4", con el detalle en §7 "Recuperación al
 * arranque", §7.1 posición exacta, §7.4 qué pasa si falla).
 *
 * Orden fijado por el plan (§7.1): `openManagerStore → initialize →
 * provision → recoverRunningOnStartup (+ barrido `chain_deadline_at`) →
 * Supervisor.startAll → serve`. La recuperación corre sobre `store.agenda`
 * **entre** `provision` y la construcción del Supervisor: ningún Runner acepta
 * un turno de una Initiative que en disco ya es `failed`, y ninguna petición
 * HTTP despacha antes de que el estado durable sea consistente (ADR 0007).
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

/** Superficie mínima de Providers que la composición toca (`initialize`). */
export interface ProviderLike {
  initialize(): Promise<void>;
}

/** Superficie mínima del Supervisor que la composición toca (`startAll`). */
export interface SupervisorLike {
  startAll(): Promise<void>;
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
  };
  close(): void;
}

/** Dependencias inyectables de la composición (fakes en test, reales en `index.ts`). */
export interface StartupDeps<
  S extends StartupStore,
  P extends ProviderLike,
  Sup extends SupervisorLike,
  O,
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
  /** Construye el OAuthService con los providers. */
  createOAuth: (providers: P) => O;
  /** Construye la app HTTP (`createApi`). */
  createApp: (deps: { providers: P; supervisor: Sup; oauth: O }) => A;
  /** Publica HTTP (`serve`) — el último paso: nada despacha antes de recuperar. */
  serve: (app: A) => ServerLike;
}

/** Piezas del arranque que `index.ts` conserva para shutdown y fases posteriores. */
export interface StartupRuntime<S extends StartupStore, Sup extends SupervisorLike, A> {
  /** Almacén abierto; `store.agenda` queda inyectable (sin consumidor todavía). */
  readonly store: S;
  readonly supervisor: Sup;
  readonly app: A;
  readonly server: ServerLike;
  /** Resultado observable de la recuperación (log §7.3). */
  readonly recovery: StartupRecoveryResult;
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
 * Ejecuta la secuencia de arranque completa en el orden del §7.1. No importa
 * ni ejecuta `index.ts`: los tests pasan fakes por la misma interfaz que
 * producción (plan §10.3).
 */
export async function runStartup<
  S extends StartupStore,
  P extends ProviderLike,
  Sup extends SupervisorLike,
  O,
  A,
>(deps: StartupDeps<S, P, Sup, O, A>): Promise<StartupRuntime<S, Sup, A>> {
  const store = await deps.openStore(); // 1. openManagerStore (migraciones)
  await deps.providers.initialize(); //    2. Providers.initialize
  await deps.provision(); //              3. provisionAgents

  // 4. Recuperación al arranque (§7.1): entre `provision` y `new Supervisor`.
  //    ADR 0007 + barrido `chain_deadline_at` en una sola tx (§7.2). Si lanza,
  //    `STARTUP_RECOVERY_FAILED` propaga y ni `startAll` ni `serve` se ejecutan
  //    (§7.4): el Manager aborta sin publicar HTTP y systemd reintenta.
  const recovery = store.agenda.recoverRunningOnStartup(Date.now());
  logRecovery(recovery);

  const supervisor = deps.createSupervisor(); // 5. new Supervisor
  await supervisor.startAll(); //              6. Supervisor.startAll

  const oauth = deps.createOAuth(deps.providers); // 7. OAuthService
  const app = deps.createApp({ providers: deps.providers, supervisor, oauth }); // 8. createApi
  const server = deps.serve(app); //               9. serve — HTTP público

  return { store, supervisor, app, server, recovery };
}
