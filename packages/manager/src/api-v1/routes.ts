import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import {
  agentPaths,
  isProtectedEnvKey,
  isValidEnvKey,
  listAgents,
  listEnvKeys,
  filesFromSkillZip,
  isValidSkillId,
  listMaterializedSkillIds,
  piInstall,
  piInstallFromContent,
  piRemove,
  piRemoveContentSkill,
  piVersion,
  readAgent,
  readEnvStore,
  replaceEnvStore,
  setEnv,
  unsetEnv,
  type AgentConfig,
  type AgentStatus,
  type ModelInfo,
  type PihubEnv,
} from "@pihub/shared";
import {
  createAgent,
  deleteAgent,
  listPackages,
  readSystemPrompt,
  updateAgent,
} from "../agents.js";
import { TurnExecution, type TurnHandle } from "../agenda/turn-execution.js";
import { DomainError } from "../agenda/errors.js";
import { listModels } from "../models.js";
import {
  createRuntimeProviders,
  type RuntimeProviders,
} from "@pihub/providers";
import type { Supervisor } from "../supervisor.js";
import type { OAuthService } from "../oauth.js";
import { apiError, HTTP_STATUS_BY_CODE, type ApiErrorCode } from "./errors.js";
import {
  classifyApiV1Auth,
  classifyServiceAuth,
  cookieValue,
  CSRF_COOKIE,
} from "./auth.js";
import { registerAutonomyRoutes, type AutonomyRouteDeps } from "./autonomy.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import type { AgentSessionCatalogue } from "../sessions/catalogue.js";
import type { AutonomyProjection } from "../agenda/autonomy-projection.js";
import type { AutonomyControl } from "../agenda/autonomy-control.js";
import {
  agentRuntimeFingerprint,
  decideRuntimeAction,
  projectSystemPrompt,
  projectUpdatedAgent,
  type RuntimeAction,
} from "./restart-policy.js";
import {
  isDuplicateTurn,
  rememberTurn,
  type TurnEventProfile,
  type TurnSseEvent,
} from "./turns.js";
import { diffPackages } from "./package-sync.js";
import {
  createAgentV1Schema,
  createTurnV1Schema,
  customProviderV1Schema,
  managedProviderProjectionV1Schema,
  packageItemV1Schema,
  pairingRequestV1Schema,
  approvePairingV1Schema,
  replaceChannelsV1Schema,
  replaceEnvV1Schema,
  skillContentV1Schema,
  replacePackagesV1Schema,
  setEnvValueV1Schema,
  updateAgentV1Schema,
} from "./schemas.js";
import type { ChannelAdapterFactory, ChannelKind } from "@pihub/channels";
import { isChannelKind } from "@pihub/channels";
    import { ChannelRuntimeRegistry, resolveDigest } from "../channels/registry.js";
    import {
      EXCHANGE_FEED_DEFAULT_LIMIT,
      EXCHANGE_FEED_MAX_LIMIT,
      type ChannelExchange,
      type ChannelExchangeLog,
    } from "../channels/exchange-log.js";
import {
  PairingError,
  PairingMachine,
  type ChannelPairing,
} from "../channels/pairing.js";
import {
  readChannelRecords,
  writeChannelRecords,
} from "../channels/store.js";

/**
 * La versión que reportan `/health` y `/status`. Sale del `package.json` de
 * `@pihub/manager` — nunca de una constante a mano, para que la imagen no
 * vuelva a declarar una versión distinta de la que publica. Se lee desde
 * `dist/api-v1/` y `../../package.json` cae siempre en `packages/manager`.
 */
const MANAGER_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

/** Variables de contexto de `/api/v1`. El correlationId viaja en toda respuesta de error. */
export type ApiV1Env = {
  Variables: {
    correlationId: string;
    /** Principal autenticado: `service` vía Bearer, `panel` vía cookie. */
    principal: { kind: "service" | "panel" };
  };
};

/**
 * Correlation ID de una petición: entra del caller si lo trae (el
 * dashboard lo manda), se genera si no. Sin él no se puede seguir un
 * turno entre los dos sistemas. Se exporta porque el guard del panel
 * (`/api/*`, en `api.ts`) emite el mismo vocabulario de error y necesita
 * el mismo identificador; se tipa estructuralmente para no acoplarse al
 * `Env` de Hono de cada superficie.
 */
export function correlationIdOf(c: {
  req: { header(name: string): string | undefined };
}): string {
  return c.req.header("x-correlation-id") ?? randomUUID();
}

/**
 * Inyección de dependencias de canales para `/api/v1`. En producción el
 * Manager usa el registry real (adapters grammy); los tests de rutas
 * inyectan un factory falso para observar el lifecycle sin red.
 */
    export interface ApiV1ChannelDeps {
      registry?: ChannelRuntimeRegistry;
      adapterFactory?: ChannelAdapterFactory;
      /**
       * Manager-owned pairing machine. Default: a file-backed machine on the
       * Agent's data dir; tests inject one with a fixed clock to exercise window
       * expiry without sleeping.
       */
      pairing?: PairingMachine;
      /**
       * Projection-in feed (slice (c) part 3a, design §1.2): the
       * `channel_exchanges` reader behind
       * `GET /agents/:name/channel-exchanges`. The router cannot build it — it
       * would need the SQLite driver `ManagerStore` hides — so the composition
       * root hands it over. Absent = no channel persistence composed, and the
       * feed is truthfully empty (nothing could have been mirrored).
       */
      exchanges?: ChannelExchangeLog;
      /**
       * Teardown drain (FIX H4, slice (c) review round 2; spec I2 + design §13):
       * the `channel_outbox` door the two removal routes call so rows of a
       * channel that left the projection reach the terminal `dead` state
       * WITHOUT a delivery attempt. Structural on purpose — the router cannot
       * build a `ChannelOutbox` (it needs the SQLite driver `ManagerStore`
       * hides), and the composition root hands the live one over, late-bound
       * exactly like `exchanges`. Absent = no queue composed, and the routes
       * behave as before this fix (nothing to drain).
       */
      outbox?: ChannelOutboxTeardown;
      /**
       * Catálogo durable de sesiones (T3 del ODD `agent-session-workspace`).
       *
       * Vive en este objeto por la misma razón que `exchanges`/`outbox`: el
       * router no puede construirlo (necesita el driver SQLite que
       * `ManagerStore` esconde) y `api.ts` ya reenvía ESTA misma bolsa de
       * dependencias de runtime al router, así que añadir un parámetro nuevo a
       * `createApiV1Router` dejaría el composition root sin forma de inyectarlo.
       * Lectura por request, nunca copia al construir.
       *
       * Ausente = ningún almacén durable compuesto: las rutas de sesión
       * responden 503 en vez de inventar un catálogo en memoria que mentiría
       * sobre su persistencia.
       */
      sessions?: AgentSessionCatalogue;
    }

/**
 * The only outbox face a channel-removal route needs. `deadFor` is idempotent
 * by state (it only touches `pending`/`in_flight` rows) and returns how many
 * rows it moved, which is what the route logs.
 *
 * `deadForAgent` is what an AGENT purge calls (fix B2, revocation 3c): a purge
 * has no kind list to iterate — the projection is being deleted with the Agent
 * — and a row of a kind nobody projected anymore would otherwise outlive it.
 */
export interface ChannelOutboxTeardown {
  deadFor(
    agentName: string,
    kind: ChannelKind,
    reason: string,
  ): Promise<number>;
  deadForAgent(agentName: string, reason: string): Promise<number>;
}

/**
 * Interfaz privada versionada del Manager (H01.01). Es la ÚNICA
 * frontera con el dashboard: se consume por HTTP contra la imagen
 * publicada, nunca importando código. Convive con las rutas `/api/*`
 * del panel, que no se tocan.
 */
export function createApiV1Router(
  env: PihubEnv,
  supervisor: Supervisor,
  oauth: OAuthService,
  providers: RuntimeProviders = createRuntimeProviders({
    dataDir: env.dataDir,
    oauthProviders: env.oauthProviders,
  }),
  turnsShared?: TurnExecution,
  autonomy?: {
    projection: Pick<AutonomyProjection, "snapshotForAgent">;
    control: AutonomyControl;
  },
  channels?: ApiV1ChannelDeps,
): Hono<ApiV1Env> {
  const app = new Hono<ApiV1Env>();
  /**
   * Lifecycle de los adapters del Agent, propiedad del Manager (design §1.4). El
   * factory por defecto habla con grammy; los tests de rutas inyectan uno
   * falso para observar el lifecycle sin red.
   */
      const channelRegistry =
        channels?.registry ??
        new ChannelRuntimeRegistry({ adapterFactory: channels?.adapterFactory });
      /**
       * Pairing machine (design §2.1): the Manager is the only party that sees
       * inbound, so binding a chat is its fact and the Dashboard mirrors it. Its
       * state is one file per Agent, hashes only — never a plaintext code.
       */
  const pairing =
    channels?.pairing ?? new PairingMachine({ dataDir: env.dataDir });
  /**
   * Outbox teardown door (FIX H4 + fix B2). Structural and OPTIONAL: the queue
   * lives on the SQLite driver `ManagerStore` hides, so only the composition
   * root can hand it over — and it does so LATE, because `createApp` is step 10
   * of `runStartup` while `composeChannels` is step 13.
   *
   * That is why this is a READER and not a snapshot: `const door =
   * channels?.outbox`, taken while the router is built, is `undefined` forever in
   * production — the very shape that kept the H4 drain inert outside tests. Every
   * route below calls the reader at request time.
   */
  const channelOutbox = () => channels?.outbox;
  /** Idempotencia de turnos por instancia del Manager (spec §5). */
  const turnosVistos = new Map<string, string>();
  //
  // Puente compartido WS→eventos→terminal (Fase 3.1): el registro de turnos
  // vivos vive en `TurnExecution`, la única fuente de `TURN_IN_PROGRESS` y
  // del abort. Fase 3.5 (D8): si el arranque ya construyó la instancia
  // compartida (Loop + ruta), se usa esa; si no (tests de la ruta), se crea
  // aquí una local sin repositorio durable.
  const turns = turnsShared ?? new TurnExecution({ apiToken: env.apiToken });
  const hayTurnoVivo = (name: string) => turns.hasLiveTurnForAgent(name);
  const hayAlgunTurnoVivo = () => turns.hasAnyLiveTurn();

  app.use("*", async (c, next) => {
    c.set("correlationId", correlationIdOf(c));
    await next();
  });

  // Auth dual: Bearer para callers servicio-a-servicio y cookie estricta
  // para el panel. Este guard vive dentro de `/api/v1`, antes de cualquier
  // ruta, para no alterar el guard legacy de `/api/*`.
  app.use("*", async (c, next) => {
    const cookie = c.req.header("cookie");
    const csrfCookie = cookieValue(cookie, CSRF_COOKIE);
    const verdict = classifyApiV1Auth(
      {
        authorizationHeader: c.req.header("authorization"),
        cookieHeader: cookie,
        method: c.req.method,
        csrfHeader: c.req.header("x-csrf-token"),
        csrfCookie,
        origin: c.req.header("origin"),
        requestOrigin: new URL(c.req.url).origin,
      },
      env.apiToken,
    );
    if (verdict.kind === "missing") {
      return fail(c, "MISSING_AUTH", "Service credential required");
    }
    if (verdict.kind === "invalid") {
      return fail(c, "INVALID_AUTH", "Service credential required");
    }
    if (verdict.kind === "csrf_invalid") {
      const code =
        c.req.header("x-csrf-token") && csrfCookie
          ? "CSRF_INVALID"
          : "CSRF_REQUIRED";
      return fail(
        c,
        code,
        code === "CSRF_REQUIRED" ? "CSRF token required" : "CSRF token invalid",
      );
    }
    // Guardar el principal autenticado para los handlers.
    c.set("principal", { kind: verdict.kind });
    // Gobernado rechaza cualquier cookie de panel, incluso si es válida.
    if (verdict.kind === "panel" && !env.panelEnabled) {
      return fail(c, "INVALID_AUTH", "Service credential required");
    }
    await next();
  });

  // Panel/operator extension: OAuth de providers. Estas rutas comparten el
  // OAuthService del Manager, pero no forman parte de la Interface del
  // dashboard/control plane.
  app.get("/auth/providers", async (c) =>
    c.json({ providers: await oauth.providers() }),
  );

  app.post("/auth/login/:provider", async (c) => {
    try {
      return c.json(await oauth.startLogin(c.req.param("provider")));
    } catch (error) {
      console.error(
        "[api-v1] fallo iniciando login OAuth:",
        c.get("correlationId"),
        error,
      );
      return fail(c, "BAD_REQUEST", "OAuth login could not be started");
    }
  });

  app.get("/auth/flows/:id", (c) => {
    const flow = oauth.getFlow(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "No existe" }, 404);
  });

  app.post("/auth/flows/:id/input", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    try {
      return c.json(
        await oauth.submitInput(c.req.param("id"), body.value ?? ""),
      );
    } catch (error) {
      console.error(
        "[api-v1] fallo enviando input al flujo OAuth:",
        c.get("correlationId"),
        error,
      );
      return fail(c, "BAD_REQUEST", "OAuth flow input was rejected");
    }
  });

  app.post("/auth/logout/:provider", async (c) => {
    await oauth.logout(c.req.param("provider"));
    return c.json({ ok: true });
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: MANAGER_VERSION,
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/readiness", async (c) => {
    const checks: Array<{ name: string; status: string }> = [];
    try {
      await listAgents(env.dataDir);
      checks.push({ name: "data-dir", status: "ok" });
    } catch {
      checks.push({ name: "data-dir", status: "error" });
    }
    const ok = checks.every((check) => check.status === "ok");
    return c.json({ status: ok ? "ok" : "degraded", checks }, ok ? 200 : 503);
  });

  // --- §3.1 Rotación de credencial ---

  app.post("/auth/rotate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      oldToken?: string;
      newToken?: string;
    };
    // El formato de la credencial lo fija §3.1: al menos 32 caracteres.
    if (!body.oldToken || !body.newToken || body.newToken.length < 32) {
      return fail(
        c,
        "BAD_REQUEST",
        "oldToken and newToken (min 32 chars) are required",
      );
    }
    if (body.oldToken !== env.apiToken)
      return fail(c, "INVALID_AUTH", "Old token does not match");
    // La rotación efectiva exige reiniciar el Manager con el nuevo valor en
    // el entorno: aceptar el cambio en memoria daría una falsa sensación de
    // haber rotado y se perdería al reiniciar.
    return fail(
      c,
      "RESOURCE_UNAVAILABLE",
      "Rotation requires a Manager restart with the new token",
    );
  });

  // --- §4.7 Modelos disponibles (solo lectura, Fase 1 §1.3 del plan) ---

  app.get("/models", async (c) => {
    let models: ModelInfo[];
    try {
      models = await listModels(providers);
    } catch (error) {
      console.error(
        "[api-v1] fallo listando modelos:",
        c.get("correlationId"),
        error,
      );
      return fail(c, "RESOURCE_UNAVAILABLE", "Model catalog unavailable");
    }
    return c.json({ models });
  });

  // --- Providers first-class (aditivo; /models permanece intacto) ---

  app.get("/providers", async (c) => {
    let snapshot: Awaited<ReturnType<typeof providers.snapshot>>;
    try {
      snapshot = await providers.snapshot();
    } catch (error) {
      console.error(
        "[api-v1] fallo listando providers:",
        c.get("correlationId"),
        error,
      );
      return fail(c, "RESOURCE_UNAVAILABLE", "Provider catalog unavailable");
    }
    return c.json({ providers: snapshot.providers });
  });

  app.put("/providers/custom/:providerId", async (c) => {
    const parsed = customProviderV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid custom Provider definition");
    try {
      const change = await providers.apply({
        type: "upsert-custom-provider",
        providerId: c.req.param("providerId"),
        definition: {
          baseUrl: parsed.data.baseUrl,
          models: parsed.data.models,
        },
        ...(parsed.data.apiKey !== undefined
          ? { apiKey: parsed.data.apiKey }
          : {}),
      });
      const provider = change.snapshot.providers.find(
        (item) => item.id === c.req.param("providerId"),
      );
      return provider
        ? c.json({ provider })
        : fail(c, "INTERNAL_ERROR", "Provider state unavailable");
    } catch {
      return fail(c, "BAD_REQUEST", "Invalid custom Provider definition");
    }
  });

  app.delete("/providers/custom/:providerId", async (c) => {
    try {
      await providers.apply({
        type: "delete-custom-provider",
        providerId: c.req.param("providerId"),
      });
      return c.json({ ok: true });
    } catch {
      return fail(c, "BAD_REQUEST", "Custom Provider could not be deleted");
    }
  });

  app.put("/managed/providers", async (c) => {
    const serviceAuth = classifyServiceAuth(
      c.req.header("authorization"),
      env.apiToken,
    );
    if (serviceAuth !== "ok")
      return fail(c, serviceAuth, "Service credential required");
    const parsed = managedProviderProjectionV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid managed Provider projection");
    try {
      const change = await providers.apply({
        type: "replace-managed-providers",
        providers: parsed.data.providers,
      });
      return c.json({
        providers: change.snapshot.providers.filter(
          (provider) => provider.origin === "managed",
        ),
      });
    } catch {
      return fail(
        c,
        "BAD_REQUEST",
        "Managed Provider projection could not be applied",
      );
    }
  });

  // --- §4.8 Estado global (Fase 1 §1.3 del plan) ---
  //
  // Sin `portRange`: la spec §7 prohíbe exponer topología interna de
  // puertos al dashboard (el puerto del Runner nunca sale de aquí, igual
  // que en `toAgentV1`).
  app.get("/status", async (c) => {
    const agents = await listAgents(env.dataDir);
    const providerSnapshot = await providers.snapshot();
    return c.json({
      version: MANAGER_VERSION,
      pi: await piVersion(env.dataDir),
      agents: agents.length,
      panel: env.panelEnabled,
      providerConfigurationIssues: providerSnapshot.configurationIssues,
    });
  });

  // --- Panel/operator extensions: commands ---
  // El dashboard no consume esta ruta; el panel necesita el catálogo humano
  // del Runner y nunca debe recibir su error crudo ni su topología.
  app.get("/agents/:name/commands", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    let status: AgentStatus;
    try {
      status = await supervisor.statusOf(config);
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
    if (status.state !== "running")
      return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/api/commands`,
        {
          headers: { authorization: `Bearer ${env.apiToken}` },
        },
      );
      if (!response.ok)
        return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
      const body = (await response.json().catch(() => undefined)) as
        | {
            skills?: unknown;
            prompts?: unknown;
          }
        | undefined;
      if (!Array.isArray(body?.skills) || !Array.isArray(body?.prompts)) {
        return fail(
          c,
          "RESOURCE_UNAVAILABLE",
          "Runner returned an invalid command catalog",
        );
      }
      return c.json({ skills: body.skills, prompts: body.prompts });
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
  });

  // --- §4.3 Agents ---

  app.get("/agents", async (c) => {
    const agents = await listAgents(env.dataDir);
    const statuses = await Promise.all(
      agents.map((agent) => supervisor.statusOf(agent)),
    );
    return c.json(statuses.map(toAgentV1));
  });

  app.post("/agents", async (c) => {
    const parsed = createAgentV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid agent payload");
    warnLegacyTelegramToken("POST /agents", parsed.data);
    try {
      const config = await createAgent(env, parsed.data);
      await supervisor.start(config.name);
      return c.json(toAgentV1(await supervisor.statusOf(config)), 201);
    } catch (error) {
      const message = (error as Error).message;
      // `createAgent` lanza en español ("ya existe"): el catálogo de
      // errores es en inglés, pero la detección tiene que casar con el
      // mensaje REAL del código, no con el del ejemplo del plan.
      if (/ya existe|exists/i.test(message)) {
        return fail(c, "AGENT_ALREADY_EXISTS", "Agent already exists");
      }
      return fail(c, "BAD_REQUEST", "Could not create agent");
    }
  });

  // Bug 4: la spec §4.3 promete GET /agents/:name (línea 100) y nunca
  // existió. `systemPrompt`/`packages`/`envKeys` SOLO aquí — nunca en el
  // listado (`GET /agents`), que volcaría todos los prompts del Runtime en
  // una sola respuesta.
  app.get("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const [status, systemPrompt, envKeys, packages, channels] = await Promise.all([
      supervisor.statusOf(config),
      readSystemPrompt(env, name),
      listEnvKeys(env.dataDir, name),
      listPackages(env, name),
      observedChannels(env.dataDir, pairing, name),
    ]);

    return c.json({ ...toAgentV1(status), systemPrompt, envKeys, packages, channels });
  });

  // Spec §4.3. Faltaba: `contract-red` no lo cubre, asi que nadie lo
  // echo en falta hasta que el adapter del dashboard intento su camino
  // idempotente (POST -> 409 -> PATCH) y se comio un 404.
  //
      // El reinicio se decide por HUELLA (restart-policy.ts), no por qué campo
      // vino en el body: el dashboard reconcilia mandando el estado COMPLETO en
      // cada llamada (model + systemPrompt en cada reconcile), así que decidir
      // por presencia de campo reiniciaría el Runner en cada reconciliación aun
      // sin cambios reales. Antes esto SOLO miraba telegramToken — cambiar el
      // Model o la Persona se persistía y el Runner en marcha nunca se enteraba.
      // Desde el cutover (part 3b) `telegramToken` ya NO entra en la huella: el
      // bot es del Manager y lo que mueve el arranque es `channels`.
  app.patch("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = updateAgentV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid agent payload");
    warnLegacyTelegramToken(`PATCH /agents/${name}`, parsed.data);
    
    try {
      const wasRunning = supervisor.state(name).state === "running";
      const antes = await snapshotRuntimeInput(env, config);

      // Proyección SIN escribir a disco: hace falta saber si este PATCH
      // reiniciaría el Runner ANTES de persistir nada, para poder rechazar
      // con 409 TURN_IN_PROGRESS sin dejar el config a medias mientras el
      // Runner viejo (con el turno vivo) sigue corriendo.
      const proyectado = projectUpdatedAgent(config, parsed.data);
      const despuesProyectado = {
        ...antes,
        model: proyectado.model,
        thinkingLevel: proyectado.thinkingLevel,
        ttsVoice: proyectado.ttsVoice,
        memory: proyectado.memory,
        systemPrompt: projectSystemPrompt(antes.systemPrompt, parsed.data),
      };

      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: proyectado.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !==
          agentRuntimeFingerprint(despuesProyectado),
      });

      // Reiniciar o parar tumbaría el WS del turno en curso (spec de bug 1:
      // "reiniciar mata turnos vivos"). Se rechaza ANTES de escribir nada:
      // el caller puede reintentar cuando el turno termine, o abortarlo
      // primero con POST .../turns/:turnId/abort si de verdad quiere forzarlo.
      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      const actualizado = await updateAgent(env, name, parsed.data);
      await aplicarRuntimeAction(supervisor, name, action);

      return c.json(toAgentV1(await supervisor.statusOf(actualizado)));
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update agent");
    }
  });

      app.delete("/agents/:name", async (c) => {
        const name = c.req.param("name");
        const config = await readAgent(env.dataDir, name).catch(() => undefined);
        if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
        await supervisor.stop(name);
        // Revocation (c) — Agent deletion is a CHANNEL teardown too (spec
        // `agent-channels`, and fix B2 of the verify round: until this call existed,
        // the bot of a purged Agent kept long-polling until the Manager restarted,
        // which is the highest-incident-risk gap of the change: duplicate-token
        // conflicts plus a live bot answering a chat whose Agent no longer exists).
        //
        // Silent by construction — no adapter sends a farewell, and the queue rows
        // go to the terminal `dead` state WITHOUT a delivery attempt (I2: a deleted
        // Agent's outbox must not retry forever). The agent directory itself takes
        // `channels.json` and `channel-pairing.json` with it (`deleteAgent` below);
        // the two SQLite tables are the state that `rm -rf` cannot reach.
        await channelRegistry.stopAgent(name);
        try {
          const drained = await channelOutbox()?.deadForAgent(
            name,
            "agent deletion: DELETE /agents/:name",
          );
          if (drained) {
            console.log(
              `[api-v1] CHANNEL_OUTBOX_TEARDOWN agent=${name} dead=${drained}`,
            );
          }
          const mirrored = channels?.exchanges?.deleteForAgent(name) ?? 0;
          if (mirrored) {
            console.log(
              `[api-v1] CHANNEL_EXCHANGES_PURGED agent=${name} rows=${mirrored}`,
            );
          }
        } catch (error) {
          // Teardown is best-effort and never reverses a deletion: an unreachable
          // queue would leave the Agent half-purged, which is worse than a row that
          // dies on its own when the next projection replaces it.
          console.error(
            "[api-v1] fallo drenando canales del Agent:",
            c.get("correlationId"),
            error,
          );
        }
        // The session catalogue is the rest of the Agent's state that `deleteAgent`
        // cannot reach: the directory goes away with a recursive delete, the rows
        // do not. Without this purge, re-creating an Agent with the same name
        // inherits the previous conversations AND their per-surface selection —
        // the identity bug this unit closes.
        //
        // NOT best-effort, unlike the channel teardown above: an unreachable queue
        // is not reversible, but a catalogue that cannot be purged is a reason NOT
        // to finish the delete. Answering 500 with the Agent intact keeps "a
        // deleted Agent has no catalogue" true and makes the retry meaningful;
        // purging after `deleteAgent` would answer 500 on an Agent that no longer
        // exists, and leaving the rows silently would restore the bug.
        const catalogue = channels?.sessions;
        if (catalogue) {
          try {
            const purged = catalogue.deleteForAgent(name);
            if (purged) {
              console.log(
                `[api-v1] SESSION_CATALOGUE_PURGED agent=${name} sessions=${purged}`,
              );
            }
          } catch (error) {
            console.error(
              "[api-v1] fallo purgando el catálogo de sesiones del Agent:",
              c.get("correlationId"),
              error,
            );
            return fail(c, "INTERNAL_ERROR", "Could not delete the agent");
          }
        }
        await deleteAgent(env, name);
        return c.body(null, 204);
      });

  // --- §4.3b Env del Agent (Fase 1, §1.3 del plan) ---
  //
  // Conjunto COMPLETO, no variables sueltas. El store GLOBAL queda fuera de
  // /api/v1 a propósito: un store compartido filtraría config entre Agents
  // hermanos; lo Runtime-wide ya viaja por UserRuntimeSecrets.

  app.get("/agents/:name/env", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    return c.json({ keys: await listEnvKeys(env.dataDir, name) });
  });

  app.put("/agents/:name/env", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = replaceEnvV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid env payload");

    try {
      const wasRunning = supervisor.state(name).state === "running";
      const antes = await snapshotRuntimeInput(env, config);
      const despuesProyectado = { ...antes, env: parsed.data.env };

      // enabled no cambia por esta ruta: solo las ramas 3 y 4 de
      // decideRuntimeAction pueden aplicar (ninguna arranca ni para el
      // proceso por sorpresa, solo reinicia si el env realmente cambió).
      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: config.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !==
          agentRuntimeFingerprint(despuesProyectado),
      });

      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      await replaceEnvStore(env.dataDir, parsed.data.env, name);
      await aplicarRuntimeAction(supervisor, name, action);

      return c.json({ keys: await listEnvKeys(env.dataDir, name) });
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update env");
    }
  });

  // Operaciones atómicas para el panel: conservan las variables que otras
  // pestañas puedan haber añadido y nunca devuelven valores secretos.
  app.put("/agents/:name/env/:key", async (c) => {
    const name = c.req.param("name");
    const key = c.req.param("key");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    if (!isValidEnvKey(key) || isProtectedEnvKey(key))
      return fail(c, "BAD_REQUEST", "Invalid env key");

    const parsed = setEnvValueV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid env payload");

    try {
      const wasRunning = supervisor.state(name).state === "running";
      const antes = await snapshotRuntimeInput(env, config);
      const despuesProyectado = {
        ...antes,
        env: { ...antes.env, [key]: parsed.data.value },
      };
      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: config.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !==
          agentRuntimeFingerprint(despuesProyectado),
      });
      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      await setEnv(env.dataDir, key, parsed.data.value, name);
      await aplicarRuntimeAction(supervisor, name, action);
      return c.json({ keys: await listEnvKeys(env.dataDir, name) });
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update env");
    }
  });

  app.delete("/agents/:name/env/:key", async (c) => {
    const name = c.req.param("name");
    const key = c.req.param("key");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    if (!isValidEnvKey(key) || isProtectedEnvKey(key))
      return fail(c, "BAD_REQUEST", "Invalid env key");

    try {
      const wasRunning = supervisor.state(name).state === "running";
      const antes = await snapshotRuntimeInput(env, config);
      const projectedEnv = { ...antes.env };
      delete projectedEnv[key];
      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: config.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !==
          agentRuntimeFingerprint({ ...antes, env: projectedEnv }),
      });
      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      await unsetEnv(env.dataDir, key, name);
      await aplicarRuntimeAction(supervisor, name, action);
      return c.json({ keys: await listEnvKeys(env.dataDir, name) });
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update env");
    }
  });

  // Store global del panel: solo claves en lectura y operaciones por clave.
  // Un cambio global se aplica a los Runners activos mediante el mismo reload
  // diferido que usaba la superficie legacy, sin mezclarlo con un Agent.
  app.get("/env", async (c) =>
    c.json({ keys: await listEnvKeys(env.dataDir) }),
  );

  app.put("/env/:key", async (c) => {
    const key = c.req.param("key");
    if (!isValidEnvKey(key) || isProtectedEnvKey(key))
      return fail(c, "BAD_REQUEST", "Invalid env key");
    const parsed = setEnvValueV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid env payload");

    try {
      await setEnv(env.dataDir, key, parsed.data.value);
      scheduleGlobalReload(supervisor);
      return c.json({ keys: await listEnvKeys(env.dataDir) });
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update env");
    }
  });

  app.delete("/env/:key", async (c) => {
    const key = c.req.param("key");
    if (!isValidEnvKey(key) || isProtectedEnvKey(key))
      return fail(c, "BAD_REQUEST", "Invalid env key");

    try {
      const existed = await unsetEnv(env.dataDir, key);
      if (existed) scheduleGlobalReload(supervisor);
      return c.json({ keys: await listEnvKeys(env.dataDir) });
    } catch {
      return fail(c, "BAD_REQUEST", "Could not update env");
    }
  });

  // --- §4.3c Paquetes del Agent (Fase 1, §1.3 del plan) ---
  //
  // Conjunto COMPLETO, converge con `pi install`/`pi remove` reales — eso
  // no se prueba con unitarios (necesita el binario `pi` y red), se
  // verifica con contract-red contra el Manager real (§1.5).

  app.get("/agents/:name/packages", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    return c.json({ packages: await listPackages(env, name) });
  });

  app.put("/agents/:name/packages", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = replacePackagesV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid packages payload");

    const actuales = await listPackages(env, name);
    const { toInstall, toRemove } = diffPackages(
      actuales,
      parsed.data.packages,
    );

    // Sin diferencia: no hay nada que instalar/quitar ni Runner que
    // reiniciar. Responde ya, sin tocar pi ni el registro de turnos.
    if (toInstall.length === 0 && toRemove.length === 0) {
      return c.json({ packages: actuales }, 202);
    }

    const wasRunning = supervisor.state(name).state === "running";
    // Instalar/quitar un paquete solo tiene efecto si el Runner se reinicia
    // para recogerlo — mismo riesgo que el PATCH: no tumbar un turno vivo.
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "Agent has a turn in progress; retry after it finishes",
      );
    }

    const workspaceDir = agentPaths(env.dataDir, name).workspaceDir;
    for (const source of toInstall) {
      const result = await piInstall(env.dataDir, source, workspaceDir);
      if (!result.ok)
        return fail(c, "BAD_REQUEST", "Could not install package");
    }
    for (const source of toRemove) {
      const result = await piRemove(env.dataDir, source, workspaceDir);
      if (!result.ok) return fail(c, "BAD_REQUEST", "Could not remove package");
    }

    if (wasRunning) await supervisor.restart(name);

    return c.json({ packages: await listPackages(env, name) }, 202);
  });

  // --- Panel/operator extensions: paquetes por item ---
  app.post("/agents/:name/packages", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    const parsed = packageItemV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env, name);
    if (actuales.includes(parsed.data.source))
      return c.json({ packages: actuales }, 202);

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "Agent has a turn in progress; retry after it finishes",
      );
    }

    const result = await piInstall(
      env.dataDir,
      parsed.data.source,
      agentPaths(env.dataDir, name).workspaceDir,
    );
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not install package");
    scheduleAgentReload(supervisor, name);
    return c.json({ packages: await listPackages(env, name) }, 202);
  });

  app.delete("/agents/:name/packages", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    const parsed = packageItemV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env, name);
    if (!actuales.includes(parsed.data.source))
      return c.json({ packages: actuales }, 202);

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "Agent has a turn in progress; retry after it finishes",
      );
    }

    const result = await piRemove(
      env.dataDir,
      parsed.data.source,
      agentPaths(env.dataDir, name).workspaceDir,
    );
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not remove package");
    scheduleAgentReload(supervisor, name);
    return c.json({ packages: await listPackages(env, name) }, 202);
  });

  // --- Canales del Agent (channels-and-mcp, slice (c) part 1) ---
  //
  // El Manager es quien posee el ciclo de vida del bot: el token entra por
  // esta ruta, vive en memoria del registry y NUNCA se escribe a
  // `agent.json` ni se devuelve en ninguna lectura. La superficie GET/PUT
  // es replace-all: `[]` para todos los adapters y vacía el estado (I2).
  // Pairing y outbox son la parte 2 de este slice: aquí no hay todavía
  // código de approval ni de cola de entrega.
  //
  // Forma del contrato D→P (decisión de slice (c)): `{kind, label?,
  // token?, tokenDigest?, pairingWindowEndsAt?}`. No hay `sessionKey` — la
  // sesión principal del Agent la resuelve el Manager (sesión unificada) —
  // y no hay `status`: el estado de pairing es observable del Manager, y un
  // canal revocado no se proyecta. `pairingWindowEndsAt` (null = ventana
  // CERRADA) solo se guarda en el registro; parte 2 es quien la consume.
  app.get("/agents/:name/channels", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    return c.json({ channels: await readChannelRecords(env.dataDir, name) });
  });

  app.put("/agents/:name/channels", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = replaceChannelsV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid channels payload");

    try {
      const wasRunning = supervisor.state(name).state === "running";
      // FIX H4: the kinds that are about to LEAVE the projection. Read before
      // `replaceAll`, which is what converges the observed set — after it, the
      // removed kinds are already gone and their queue would be orphaned.
      const kindsBefore = (await readChannelRecords(env.dataDir, name)).map(
        (record) => record.kind,
      );
      const antes = await snapshotRuntimeInput(env, config);
      // Solo (kind, tokenDigest) decide reinicio: una etiqueta no llega a la
      // huella (restart-policy.ts), así que renombrar un canal no tumba el
      // turno en curso. El digest se normaliza igual que en el registry, así
      // que "token en claro" y "su digest" producen la MISMA huella.
      const despuesProyectado = {
        ...antes,
        channels: parsed.data.channels.map((channel) => ({
          kind: channel.kind,
          label: channel.label,
          tokenDigest: resolveDigest(channel),
        })),
      };
      // enabled no cambia por esta ruta.
      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: config.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !==
          agentRuntimeFingerprint(despuesProyectado),
      });

      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      const records = await channelRegistry.replaceAll(
        name,
        parsed.data.channels,
      );
      await writeChannelRecords(env.dataDir, name, records);
      // FIX H4 (I2 + design §13): a kind that left the projection also loses its
      // queue — its rows go to `dead` WITHOUT a delivery attempt and without a
      // farewell. Idempotent by state, so the same projection twice drains
      // nothing; only the kinds that actually disappeared are touched.
      const kindsAfter = new Set(records.map((record) => record.kind));
      for (const kind of kindsBefore) {
        if (kindsAfter.has(kind)) continue;
            const drained = await channelOutbox()?.deadFor(
              name,
              kind,
              "channel teardown: removed from the projection",
            );
            if (drained) {
          console.log(
            `[api-v1] CHANNEL_OUTBOX_TEARDOWN agent=${name} kind=${kind} dead=${drained}`,
          );
        }
      }
      // I2 on the pairing side: a kind that left the projection also loses its
      // binding and its outstanding codes.
      await pairing.prune(
        name,
        records.map((record) => record.kind),
      );
      await aplicarRuntimeAction(supervisor, name, action);

      return c.json({ channels: records }, 202);
    } catch (error) {
      console.error(
        "[api-v1] fallo aplicando canales:",
        c.get("correlationId"),
        error,
      );
      return fail(c, "INTERNAL_ERROR", "Could not update channels");
    }
  });

      // --- Pairing de canales (channels-and-mcp, slice (c) part 2a) ---
      //
      // The Dashboard creates the intent and mirrors the result; the binding
      // itself is a Manager fact, because the Manager is the only party that
      // sees inbound traffic. Two shapes of the same operation are exposed:
      //   POST   …/pairing  — "this chat wants in": auto-pair while the projected
      //                        window is open, a code outside it; with
      //                        `decision: approve|reject` it is the command the
      //                        Dashboard sends when the owner clicks.
      //   POST   …/approve  — the owner's redemption of a code for one chat.
      //   DELETE …/:kind    — silent teardown of one channel: adapter stopped,
      //                        record dropped, pairing state dropped, restart
      //                        decided by the runtime fingerprint.
      // Codes are hashed at rest (`channels/pairing.ts`); the plaintext one
      // crosses this response and nothing else. No route here can read a token.
      app.post("/agents/:name/channels/:kind/pairing", async (c) => {
        const name = c.req.param("name");
        const kind = channelKindOfRoute(c.req.param("kind"));
        if (!(await readAgent(env.dataDir, name).catch(() => undefined))) {
          return fail(c, "AGENT_NOT_FOUND", "Agent not found");
        }
        if (!kind) return fail(c, "BAD_REQUEST", "Unsupported channel kind");
        const parsed = pairingRequestV1Schema.safeParse(
          await c.req.json().catch(() => ({})),
        );
        if (!parsed.success)
          return fail(c, "BAD_REQUEST", "Invalid pairing request payload");
    
        try {
          if (parsed.data.decision === "approve") {
            const state = await pairing.approve(name, kind, {
              code: parsed.data.code as string,
              externalChatId: parsed.data.externalChatId,
            });
            return c.json(pairingView(state), 200);
          }
          if (parsed.data.decision === "reject") {
            const state = await pairing.reject(
              name,
              kind,
              parsed.data.externalChatId,
            );
            return c.json(pairingView(state), 200);
          }
          const result = await pairing.requestPairing(
            name,
            kind,
            parsed.data.externalChatId,
          );
          return c.json(
            {
              ...pairingView(result.pairing),
              autoPaired: result.autoPaired,
              ...(result.code ? { code: result.code } : {}),
            },
            200,
          );
        } catch (error) {
          return pairingFailure(c, error, "pairing request");
        }
      });
    
      app.post("/agents/:name/channels/:kind/approve", async (c) => {
        const name = c.req.param("name");
        const kind = channelKindOfRoute(c.req.param("kind"));
        if (!(await readAgent(env.dataDir, name).catch(() => undefined))) {
          return fail(c, "AGENT_NOT_FOUND", "Agent not found");
        }
        if (!kind) return fail(c, "BAD_REQUEST", "Unsupported channel kind");
        const parsed = approvePairingV1Schema.safeParse(
          await c.req.json().catch(() => ({})),
        );
        if (!parsed.success)
          return fail(c, "BAD_REQUEST", "Invalid pairing approval payload");
    
        try {
          const state = await pairing.approve(name, kind, {
            code: parsed.data.code,
            externalChatId: parsed.data.externalChatId,
          });
          return c.json(pairingView(state), 200);
        } catch (error) {
          return pairingFailure(c, error, "pairing approval");
        }
      });
    
      app.delete("/agents/:name/channels/:kind", async (c) => {
        const name = c.req.param("name");
        const kind = channelKindOfRoute(c.req.param("kind"));
        const config = await readAgent(env.dataDir, name).catch(() => undefined);
        if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
        if (!kind) return fail(c, "BAD_REQUEST", "Unsupported channel kind");
    
        const records = await readChannelRecords(env.dataDir, name);
        const remaining = records.filter((record) => record.kind !== kind);
        if (remaining.length === records.length) {
          return fail(
            c,
            "CHANNEL_NOT_FOUND",
            `agent has no "${kind}" channel`,
          );
        }
    
        try {
          const wasRunning = supervisor.state(name).state === "running";
          const antes = await snapshotRuntimeInput(env, config);
          const despuesProyectado = {
            ...antes,
            channels: remaining.map((record) => ({
              kind: record.kind,
              label: record.label,
              tokenDigest: record.tokenDigest,
            })),
          };
          const action = decideRuntimeAction({
            wasRunning,
            wasEnabled: config.enabled,
            isEnabled: config.enabled,
            fingerprintChanged:
              agentRuntimeFingerprint(antes) !==
              agentRuntimeFingerprint(despuesProyectado),
          });
    
          if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
            return fail(
              c,
              "TURN_IN_PROGRESS",
              "Agent has a turn in progress; retry after it finishes",
            );
          }
    
          // Silent teardown (I2): stop first, then forget — no farewell message
          // and no state left to observe.
          await channelRegistry.remove(name, kind);
          await writeChannelRecords(env.dataDir, name, remaining);
          await pairing.remove(name, kind);
          // FIX H4 (I2 + design §13): the removed kind's queue goes with it —
          // `dead`, without a single send. `deadFor` only touches
          // `pending`/`in_flight` rows, so delivered history stays readable.
              const drained = await channelOutbox()?.deadFor(
                name,
                kind,
                "channel teardown: DELETE /channels/:kind",
              );
              if (drained) {
            console.log(
              `[api-v1] CHANNEL_OUTBOX_TEARDOWN agent=${name} kind=${kind} dead=${drained}`,
            );
          }
          await aplicarRuntimeAction(supervisor, name, action);
    
          return c.json({ channels: remaining }, 202);
        } catch (error) {
          console.error(
            "[api-v1] fallo removing channel:",
            c.get("correlationId"),
            error,
          );
              return fail(c, "INTERNAL_ERROR", "Could not remove channel");
            }
          });
    
          // --- Feed de intercambios (channels-and-mcp, slice (c) part 3a, c-I11) ---
          //
          // `channel_exchanges` es la única vía por la que un intercambio no-web
          // llega al Dashboard: no existe dirección de confianza P→D (toda llamada
          // es D→P), así que D DRENA projection-in con esta lectura y escribe la
          // fila en su transcript autoritativo (design §1.2). Lo que el lector
          // necesita saber, y nada más:
          //   * `after` es EXCLUSIVO y las filas vienen ascendentes por `seq`: una
          //     fila ya dreanada no vuelve a aparecer;
          //   * `latestSeq` es el cursor GLOBAL del Agent, para que una página vacía
          //     informe igualmente dónde está el lector;
          //   * la página está acotada y el límite EFECTIVO se devuelve en `limit`
          //     (pedir 99999 no es volcar la tabla);
          //   * un Agent sin filas es 200 con `[]`: «no hay espejo» es el estado
          //     normal de un Agent solo-web, no un error. Un 404 aquí solo significa
          //     que el Agent no existe.
          // Sin persistencia de canales compuesta (`channels.exchanges` ausente) el
          // feed está vacío de forma VERAZ: nadie pudo reflejar un intercambio.
          app.get("/agents/:name/channel-exchanges", async (c) => {
            const name = c.req.param("name");
            const config = await readAgent(env.dataDir, name).catch(() => undefined);
            if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    
            const after = feedCursorOf(c.req.query("after"));
            if (after === undefined) {
              return fail(c, "BAD_REQUEST", "`after` must be a non-negative integer");
            }
            const limit = feedLimitOf(c.req.query("limit"));
            const log = channels?.exchanges;
    
            if (!log) {
              return c.json({
                agentName: name,
                after,
                limit,
                latestSeq: 0,
                exchanges: [],
              });
            }
    
            return c.json({
              agentName: name,
              after,
              limit,
              latestSeq: log.latestSeq(name),
              exchanges: log.listAfter(name, after, limit).map(exchangeView),
            });
          });
    
      // --- Skills desde contenido del dashboard ---
  // No reutilizan /packages: pi registra un source local como path interno.
  // Estas rutas exponen exclusivamente el skillId UUID que el dashboard
  // aportó, y mantienen ese source persistente mientras siga instalado.
  app.get("/agents/:name/skills", async (c) => {
    const name = c.req.param("name");
    if (!(await readAgent(env.dataDir, name).catch(() => undefined))) {
      return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    }
    return c.json({
      skills: await listMaterializedSkillIds(
        env.dataDir,
        agentPaths(env.dataDir, name).workspaceDir,
      ),
    });
  });

  app.post("/agents/:name/skills", async (c) => {
    const name = c.req.param("name");
    if (!(await readAgent(env.dataDir, name).catch(() => undefined))) {
      return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    }
    const content = await skillContentOf(c);
    if (!content)
      return fail(c, "BAD_REQUEST", "Invalid skill content payload");

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "Agent has a turn in progress; retry after it finishes",
      );
    }
    const result = await piInstallFromContent(
      env.dataDir,
      content.skillId,
      content.files,
      agentPaths(env.dataDir, name).workspaceDir,
    );
    if (!result.ok)
      return fail(c, "BAD_REQUEST", "Could not install skill content");
    if (wasRunning) scheduleAgentReload(supervisor, name);
    return c.json(
      {
        skills: await listMaterializedSkillIds(
          env.dataDir,
          agentPaths(env.dataDir, name).workspaceDir,
        ),
      },
      202,
    );
  });

  app.delete("/agents/:name/skills/:skillId", async (c) => {
    const { name, skillId } = c.req.param();
    if (!(await readAgent(env.dataDir, name).catch(() => undefined))) {
      return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    }
    if (!isValidSkillId(skillId))
      return fail(c, "BAD_REQUEST", "Invalid skillId");

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "Agent has a turn in progress; retry after it finishes",
      );
    }
    const result = await piRemoveContentSkill(
      env.dataDir,
      skillId,
      agentPaths(env.dataDir, name).workspaceDir,
    );
    if (!result.ok)
      return fail(c, "BAD_REQUEST", "Could not remove skill content");
    if (wasRunning) scheduleAgentReload(supervisor, name);
    return c.json(
      {
        skills: await listMaterializedSkillIds(
          env.dataDir,
          agentPaths(env.dataDir, name).workspaceDir,
        ),
      },
      202,
    );
  });

  app.get("/skills", async (c) =>
    c.json({ skills: await listMaterializedSkillIds(env.dataDir) }),
  );

  app.post("/skills", async (c) => {
    const content = await skillContentOf(c);
    if (!content)
      return fail(c, "BAD_REQUEST", "Invalid skill content payload");
    // Una recarga global reinicia todos los Runners; no puede cortar el
    // turno vivo de ningún Agent, igual que la variante local.
    if (hayAlgunTurnoVivo())
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "An Agent has a turn in progress; retry after it finishes",
      );

    const result = await piInstallFromContent(
      env.dataDir,
      content.skillId,
      content.files,
    );
    if (!result.ok)
      return fail(c, "BAD_REQUEST", "Could not install skill content");
    scheduleGlobalReload(supervisor);
    return c.json({ skills: await listMaterializedSkillIds(env.dataDir) }, 202);
  });

  app.delete("/skills/:skillId", async (c) => {
    const skillId = c.req.param("skillId");
    if (!isValidSkillId(skillId))
      return fail(c, "BAD_REQUEST", "Invalid skillId");
    if (hayAlgunTurnoVivo())
      return fail(
        c,
        "TURN_IN_PROGRESS",
        "An Agent has a turn in progress; retry after it finishes",
      );

    const result = await piRemoveContentSkill(env.dataDir, skillId);
    if (!result.ok)
      return fail(c, "BAD_REQUEST", "Could not remove skill content");
    scheduleGlobalReload(supervisor);
    return c.json({ skills: await listMaterializedSkillIds(env.dataDir) }, 202);
  });

  // --- Autonomía (P2.3) ---
  if (autonomy) {
    const agentExists = async (name: string): Promise<boolean> => {
      const config = await readAgent(env.dataDir, name).catch(() => undefined);
      return config !== undefined;
    };
    const autonomyDeps: AutonomyRouteDeps = {
      projection: autonomy.projection,
      control: autonomy.control,
      agentExists,
      now: () => Date.now(),
      // P2.4a: política de Triggers del agente (autonomy.triggers, aditivo) para
      // el gate de la autoridad `agent`. El repositorio aplica los defaults si no
      // viene o si el Agent no la declara. Lectura fail-closed (R4-004): solo
      // ENOENT (agente sin config) devuelve undefined (defaults); cualquier otro
      // error de lectura o un JSON inválido lanza AUTONOMY_DISABLED.
      readAgentTriggerPolicy: async (name) => {
        let raw: string;
        try {
          raw = await fs.readFile(
            agentPaths(env.dataDir, name).configFile,
            "utf8",
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return undefined;
          throw new DomainError(
            "AUTONOMY_DISABLED",
            `lectura de la config del agente ${name} falló (${String(code ?? error)}): fail-closed`,
          );
        }
        try {
          return (JSON.parse(raw) as AgentConfig).autonomy?.triggers;
        } catch {
          throw new DomainError(
            "AUTONOMY_DISABLED",
            `config del agente ${name} no es JSON válido: fail-closed`,
          );
        }
      },
    };
    registerAutonomyRoutes(app, autonomyDeps);
  }

  app.get("/packages", async (c) =>
    c.json({ packages: await listPackages(env) }),
  );

  app.post("/packages", async (c) => {
    const parsed = packageItemV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env);
    if (actuales.includes(parsed.data.source))
      return c.json({ packages: actuales }, 202);
    const result = await piInstall(env.dataDir, parsed.data.source);
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not install package");
    scheduleGlobalReload(supervisor);
    return c.json({ packages: await listPackages(env) }, 202);
  });

  app.delete("/packages", async (c) => {
    const parsed = packageItemV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success)
      return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env);
    if (!actuales.includes(parsed.data.source))
      return c.json({ packages: actuales }, 202);
    const result = await piRemove(env.dataDir, parsed.data.source);
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not remove package");
    scheduleGlobalReload(supervisor);
    return c.json({ packages: await listPackages(env) }, 202);
  });

  // --- §4.3d Ciclo de vida explícito (Fase 1, §1.3 del plan) ---
  //
  // Operación imperativa, distinta del estado declarativo del PATCH.
  // start/stop mantienen `enabled` en sync con la acción — igual que ya
  // hace el panel (`api.ts`) — para que un reconcile posterior no lo
  // deshaga sin querer.
  for (const action of ["start", "stop", "restart"] as const) {
    app.post(`/agents/:name/${action}`, async (c) => {
      const name = c.req.param("name");
      const config = await readAgent(env.dataDir, name).catch(() => undefined);
      if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(
          c,
          "TURN_IN_PROGRESS",
          "Agent has a turn in progress; retry after it finishes",
        );
      }

      let actualizado = config;
      if (action === "start") {
        actualizado = await updateAgent(env, name, { enabled: true });
        await supervisor.start(name);
      } else if (action === "stop") {
        actualizado = await updateAgent(env, name, { enabled: false });
        await supervisor.stop(name);
      } else {
        await supervisor.restart(name);
      }

      return c.json(toAgentV1(await supervisor.statusOf(actualizado)));
    });
  }

  // --- §4.4 Sesiones (T3: catálogo durable + selección por superficie) ---
  //
  // `POST /agents/:name/sessions` conserva el contrato legacy documentado en
  // `docs/manager-api-v1.md` §8 (`{key, channel, agent, createdAt}`), pero ahora la
  // sesión es una FILA durable del catálogo del Agent en vez de un eco: el stub
  // anterior inventaba la identidad en cada llamada y no la guardaba en ninguna
  // parte. GET y `POST …/select` son aditivos y viven en el mismo catálogo.
  //
  // La autoridad sigue siendo la del router: este registro ocurre DESPUÉS del
  // guard dual Bearer/cookie + CSRF de `/api/v1`, así que las tres rutas heredan
  // la misma protección sin añadir una puerta nueva.
  registerSessionRoutes(app, {
    agentExists: async (name) =>
      (await readAgent(env.dataDir, name).catch(() => undefined)) !== undefined,
    // Lector, no copia: el store se compone en `createApp` y en algunos arranques
    // de test no existe; leerlo al servir evita el `undefined` congelado.
    catalogue: () => channels?.sessions,
    now: () => Date.now(),
  });

  // --- Panel/operator extensions: transcribe ---
  // Se reenvía el multipart al Runner; el Manager no duplica el cliente STT.
  app.post("/agents/:name/transcribe", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    let status: AgentStatus;
    try {
      status = await supervisor.statusOf(config);
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
    if (status.state !== "running")
      return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(
        `http://127.0.0.1:${status.port}/api/transcribe`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.apiToken}`,
            ...(c.req.header("content-type")
              ? { "content-type": c.req.header("content-type")! }
              : {}),
          },
          body: c.req.raw.body,
          duplex: "half",
        } as RequestInit,
      );

      if (response.status === 501)
        return c.json({ error: "STT no configurado" }, 501);
      if (response.status === 413)
        return fail(c, "PAYLOAD_TOO_LARGE", "Audio too large");
      if (response.status === 400)
        return fail(c, "BAD_REQUEST", "Invalid audio upload");
      if (response.status >= 500)
        return fail(c, "VOICE_PROVIDER_ERROR", "Voice provider failed");
      if (!response.ok)
        return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");

      const body = (await response.json().catch(() => undefined)) as
        | { text?: unknown }
        | undefined;
      if (typeof body?.text !== "string")
        return fail(c, "INTERNAL_ERROR", "Invalid transcription response");
      return c.json({ text: body.text });
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
  });

  // --- §4.6 Subida de ficheros ---

  app.post("/agents/:name/uploads", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    // Igual que sesiones: resolver el Agent antes de consumir el multipart.
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    let estado: AgentStatus;
    try {
      estado = await supervisor.statusOf(config);
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
    if (estado.state !== "running")
      return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(
        `http://127.0.0.1:${estado.port}/api/upload`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.apiToken}`,
            ...(c.req.header("content-type")
              ? { "content-type": c.req.header("content-type")! }
              : {}),
          },
          body: c.req.raw.body,
          duplex: "half",
        } as RequestInit,
      );

      // Codigo propio: el caller necesita distinguir "pasa del limite" de
      // "la peticion es invalida" para poder decirselo al usuario, y el
      // mensaje no es contrato — el catalogo cerrado si.
      if (response.status === 413)
        return fail(c, "PAYLOAD_TOO_LARGE", "File too large");
      if (response.status === 400)
        return fail(c, "BAD_REQUEST", "Invalid upload");
      if (!response.ok)
        return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");

      const upload = toUploadV1(await response.json().catch(() => undefined));
      if (!upload) return fail(c, "INTERNAL_ERROR", "Invalid upload response");
      return c.json(upload);
    } catch {
      // El detalle de fetch puede incluir la topología del Runner; el caller
      // solo recibe el código estable del catálogo.
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
  });

  // --- §4.5 Turnos ---

  app.post("/agents/:name/turns", async (c) => {
    const requestedEventProfile = c.req.query("eventProfile");
    if (
      requestedEventProfile !== undefined &&
      !["basic", "verbose"].includes(requestedEventProfile)
    ) {
      return fail(c, "BAD_REQUEST", "eventProfile must be basic or verbose");
    }
    const eventProfile = (requestedEventProfile ?? "basic") as TurnEventProfile;

    // El body se valida PRIMERO: turnId/idempotencyKey/correlationId son
    // obligatorios (H01.04) y su ausencia es 400 aunque el agente tampoco
    // exista — así lo fija el contract test de §4.5.
    const parsed = createTurnV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return fail(
        c,
        "BAD_REQUEST",
        "turnId, idempotencyKey and correlationId are required",
      );
    }

    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const { turnId, idempotencyKey, message } = parsed.data;

    // Idempotencia (spec §5): un reintento con la MISMA key no ejecuta
    // otra vez — devuelve el turno original y punto. Es lo que permite
    // al dashboard reintentar tras un corte de red sin duplicar la
    // ejecución.
    const yaVisto = isDuplicateTurn(turnosVistos, idempotencyKey);
    if (yaVisto !== undefined) {
      return c.json({ turnId: yaVisto, duplicate: true });
    }

    const estado = await supervisor.statusOf(config);
    if (estado.state !== "running") {
      return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");
    }

    // Admisión (T4a, S2): `startTurn` reserva el turno del Agent de forma
    // SÍNCRONA antes de crear el socket del Runner. Si el Agent ya tiene un
    // turno vivo —de la web, de Telegram o de una Initiative— esta ruta
    // responde `409 TURN_IN_PROGRESS` en JSON **antes** de abrir el SSE: un
    // 200 con un stream que nunca ejecuta mentiría sobre lo que ha pasado.
    //
    // Los eventos pueden llegar antes de que exista el stream, así que se
    // encolan y se vuelcan en orden en cuanto `streamSSE` arranca (el puente
    // entrega un evento solo cuando el anterior se entregó, así que el orden
    // del volcado y el de los eventos posteriores no se cruzan).
    const pendientes: Array<{ evento: TurnSseEvent; liberar: () => void }> = [];
    let escribir: ((evento: TurnSseEvent) => Promise<void>) | undefined;
    const entregar = (evento: TurnSseEvent): Promise<void> => {
      if (escribir) return escribir(evento);
      return new Promise<void>((liberar) => pendientes.push({ evento, liberar }));
    };

    // Puente WebSocket → SSE (Fase 3.1): el puente WS→eventos→terminal vive
    // en `TurnExecution` (compartido con el Loop); esta ruta es un adaptador
    // fino que traduce los eventos a SSE. El Runner solo acepta prompts por
    // WS (`/ws`), y la spec §7 prohíbe exponer WebSockets al dashboard: el
    // Manager traduce. El puerto del Runner NUNCA sale de aquí.
    let handle: TurnHandle;
    try {
      handle = turns.startTurn({
        agentName: name,
        turnId,
        idempotencyKey,
        correlationId: parsed.data.correlationId,
        sessionKey: parsed.data.sessionKey,
        message,
        runnerPort: estado.port,
        eventProfile,
        origin: { kind: "human" },
        onEvent: entregar,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === "TURN_IN_PROGRESS") {
        return fail(c, "TURN_IN_PROGRESS", "Agent already has a live turn");
      }
      throw error;
    }

    // La key se recuerda SOLO cuando el turno está aceptado. Recordarla antes
    // de la admisión envenenaba el reintento: el caller recibía
    // `{duplicate:true}` de un turno que nunca ejecutó. Un turno aceptado
    // conserva exactamente su semántica idempotente de la spec §5.
    rememberTurn(turnosVistos, idempotencyKey, turnId);

    return streamSSE(c, async (stream) => {
      const enviar = (evento: TurnSseEvent) =>
        stream.writeSSE({
          event: evento.event,
          data: JSON.stringify(evento.data),
        });

      escribir = enviar;
      for (const { evento, liberar } of pendientes.splice(0)) {
        await enviar(evento);
        liberar();
      }

      // Si el cliente se va, se corta el turno: mantener el WS abierto
      // contra un Runner que sigue generando sería una fuga. El cliente ya
      // no puede recibir un terminal, así que este camino no escribe SSE. La
      // admisión se libera con el terminal que produce ese corte, nunca por
      // el corte en sí.
      stream.onAbort(() => handle.disconnect());
      await handle.completion;
    });
  });

  /**
   * Aborta un turno en curso (bug 3). `abortSignal`/`X-Abort` de la spec
   * §6 se quedan sin implementar a propósito: piden abortar en la MISMA
   * llamada que crea un turno, y no hay forma coherente de abortar algo
   * que aún no existe — la ruta dedicada, con el `turnId` que el caller ya
   * conoce por ser suyo, es la única forma real. Documentado en la spec
   * como deprecado.
   */
  app.post("/agents/:name/turns/:turnId/abort", async (c) => {
    const name = c.req.param("name");
    const turnId = c.req.param("turnId");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    // El abort vive en `TurnExecution` (Fase 3.1), contra el registro
    // compartido de turnos vivos.
    if (!turns.abort(name, turnId)) {
      return fail(c, "TURN_NOT_FOUND", "Turn not found or already finished");
    }
    return c.body(null, 202);
  });

  return app;
}

/**
 * JSON sirve Markdown y ficheros de texto; multipart transporta un ZIP con
 * `skillId` y `archive`. Ambos convergen en ficheros relativos a la raíz de
 * la Skill. Nunca se acepta un source/path que el caller pueda reutilizar.
 */
async function skillContentOf(
  c: Context<ApiV1Env>,
): Promise<
  | {
      skillId: string;
      files: Array<{ path: string; content: string | Buffer }>;
    }
  | undefined
> {
  try {
    if (
      c.req
        .header("content-type")
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    ) {
      const form = await c.req.formData();
      const skillId = form.get("skillId");
      const archive = form.get("archive");
      if (
        typeof skillId !== "string" ||
        !isValidSkillId(skillId) ||
        !(archive instanceof File)
      )
        return undefined;
      // El límite comprimido evita aceptar un body arbitrario; filesFromSkillZip
      // verifica además cada tamaño *descomprimido* antes de extraerlo.
      if (archive.size > 20 * 1024 * 1024) return undefined;
      return {
        skillId,
        files: filesFromSkillZip(Buffer.from(await archive.arrayBuffer())),
      };
    }

    const parsed = skillContentV1Schema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface UploadV1Response {
  path: string;
  name: string;
  size: number;
  type: string;
}

/** Solo se permite el path que el Runner devuelve relativo al workspace. */
function toUploadV1(value: unknown): UploadV1Response | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const body = value as Record<string, unknown>;
  if (
    !isWorkspaceRelativeUploadPath(body.path) ||
    typeof body.name !== "string" ||
    typeof body.size !== "number" ||
    !Number.isSafeInteger(body.size) ||
    body.size < 0 ||
    typeof body.type !== "string"
  ) {
    return undefined;
  }
  return {
    path: body.path,
    name: body.name,
    size: body.size,
    type: body.type,
  };
}

function isWorkspaceRelativeUploadPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("uploads/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  return value
    .split("/")
    .slice(1)
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

/**
 * Snapshot de todo lo que el Runner de `config.name` lee al arrancar, para
 * calcular su huella (`restart-policy.ts`). `env`/`packages` se leen del
 * disco en cada llamada a propósito: no cachear evita decidir sobre un
 * valor obsoleto si algo los cambió por otra vía entre medias.
 */
async function snapshotRuntimeInput(
  env: PihubEnv,
  config: Pick<
    AgentConfig,
    "name" | "model" | "thinkingLevel" | "ttsVoice" | "memory"
  >,
) {
  const [systemPrompt, envStore, packages, channels] = await Promise.all([
    readSystemPrompt(env, config.name),
    readEnvStore(env.dataDir, config.name),
    listPackages(env, config.name),
    readChannelRecords(env.dataDir, config.name),
  ]);
  return {
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    ttsVoice: config.ttsVoice,
    memory: config.memory,
    systemPrompt,
    env: envStore,
    packages,
    channels,
  };
}

/**
 * Ventana de deprecación del cutover (R3/R10): `telegramToken` sigue
 * aceptándose en el body para que un Dashboard que aún lo mande no reciba un 400
 * en medio de un reconcile, pero YA NO ESCRIBE NADA: el sink (`agents.ts`) lo
 * ignora y la huella no lo ve. El aviso por log es lo que queda de ese campo.
 */
function warnLegacyTelegramToken(route: string, data: unknown): void {
  if (typeof data !== "object" || data === null || !("telegramToken" in data)) return;
  console.warn(
    `[pihub] ${route}: telegramToken es legado y se ignora; el canal de Telegram ` +
      `se configura con PUT /api/v1/agents/<name>/channels`,
  );
}

/** Aplica la decisión de `decideRuntimeAction` sobre el proceso del Runner. */
async function aplicarRuntimeAction(
  supervisor: Supervisor,
  name: string,
  action: RuntimeAction,
): Promise<void> {
  if (action === "start") await supervisor.start(name);
  else if (action === "stop") await supervisor.stop(name);
  else if (action === "restart") await supervisor.restart(name);
}

/**
 * Proyección pública de un Agent para `/api/v1`. `statusOf` devuelve el
 * `AgentStatus` completo, que incluye el puerto del Runner (4100-4199) y
 * el pid del proceso; la spec §7 prohíbe explícitamente exponer ambos (el
 * ejemplo de §4.3 que muestra `ports.runner` se contradice con su propia
 * §7 — gana la prohibición, que es además lo que asierta
 * `assertNoInternalsLeaked`). Se filtran aquí, el único punto que
 * serializa un Agent hacia el dashboard.
 */
function toAgentV1(status: AgentStatus): Omit<AgentStatus, "port" | "pid"> & {
  status: string;
} {
  const { port: _port, pid: _pid, ...safe } = status;
  // La spec §4.3 nombra el campo `status`; el modelo interno lo llama
  // `state`. Se exponen los dos: `status` es el contrato con el
  // dashboard, `state` se conserva para no romper a ningún consumidor
  // que ya lo leyera. Encontrado con el test de integración del adapter,
  // que recibía siempre `stopped` porque `status` no existía.
  return { ...safe, status: safe.state };
}

/** Recarga diferida tras una operación atómica del panel. */
function scheduleAgentReload(supervisor: Supervisor, name: string): void {
  setTimeout(() => {
    void supervisor.restart(name).catch(() => {});
  }, 500);
}

/** El store global afecta a todos los Runners; se recarga sin bloquear el PUT. */
function scheduleGlobalReload(supervisor: Supervisor): void {
  setTimeout(() => {
    void supervisor.restartAllRunning().catch(() => {});
  }, 500);
}

    /** Helper compartido por las rutas: traduce un código a su respuesta. */
    export function fail(
      c: Context<ApiV1Env>,
      code: ApiErrorCode,
      message: string,
    ) {
      return c.json(
        apiError(code, message, c.get("correlationId")),
        HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
      );
    }
    
    /**
     * `:kind` de la ruta de canales. An unknown transport is a BAD_REQUEST, not a
     * 404: the Agent exists and the channel does not — the difference the
     * Dashboard has to be able to tell apart when it projects a kind this build
     * does not ship.
     */
        function channelKindOfRoute(raw: string | undefined): ChannelKind | undefined {
          return isChannelKind(raw) ? raw : undefined;
        }
    
        /**
         * Cursor del feed: entero ≥ 0 o `undefined`. Un `after` ilegible se rechaza
         * en la ruta en vez de caer a 0 — caer a 0 re-dreanaría al Dashboard todo
         * un historial ya proyectado, y el coste de ese error es silencio.
         */
        function feedCursorOf(raw: string | undefined): number | undefined {
          if (raw === undefined || raw === "") return 0;
          if (!/^\d+$/.test(raw)) return undefined;
          const value = Number(raw);
          return Number.isSafeInteger(value) ? value : undefined;
        }
    
        /** Página acotada: el techo de `exchange-log.ts`, ni una consulta volcona. */
        function feedLimitOf(raw: string | undefined): number {
          const requested = raw === undefined || raw === "" ? NaN : Number(raw);
          const base = Number.isFinite(requested)
            ? Math.trunc(requested)
            : EXCHANGE_FEED_DEFAULT_LIMIT;
          return Math.min(Math.max(base, 1), EXCHANGE_FEED_MAX_LIMIT);
        }
    
        /**
         * Fila del espejo tal y como la consume D: el cursor (`seq`), el origen que
         * la superficie web tiene que pintar, el par de textos de siempre y —desde
         * T5a (schema v6)— la mitad DURABLE de cada lado con su señal `hasFull`.
         * Sin `agentName` repetido por fila (ya qualifica la respuesta) y sin
         * ningún secreto: el espejo no guarda tokens ni credenciales, solo lo que
         * el humano escribió y lo que el Agent respondió.
         *
         * `userText`/`replyText` son el preview que D ya pintaba: para una fila
         * legacy son lo ÚNICO que existe (`hasFull: false`), y para una fila nueva
         * siguen ahí sin cambiar de semántica. `userFullText`/`replyFullText` son
         * las mitades completas (acotadas al techo documentado
         * `CHANNEL_FULL_TEXT_MAX_CHARS`) y valen `null` en una fila anterior a v6:
         * el feed dice la verdad sobre lo que no tiene, no rellena el hueco.
         */
        function exchangeView(row: ChannelExchange) {
          return {
            seq: row.seq,
            turnId: row.turnId,
            origin: row.origin,
            chatId: row.chatId,
            userText: row.userText,
            replyText: row.replyText,
            userFullText: row.userFullText,
            replyFullText: row.replyFullText,
            hasFull: row.hasFull,
            createdAt: row.createdAt,
          };
        }
    
    /**
     * Public view of the pairing machine. `state` is the BINDING (which chat the
     * bot serves); `observedStatus` on the channel record stays the transport
     * health — the two never overwrite each other (invariant I3). Pending chats
     * are listed without their hashes: the Dashboard shows who is waiting, and
     * the code is only ever known by the chat that asked for it.
     */
    function pairingView(pairing: ChannelPairing) {
      return {
        kind: pairing.kind,
        state: pairing.state,
        externalChatId: pairing.externalChatId,
        pairedAt: pairing.pairedAt,
        pendingChatIds: pairing.pending.map((row) => row.externalChatId),
      };
    }
    
    /**
     * Superficie OBSERVADA de los canales de un Agent para el describe
     * (`GET /agents/:name`, tasks c-I12). El Dashboard reconcilia contra UNA sola
     * lectura, así que las filas de canales viajan aquí — pero solo la lista
     * blanca observada:
     *
     * - `pairingState` / `externalChatId`: el VÍNCULO, hecho de la máquina de
     *   pairing (`channels.json` no lo sabe: allí no se persiste a quién sirve
     *   el bot).
     * - `observedStatus` / `lastError` / `lastSeenAt`: la SALUD del transporte,
     *   hecha del registro. Dos hechos distintos que nunca se sobrescriben (I3).
     *
     * Todo lo que pueda cargar un secreto (`token`, `tokenDigest`, el hash del
     * código) y todo lo que es estado DESEADO (`label`, `updatedAt`) queda fuera:
     * eso es de `GET …/channels`. Un describe nunca es la vía para leer una
     * huella por fuera del Manager.
     */
    async function observedChannels(
      dataDir: string,
      pairing: PairingMachine,
      name: string,
    ) {
      const records = await readChannelRecords(dataDir, name);
      return Promise.all(
        records.map(async (record) => {
          const binding = await pairing.stateOf(name, record.kind);
          return {
            kind: record.kind,
            pairingState: binding?.state ?? "unpaired",
            externalChatId: binding?.externalChatId ?? null,
            observedStatus: record.observedStatus,
            lastError: record.lastError ?? null,
            lastSeenAt: record.lastSeenAt ?? null,
          };
        }),
      );
    }
    
    /**
     * A `PairingError` carries an `ApiErrorCode` verbatim — one closed catalogue,
     * so the machine never needs to know HTTP. Anything else is an internal
     * failure: logged with the correlation id, never described to the caller.
     */
    function pairingFailure(
      c: Context<ApiV1Env>,
      error: unknown,
      what: string,
    ) {
      if (error instanceof PairingError) {
        return fail(c, error.code, error.message);
      }
      console.error(`[api-v1] fallo en ${what}:`, c.get("correlationId"), error);
      return fail(c, "INTERNAL_ERROR", "Could not process the pairing request");
    }
