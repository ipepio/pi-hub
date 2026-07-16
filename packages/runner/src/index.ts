import { loadEnv, readAgent } from "@pihub/shared";
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
