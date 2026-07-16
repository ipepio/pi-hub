import { serve } from "@hono/node-server";
import { loadEnv } from "@pihub/shared";
import { bootstrap } from "./bootstrap.js";
import { provisionAgents } from "./provision.js";
import { createApi } from "./api.js";
import { Supervisor } from "./supervisor.js";
import { OAuthService } from "./oauth.js";

const env = loadEnv();

if (!env.apiToken) {
  console.warn("[pihub] AVISO: API_TOKEN vacío — API y webs sin autenticación");
}

await bootstrap(env);
await provisionAgents(env);

const supervisor = new Supervisor(env);
await supervisor.startAll();

const oauth = new OAuthService(env);
const app = createApi(env, supervisor, oauth);

const server = serve({ fetch: app.fetch, port: env.managerPort, hostname: "0.0.0.0" }, (info) => {
  console.log(`[pihub] manager escuchando en :${info.port} (panel ${env.panelEnabled ? "activado" : "desactivado"})`);
});

async function shutdown(): Promise<void> {
  console.log("[pihub] parando agentes...");
  await supervisor.stopAll();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
