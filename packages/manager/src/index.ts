import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { loadEnv } from "@pihub/shared";
import { bootstrap } from "./bootstrap.js";
import { provisionAgents } from "./provision.js";
import { createApi } from "./api.js";
import type { ApiV1ChannelDeps } from "./api-v1/routes.js";
import { Supervisor } from "./supervisor.js";
import { OAuthService } from "./oauth.js";
import { createRuntimeProviders } from "@pihub/providers";
import { modelsSeedFile } from "./paths.js";
import { openManagerStore } from "./storage/sqlite.js";
import { runStartup, shutdownRuntime } from "./startup.js";
import { AgendaLoop } from "./agenda/loop.js";
import { TurnExecution, type CompletedTurn } from "./agenda/turn-execution.js";
import { reconcileLiveTurns } from "./startup-reconcile.js";
import type { EffectiveTriggerAuthority } from "./agenda/triggers.js";
import { AutonomyControl } from "./agenda/autonomy-control.js";
import { HumanRequestDelivery } from "./primary-channel/human-request-delivery.js";
import { ChannelRuntimeRegistry } from "./channels/registry.js";
import { composeChannels } from "./channels/composition.js";
import { createLateBoundHitl } from "./channels/hitl-bridge.js";
import { resetObservedState } from "./channels/store.js";
import { PairingMachine } from "./channels/pairing.js";
import { assertNoDoubleTelegramBot } from "./channels/cutover.js";

const env = loadEnv();

/**
 * Fix H3/B1 (verify round): el arranque YA NO compone ningún cliente Bot API.
 * El único camino de salida de una tarjeta `waiting_human` es el de cualquier otro
 * mensaje no-web: `composeChannels` → outbox → adapter vivo. Un cliente de token
 * aquí volvería a pedir el `agent.json.telegramToken` que el cutover dejó de
 * escribir — la puerta muerta que hacía el envío un no-op silencioso.
 */
const logLine = (line: string): void => {
  console.error(`[pihub] ${line}`);
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
// Slice (c) part 2b: el Manager es el dueño del lifecycle de los ChannelAdapter
// (design §1.4). Se compone AQUÍ — y no dentro del router — porque el mismo objeto
// tiene que estar en los dos extremos de su vida: las rutas `/api/v1` lo usan para
// arrancar/parar adapters con cada reconciliación del Dashboard, y `shutdown` lo
// para para que ningún bot siga haciendo long-polling después del SIGTERM. Un
// adapter solo arranca si el Dashboard proyecta un canal con credencial: mientras
// no haya proyección, este registry está vacío y no sustituye a ningún bot.
const channelRegistry = new ChannelRuntimeRegistry();

// Slice (c) fix round A (C1): el composition root es AQUÍ, no dentro del router.
// Hasta este punto `composeChannels` no tenía ningún llamador de producción: la
// cola vivía en las tablas v4 y no la dreñaba nadie, `TurnExecution` no tenía hook
// de turno terminado (ninguna respuesta volvía por el canal), el registry no tenía
// `attachInbound` (un mensaje del bot se tiraba a la basura) y las rutas recibían
// `{ registry }` pelado, así que `GET …/channel-exchanges` solo podía responder con
// el feed vacío. Las cuatro puertas se cablean abajo con las MISMAS instancias que
// ve `shutdownRuntime`.
/**
 * Máquina de emparejamiento COMPARTIDA: la misma que usan las rutas (aprobar /
 * rechazar códigos) y el handler inbound (auto-vincular). Es un fichero por Agent;
 * dos instancias serían dos cadenas de serialización distintas sobre el mismo
 * fichero, y el estado de vínculo es un hecho único.
 */
const channelPairing = new PairingMachine({ dataDir: env.dataDir });

/**
 * La puerta HITL de enlace tardío (fix B1, spec `agent-channels` → «Unified session
 * delivery-by-origin», caso 3). `TurnExecution` — y con él `HumanRequestDelivery` —
 * nace en el paso 8; la costura `hitl` de `composeChannels` no existe hasta el 13.
 * Este objeto es la referencia estable que la entrega guarda de por vida; el arranque
 * enlaza la costura real abajo, en `createOutboxWorker`. Mientras no está enlazada la
 * puerta es FAIL-CLOSED: `boundChatOf` responde `null` (skip documentado, cero filas,
 * cero envíos) y `enqueue` rechaza — nunca una tarjeta fantasma encolada.
 */
const hitlDoor = createLateBoundHitl({ log: logLine });

/**
 * El objeto de dependencias de canales que reciben las rutas `/api/v1`. ES UNA SOLA
 * referencia mutable a propósito: `createApp` corre en el paso 10 y `composeChannels`
 * en el 13, así que lo que nace tarde (`outbox`, la puerta del drenado de teardown,
 * FIX H4 + revocation 3c) se enlaza SOBRE ESTE objeto y las rutas lo ven porque lo
 * leen al servir (`channelOutbox()`), no porque lo copien al construirse.
 */
const channelRouteDeps: ApiV1ChannelDeps = {
  registry: channelRegistry,
  pairing: channelPairing,
};

// El Supervisor se construye aquí, y `createSupervisor` solo lo devuelve, porque el
// inbound de un canal necesita el puerto del Runner vivo (`runnerPortOf`) y
// `runStartup` no le pasa el Supervisor a `createOutboxWorker`. El constructor es
// inerte: quien levanta procesos sigue siendo `startAll()`, en el mismo paso 7.
const supervisor = new Supervisor(env);

/**
 * El router de entrega NO existe hasta que `createOutboxWorker` compone los
 * canales, y la composición necesita el `TurnExecution` — ciclo roto con enlace
 * tardío: `TurnExecution` invoca el hook en el terminal, nunca al construirse. Sin
 * composición (arranque sin canales) el hook no hace nada, el mismo fail-closed de
 * `onHumanRequest`.
 */
let channelDelivery: ((turn: CompletedTurn) => void) | undefined;

// H5-partial: el estado observado del proceso anterior no sobrevive al arranque
// (I3). Los adapters están oscuros hasta que el dashboard re-proyecte; lo
// deseado (digest/ventana) sobrevive al reset.
await resetObservedState(env.dataDir);
const runtime = await runStartup(
  {
    openStore: () => openManagerStore(env.dataDir),
    providers: runtimeProviders,
    provision: () => provisionAgents(env),
    // Cutover R3: el bot de Telegram es del Manager. Si un `agent.json` anterior
    // al corte conserva el token legado y además hay un canal proyectado, abortar
    // aquí (antes de cualquier Runner/HTTP/Loop) es lo que evita el doble
    // long-polling sobre un mismo token.
    assertNoDoubleTelegramBot: () => assertNoDoubleTelegramBot(env.dataDir),
    createSupervisor: () => supervisor,
    // Fase 3.5 (D8): el TurnExecution compartido se construye antes de createApp
    // y se inyecta también al Loop; con el repositorio durable para que cada
    // terminal de Initiative escriba `turns.complete` con su causa (§4.6).
    // Fase 3.7 (§9.7): el watchdog de apertura/silencio se lee de env — en
    // producción el default es real y NO cero (`0` significaría desactivado).
    createTurns: ({ store }) => {
      // [ÁRBITRO-1] reescrito por H3/B1: sin panel no se compone ningún delivery
      // (el panel sigue mostrando la espera y Telegram recibe cero llamadas).
      // Con panel, la puerta de salida es la de canales y el destino lo decide EL
      // VÍNCULO — nunca un `agent.json.telegramToken` (campo que el cutover dejó de
      // escribir) ni un chat de env. Sin vínculo la entrega registra su
      // `HUMAN_REQUEST_DELIVERY_SKIPPED`, es decir: antes «tarjeta perdida en
      // silencio», ahora decisión visible en el journal.
      const delivery = env.panelEnabled
        ? new HumanRequestDelivery({
            channel: hitlDoor,
            deliveries: store.agenda.humanRequestDeliveries,
            log: logLine,
          })
        : undefined;

      const turns = new TurnExecution({
        apiToken: env.apiToken,
        repository: store.agenda.turns,
        humanRequests: store.agenda.humanRequests,
        // T4-D/1: la reserva de admisión es durable. La misma instancia que
        // sirve la ruta y el Loop escribe en `agent_live_turns`.
        liveTurns: store.liveTurns,
        now: () => Date.now(),
        requestId: () => randomUUID(),
        expiryMs: env.waitingHumanExpiryMs,
        onHumanRequest: delivery
          ? (request) => {
              void delivery.deliver(request);
            }
          : undefined,
        dispatchTimeoutMs: env.turnDispatchTimeoutMs,
        // Slice (c) fix round A (C1): el turno terminado se entrega por canal.
        // `TurnExecution` lo llama fire-and-forget en el terminal y el router ya es
        // silencioso: un canal caído no convierte un turno bueno en `failed`. LA
        // DECISIÓN DE ORIGEN (humano → nunca, canal → siempre, Initiative → solo si
        // hay vínculo) es del router (`channels/delivery-router.ts`), no de aquí.
        onTurnCompleted: (turn) => {
          channelDelivery?.(turn);
        },
      });

      // T4-D/1: la admisión «un turno por Agent» sobrevive al reinicio. Las filas
      // durables de la vida anterior del Manager entran al registro como «no
      // verificadas»: ocupan el slot (un turno nuevo se rechaza con 409) porque el
      // Runner puede seguir ejecutando ese turno y ningún proceso sabe si terminó.
      try {
        const cargados = turns.loadUnverified(store.liveTurns.listLiveTurns());
        if (cargados > 0) logLine(`LIVE_TURNS_RECOVERED count=${cargados}`);
      } catch (error) {
        // Un fallo de lectura no impide arrancar: las filas siguen en disco y el
        // claim durable de cada `startTurn` las vuelve a bloquear (fail-closed).
        // Se ve en el journal, no en silencio.
        console.error("[pihub] LIVE_TURNS_LOAD_FAILED:", error);
      }
          return turns;
        },
        // T4-D/2: reconciliación de las reservas de admisión durables. `createTurns` acaba
        // de cargarlas como «no verificadas» y `startAll` ya levantó los Runners, así que
        // aquí se pregunta a la gate COMPARTIDA de cada Runner (`GET /api/status`) si
        // sigue ejecutando ese turno: confirmado = se conserva (el Agent sigue bloqueado),
        // huérfano = se libera la fila y el turno se cierra `failed`/`turn_orphaned`.
        // NUNCA lanza; lo que no se puede probar se queda como está (fail-closed) y el
        // siguiente arranque lo reconcilia. El endpoint es loopback y va con el token de
        // servicio del Manager (`/api/*` del Runner exige `Bearer` cuando hay API_TOKEN).
        reconcileLiveTurns: ({ store, supervisor, turns }) =>
          reconcileLiveTurns({
            liveTurns: store.liveTurns,
            supervisor: {
              state: (name) => supervisor.state(name),
              runnerPortOf: (name) => supervisor.runnerPortOf(name),
            },
            turns,
            apiToken: env.apiToken,
            now: () => Date.now(),
            log: logLine,
          }),
        createOAuth: (providers) => new OAuthService(providers),
        createApp: ({ supervisor, oauth, providers, turns, store }) => {
          // P2.3: construir el AutonomyControl real con el store y turns compartidos.
      // La autoridad efectiva se deriva una vez del modo (§2.1 del plan P2).
      const autonomyControl = new AutonomyControl({
        agenda: store.agenda,
        turns,
        authority: effectiveTriggerAuthority,
      });
      // Fix B2 (drenado de teardown): las rutas reciben el objeto COMPARTIDO, no un
      // literal nuevo. `createApp` es el paso 10 y `composeChannels` el 13, así que el
      // `outbox` tiene que caer sobre la MISMA referencia que `channelOutbox()` lee al
      // servir; un literal por copia lo dejaría `undefined` para siempre en producción.
      // Aquí solo se rellena lo que ya existe: `exchanges` es el MISMO objeto que
      // escribe el delivery-router (la puerta estrecha del store, una instancia por
      // base abierta) — sin él la ruta projection-in no tendría filas que servir.
      // `sessions` es el catálogo durable de sesiones (T3): una instancia por base
      // abierta, cerrada con el store, NUNCA un handle por request.
      Object.assign(channelRouteDeps, {
        exchanges: store.channels.exchanges,
        sessions: store.sessions,
      });
      return createApi(
        env,
        supervisor,
        oauth,
        providers,
        turns,
        {
          projection: store.agenda.projection,
          control: autonomyControl,
          deliveries: store.agenda.humanRequestDeliveries,
        },
        // El registry del arranque es el que sirve las rutas de canales: si el router
        // se fabricara el suyo, el `stopAll()` de abajo no vería nada.
        channelRouteDeps,
      );
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
    // Slice (c) fix round A (C1): LA composición de canales. La fabrica este
    // fichero y la arranca/para `runStartup`/`shutdownRuntime`, porque el CUÁNDO es
    // un contrato de apagado, no una decisión de canal.
    createOutboxWorker: ({ store, turns }) => {
      const composition = composeChannels({
        dataDir: env.dataDir,
        persistence: store.channels,
        // T5b/2: la sesión de un mensaje entrante es la SELECCIONADA en la
        // superficie del canal, y el catálogo durable es el dueño de ese puntero.
        // Es la misma instancia por base abierta que sirven las rutas `/sessions`:
        // el composition root SIEMPRE lo pasa (omitirlo es la dependencia histórica
        // de los tests, no un modo de producción).
        sessions: store.sessions,
        // El registry de las rutas y del `stopAll()` del apagado: uno solo.
        registry: channelRegistry,
        pairing: channelPairing,
        turns,
        resolveRunner: async (agentName) => {
          // `undefined` = el inbound se descarta. Un mensaje de un desconocido
          // NUNCA rearranca un Runner: eso le daría a quien escribe al bot el
          // ciclo de vida del proceso.
          const port = supervisor.runnerPortOf(agentName);
          return port === undefined ? undefined : { port };
        },
        log: (line) => console.error(`[pihub] ${line}`),
      });
      // Enlace tardío del hook (ver `channelDelivery` arriba).
      channelDelivery = composition.onTurnCompleted;
      // Fix B1: la tarjeta de `waiting_human` sale por la costura REAL de la
      // composición (router → outbox → adapter vivo), decidida por el vínculo.
      hitlDoor.bind(composition.hitl);
      // Fix B2 / H4: sin esto las rutas no tienen puerta de drenado y `PUT []`,
      // `DELETE /channels/:kind` y `DELETE /agents/:name` no dreñan la cola.
      channelRouteDeps.outbox = composition.outbox;
      return composition.worker;
    },
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
  // PRIMERO (gracia acotada + abort; nunca `failed` en shutdown), después los
  // adapters de canal (ningún inbound entra ya en un Runner que se muere), luego
  // `stopAll`, el cierre del store y del HTTP.
  await shutdownRuntime({ ...runtime, channels: channelRegistry });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
