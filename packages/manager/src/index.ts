import { serve } from "@hono/node-server";
import { loadEnv } from "@pihub/shared";
import { bootstrap } from "./bootstrap.js";
import { provisionAgents } from "./provision.js";
import { createApi } from "./api.js";
import { Supervisor } from "./supervisor.js";
import { OAuthService } from "./oauth.js";
import { createRuntimeProviders } from "@pihub/providers";
import { modelsSeedFile } from "./paths.js";
import { openManagerStore } from "./storage/sqlite.js";
import { runStartup, shutdownRuntime } from "./startup.js";
import { AgendaLoop } from "./agenda/loop.js";
import { TurnExecution } from "./agenda/turn-execution.js";

const env = loadEnv();

if (!env.apiToken) {
  console.warn("[pihub] AVISO: API_TOKEN vacío — API y webs sin autenticación");
}

const runtimeProviders = createRuntimeProviders({
  dataDir: env.dataDir,
  modelsSeedPath: modelsSeedFile,
  overwriteModels: env.overwriteModels,
  oauthProviders: env.oauthProviders,
});
await bootstrap(env);

// Fase 2.4 (§11 del plan): la composición fija el orden recuperar → arrancar
// agentes → servir. `recoverRunningOnStartup` (+ barrido de `chain_deadline_at`,
// §7.2) corre sobre `managerStore.agenda` entre `provision` y `new Supervisor`
// (§7.1). Si falla, `STARTUP_RECOVERY_FAILED` aborta el arranque sin Supervisor
// ni HTTP (§7.4); `store.agenda` queda inyectable para las fases posteriores.
const runtime = await runStartup({
  openStore: () => openManagerStore(env.dataDir),
  providers: runtimeProviders,
  provision: () => provisionAgents(env),
  createSupervisor: () => new Supervisor(env),
  // Fase 3.5 (D8): el TurnExecution compartido se construye antes de createApp
  // y se inyecta también al Loop; con el repositorio durable para que cada
  // terminal de Initiative escriba `turns.complete` con su causa (§4.6).
  // Fase 3.7 (§9.7): el watchdog de apertura/silencio se lee de env — en
  // producción el default es real y NO cero (`0` significaría desactivado).
  createTurns: ({ store }) =>
    new TurnExecution({
      apiToken: env.apiToken,
      repository: store.agenda.turns,
      dispatchTimeoutMs: env.turnDispatchTimeoutMs,
    }),
  createOAuth: (providers) => new OAuthService(providers),
  createApp: ({ supervisor, oauth, providers, turns }) =>
    createApi(env, supervisor, oauth, providers, turns),
  // Fase 3.5 (D2): el Loop se compone y arranca después de `serve`.
  // Fase 3.7 (§9.7): dial, periodicidad y tiempos de shutdown se leen de env
  // en vez de caer a los defaults del constructor.
  createLoop: ({ store, supervisor, turns }) =>
    new AgendaLoop(store.agenda, supervisor, turns, {
      dispatchConcurrency: env.loopConcurrency,
      tickIntervalMs: env.loopPollMs,
      graceMs: env.loopGraceMs,
      postAbortMarginMs: env.loopPostAbortMarginMs,
    }),
  serve: (app) =>
    serve({ fetch: app.fetch, port: env.managerPort, hostname: "0.0.0.0" }, (info) => {
      console.log(`[pihub] manager escuchando en :${info.port} (panel ${env.panelEnabled ? "activado" : "desactivado"})`);
    }),
});

runtimeProviders.onChange(() => {
  void runtime.supervisor.reloadProviderState();
});

async function shutdown(): Promise<void> {
  // Fase 3.7 (§9.7): el orden crítico lo fija `shutdownRuntime` — `loop.stop`
  // PRIMERO (gracia acotada + abort; nunca `failed` en shutdown) y después
  // `stopAll`, el cierre del store y del HTTP.
  await shutdownRuntime(runtime);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
