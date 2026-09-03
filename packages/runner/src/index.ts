import { loadEnv, readAgent, scrubProtectedProcessEnv } from "@pihub/shared";
import { SessionFactory } from "./session.js";
import { ChatHub } from "./hub.js";
import { startServer } from "./server.js";
import { startTelegram } from "./telegram.js";

const env = loadEnv();
const agentName = process.env.PIHUB_AGENT_NAME;
if (!agentName) {
  console.error("[runner] falta PIHUB_AGENT_NAME");
  process.exit(1);
}

// Invariant (R1-001): the pi coding agent's bash tool inherits the full runner
// process env, so the service credential must not remain in process.env after
// boot — an autonomous Agent could read $API_TOKEN and call governed APIs as the
// service principal, bypassing AutonomyControl. Authentication keeps using the
// value loadEnv() already captured into `env.apiToken`/`env.runnerCallbackToken`/
// `env.speechApiKey` (auth middleware / Manager forwards / Telegram callback).
// The REAL helper (shared) scrubs only the exact PROTECTED_ENV_KEYS; PIHUB_* and
// PI_CODING_AGENT_* config values stay, since the pi runtime may need them.
scrubProtectedProcessEnv(process.env);

const config = await readAgent(env.dataDir, agentName);
if (!config) {
  console.error(`[runner] agente desconocido: ${agentName}`);
  process.exit(1);
}

const factory = new SessionFactory(env, config);
const hub = new ChatHub(factory);
const server = startServer(env, config, hub, factory);
const telegram = startTelegram(env, config, factory);

function shutdown(): void {
  telegram?.stop();
  hub.reset();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
