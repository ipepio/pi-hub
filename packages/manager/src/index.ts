import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { isValidAgentName, loadEnv, readAgent } from "@pihub/shared";
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
import type { EffectiveTriggerAuthority } from "./agenda/triggers.js";
import { AutonomyControl } from "./agenda/autonomy-control.js";
import {
  HumanRequestDelivery,
  type TelegramBotClient,
} from "./primary-channel/human-request-delivery.js";

const env = loadEnv();

/** Cliente HTTP real; `HumanRequestDelivery` conserva este efecto inyectable. */
const telegramBotClient: TelegramBotClient = {
  async sendMessage(token, params) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw response;

    const payload = await response.json() as {
      ok?: unknown;
      result?: { message_id?: unknown };
    };
    if (payload.ok !== true || !Number.isSafeInteger(payload.result?.message_id)) {
      throw new SyntaxError("Telegram Bot API devolvió una respuesta inválida");
    }
    return { message_id: payload.result!.message_id as number };
  },
};

// P1.4 (§5): la autoridad efectiva se deriva **una vez** del modo
// (`panelEnabled`), nunca de la credencial del request: un Bearer usado por el
// operador en Gobernador sigue actuando bajo `owner`. P2 aplicará el principal;
// P1 reconcilia esta autoridad en todos los Triggers al arrancar (§5.3).
const effectiveTriggerAuthority: EffectiveTriggerAuthority = env.panelEnabled ? "owner" : "control_plane";

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
const runtime = await runStartup(
  {
    openStore: () => openManagerStore(env.dataDir),
    providers: runtimeProviders,
    provision: () => provisionAgents(env),
    createSupervisor: () => new Supervisor(env),
    // Fase 3.5 (D8): el TurnExecution compartido se construye antes de createApp
    // y se inyecta también al Loop; con el repositorio durable para que cada
    // terminal de Initiative escriba `turns.complete` con su causa (§4.6).
    // Fase 3.7 (§9.7): el watchdog de apertura/silencio se lee de env — en
    // producción el default es real y NO cero (`0` significaría desactivado).
    createTurns: ({ store }) => {
      // [ÁRBITRO-1]: sin panel o chat privado primario no se compone ningún
      // delivery. El panel sigue mostrando la espera y Telegram recibe cero
      // llamadas (fail-closed).
      const delivery = env.panelEnabled && env.telegramPrimaryChatId !== undefined
        ? new HumanRequestDelivery({
            client: telegramBotClient,
            deliveries: store.agenda.humanRequestDeliveries,
            primaryChatId: env.telegramPrimaryChatId,
            agentConfigFor: async (agentName) => {
              if (!isValidAgentName(agentName)) return null;
              const config = await readAgent(env.dataDir, agentName);
              return config?.name === agentName ? config : null;
            },
          })
        : undefined;

      return new TurnExecution({
        apiToken: env.apiToken,
        repository: store.agenda.turns,
        humanRequests: store.agenda.humanRequests,
        now: () => Date.now(),
        requestId: () => randomUUID(),
        expiryMs: env.waitingHumanExpiryMs,
        onHumanRequest: delivery
          ? (request) => {
              void delivery.deliver(request);
            }
          : undefined,
        dispatchTimeoutMs: env.turnDispatchTimeoutMs,
      });
    },
    createOAuth: (providers) => new OAuthService(providers),
    createApp: ({ supervisor, oauth, providers, turns, store }) => {
      // P2.3: construir el AutonomyControl real con el store y turns compartidos.
      // La autoridad efectiva se deriva una vez del modo (§2.1 del plan P2).
      const autonomyControl = new AutonomyControl({
        agenda: store.agenda,
        turns,
        authority: effectiveTriggerAuthority,
      });
      return createApi(env, supervisor, oauth, providers, turns, {
        projection: store.agenda.projection,
        control: autonomyControl,
      });
    },
    // Fase 3.5 (D2): el Loop se compone y arranca después de `serve`.
    // Fase 3.7 (§9.7): dial, periodicidad y tiempos de shutdown se leen de env
    // en vez de caer a los defaults del constructor.
    createLoop: ({ store, supervisor, turns }) =>
      new AgendaLoop(store.agenda, supervisor, turns, {
        dispatchConcurrency: env.loopConcurrency,
        tickIntervalMs: env.loopPollMs,
        graceMs: env.loopGraceMs,
        postAbortMarginMs: env.loopPostAbortMarginMs,
        waitingHumanExpiryMs: env.waitingHumanExpiryMs,
      }),
    serve: (app) =>
      serve({ fetch: app.fetch, port: env.managerPort, hostname: "0.0.0.0" }, (info) => {
        console.log(`[pihub] manager escuchando en :${info.port} (panel ${env.panelEnabled ? "activado" : "desactivado"})`);
      }),
  },
  effectiveTriggerAuthority,
);

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
