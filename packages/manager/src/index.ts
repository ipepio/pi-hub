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
import { runStartup } from "./startup.js";

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
  createOAuth: (providers) => new OAuthService(providers),
  createApp: ({ supervisor, oauth, providers }) => createApi(env, supervisor, oauth, providers),
  serve: (app) =>
    serve({ fetch: app.fetch, port: env.managerPort, hostname: "0.0.0.0" }, (info) => {
      console.log(`[pihub] manager escuchando en :${info.port} (panel ${env.panelEnabled ? "activado" : "desactivado"})`);
    }),
});

runtimeProviders.onChange(() => {
  void runtime.supervisor.reloadProviderState();
});

async function shutdown(): Promise<void> {
  console.log("[pihub] parando agentes...");
  await runtime.supervisor.stopAll();
  runtime.store.close();
  runtime.server.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
