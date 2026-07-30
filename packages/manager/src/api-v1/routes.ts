import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import WebSocket from "ws";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import {
  agentPaths,
  isProtectedEnvKey,
  isValidEnvKey,
  listAgents,
  listEnvKeys,
  piInstall,
  piRemove,
  piVersion,
  readAgent,
  readEnvStore,
  replaceEnvStore,
  setEnv,
  unsetEnv,
  type AgentConfig,
  type AgentStatus,
  type PihubEnv,
} from "@pihub/shared";
import { createAgent, deleteAgent, listPackages, readSystemPrompt, updateAgent } from "../agents.js";
import { listModels } from "../models.js";
import type { Supervisor } from "../supervisor.js";
import type { OAuthService } from "../oauth.js";
import { apiError, HTTP_STATUS_BY_CODE, type ApiErrorCode } from "./errors.js";
import { classifyApiV1Auth, cookieValue, CSRF_COOKIE } from "./auth.js";
import {
  agentRuntimeFingerprint,
  decideRuntimeAction,
  hasLiveTurnForAgent,
  projectSystemPrompt,
  projectUpdatedAgent,
  type RuntimeAction,
} from "./restart-policy.js";
import { isDuplicateTurn, rememberTurn, toTurnEvent } from "./turns.js";
import { diffPackages } from "./package-sync.js";
import {
  createAgentV1Schema,
  createSessionV1Schema,
  createTurnV1Schema,
  packageItemV1Schema,
  replaceEnvV1Schema,
  replacePackagesV1Schema,
  setEnvValueV1Schema,
  updateAgentV1Schema,
} from "./schemas.js";

const MANAGER_VERSION = "0.6.0";

/** Variables de contexto de `/api/v1`. El correlationId viaja en toda respuesta de error. */
export type ApiV1Env = { Variables: { correlationId: string } };

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
 * Interfaz privada versionada del Manager (H01.01). Es la ÚNICA
 * frontera con el dashboard: se consume por HTTP contra la imagen
 * publicada, nunca importando código. Convive con las rutas `/api/*`
 * del panel, que no se tocan.
 */
export function createApiV1Router(
  env: PihubEnv,
  supervisor: Supervisor,
  oauth: OAuthService,
): Hono<ApiV1Env> {
  const app = new Hono<ApiV1Env>();
  /** Idempotencia de turnos por instancia del Manager (spec §5). */
  const turnosVistos = new Map<string, string>();
  /**
   * Turnos con WS abierto contra el Runner, por instancia del Manager.
   * Clave `agent:turnId` — el turnId lo genera el caller, pero se
   * cualifica por Agent para no depender de que sea único a nivel global.
   * Es lo que permite `POST .../turns/:turnId/abort` (bug 3) y que el
   * PATCH rechace con `TURN_IN_PROGRESS` en vez de reiniciar un turno vivo.
   */
  const turnosVivos = new Map<string, WebSocket>();
  const claveTurno = (name: string, turnId: string) => `${name}:${turnId}`;
  const hayTurnoVivo = (name: string) => hasLiveTurnForAgent(turnosVivos.keys(), name);

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
      const code = c.req.header("x-csrf-token") && csrfCookie ? "CSRF_INVALID" : "CSRF_REQUIRED";
      return fail(c, code, code === "CSRF_REQUIRED" ? "CSRF token required" : "CSRF token invalid");
    }
    await next();
  });

  // Panel/operator extension: OAuth de providers. Estas rutas comparten el
  // OAuthService del Manager, pero no forman parte de la Interface del
  // dashboard/control plane.
  app.get("/auth/providers", (c) => c.json({ providers: oauth.providers() }));

  app.post("/auth/login/:provider", (c) => {
    try {
      return c.json(oauth.startLogin(c.req.param("provider")));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/auth/flows/:id", (c) => {
    const flow = oauth.getFlow(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "No existe" }, 404);
  });

  app.post("/auth/flows/:id/input", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    try {
      return c.json(oauth.submitInput(c.req.param("id"), body.value ?? ""));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/auth/logout/:provider", (c) => {
    oauth.logout(c.req.param("provider"));
    return c.json({ ok: true });
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", version: MANAGER_VERSION, timestamp: new Date().toISOString() }),
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
      return fail(c, "BAD_REQUEST", "oldToken and newToken (min 32 chars) are required");
    }
    if (body.oldToken !== env.apiToken) return fail(c, "INVALID_AUTH", "Old token does not match");
    // La rotación efectiva exige reiniciar el Manager con el nuevo valor en
    // el entorno: aceptar el cambio en memoria daría una falsa sensación de
    // haber rotado y se perdería al reiniciar.
    return fail(c, "RESOURCE_UNAVAILABLE", "Rotation requires a Manager restart with the new token");
  });

  // --- §4.7 Modelos disponibles (solo lectura, Fase 1 §1.3 del plan) ---

  app.get("/models", (c) => {
    try {
      return c.json({ models: listModels(env) });
    } catch {
      return c.json({ models: [] });
    }
  });

  // --- §4.8 Estado global (Fase 1 §1.3 del plan) ---
  //
  // Sin `portRange`: la spec §7 prohíbe exponer topología interna de
  // puertos al dashboard (el puerto del Runner nunca sale de aquí, igual
  // que en `toAgentV1`).
  app.get("/status", async (c) => {
    const agents = await listAgents(env.dataDir);
    return c.json({
      version: MANAGER_VERSION,
      pi: await piVersion(env.dataDir),
      agents: agents.length,
      panel: env.panelEnabled,
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
    if (status.state !== "running") return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/api/commands`, {
        headers: { authorization: `Bearer ${env.apiToken}` },
      });
      if (!response.ok) return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
      const body = (await response.json().catch(() => undefined)) as {
        skills?: unknown;
        prompts?: unknown;
      } | undefined;
      if (!Array.isArray(body?.skills) || !Array.isArray(body?.prompts)) {
        return fail(c, "RESOURCE_UNAVAILABLE", "Runner returned an invalid command catalog");
      }
      return c.json({ skills: body.skills, prompts: body.prompts });
    } catch {
      return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");
    }
  });

  // --- §4.3 Agents ---

  app.get("/agents", async (c) => {
    const agents = await listAgents(env.dataDir);
    const statuses = await Promise.all(agents.map((agent) => supervisor.statusOf(agent)));
    return c.json(statuses.map(toAgentV1));
  });

  app.post("/agents", async (c) => {
    const parsed = createAgentV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid agent payload");
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

    const [status, systemPrompt, envKeys, packages] = await Promise.all([
      supervisor.statusOf(config),
      readSystemPrompt(env, name),
      listEnvKeys(env.dataDir, name),
      listPackages(env, name),
    ]);

    return c.json({ ...toAgentV1(status), systemPrompt, envKeys, packages });
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
  app.patch("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = updateAgentV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid agent payload");

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
        telegramToken: proyectado.telegramToken,
        ttsVoice: proyectado.ttsVoice,
        memory: proyectado.memory,
        systemPrompt: projectSystemPrompt(antes.systemPrompt, parsed.data),
      };

      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: proyectado.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !== agentRuntimeFingerprint(despuesProyectado),
      });

      // Reiniciar o parar tumbaría el WS del turno en curso (spec de bug 1:
      // "reiniciar mata turnos vivos"). Se rechaza ANTES de escribir nada:
      // el caller puede reintentar cuando el turno termine, o abortarlo
      // primero con POST .../turns/:turnId/abort si de verdad quiere forzarlo.
      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
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

    const parsed = replaceEnvV1Schema.safeParse(await c.req.json().catch(() => ({})));
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
          agentRuntimeFingerprint(antes) !== agentRuntimeFingerprint(despuesProyectado),
      });

      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
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
    if (!isValidEnvKey(key) || isProtectedEnvKey(key)) return fail(c, "BAD_REQUEST", "Invalid env key");

    const parsed = setEnvValueV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid env payload");

    try {
      const wasRunning = supervisor.state(name).state === "running";
      const antes = await snapshotRuntimeInput(env, config);
      const despuesProyectado = { ...antes, env: { ...antes.env, [key]: parsed.data.value } };
      const action = decideRuntimeAction({
        wasRunning,
        wasEnabled: config.enabled,
        isEnabled: config.enabled,
        fingerprintChanged:
          agentRuntimeFingerprint(antes) !== agentRuntimeFingerprint(despuesProyectado),
      });
      if ((action === "restart" || action === "stop") && hayTurnoVivo(name)) {
        return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
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
    if (!isValidEnvKey(key) || isProtectedEnvKey(key)) return fail(c, "BAD_REQUEST", "Invalid env key");

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
        return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
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
  app.get("/env", async (c) => c.json({ keys: await listEnvKeys(env.dataDir) }));

  app.put("/env/:key", async (c) => {
    const key = c.req.param("key");
    if (!isValidEnvKey(key) || isProtectedEnvKey(key)) return fail(c, "BAD_REQUEST", "Invalid env key");
    const parsed = setEnvValueV1Schema.safeParse(await c.req.json().catch(() => ({})));
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
    if (!isValidEnvKey(key) || isProtectedEnvKey(key)) return fail(c, "BAD_REQUEST", "Invalid env key");

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

    const parsed = replacePackagesV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid packages payload");

    const actuales = await listPackages(env, name);
    const { toInstall, toRemove } = diffPackages(actuales, parsed.data.packages);

    // Sin diferencia: no hay nada que instalar/quitar ni Runner que
    // reiniciar. Responde ya, sin tocar pi ni el registro de turnos.
    if (toInstall.length === 0 && toRemove.length === 0) {
      return c.json({ packages: actuales }, 202);
    }

    const wasRunning = supervisor.state(name).state === "running";
    // Instalar/quitar un paquete solo tiene efecto si el Runner se reinicia
    // para recogerlo — mismo riesgo que el PATCH: no tumbar un turno vivo.
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
    }

    const workspaceDir = agentPaths(env.dataDir, name).workspaceDir;
    for (const source of toInstall) {
      const result = await piInstall(env.dataDir, source, workspaceDir);
      if (!result.ok) return fail(c, "BAD_REQUEST", "Could not install package");
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
    const parsed = packageItemV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env, name);
    if (actuales.includes(parsed.data.source)) return c.json({ packages: actuales }, 202);

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
    }

    const result = await piInstall(env.dataDir, parsed.data.source, agentPaths(env.dataDir, name).workspaceDir);
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not install package");
    scheduleAgentReload(supervisor, name);
    return c.json({ packages: await listPackages(env, name) }, 202);
  });

  app.delete("/agents/:name/packages", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    const parsed = packageItemV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env, name);
    if (!actuales.includes(parsed.data.source)) return c.json({ packages: actuales }, 202);

    const wasRunning = supervisor.state(name).state === "running";
    if (wasRunning && hayTurnoVivo(name)) {
      return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
    }

    const result = await piRemove(env.dataDir, parsed.data.source, agentPaths(env.dataDir, name).workspaceDir);
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not remove package");
    scheduleAgentReload(supervisor, name);
    return c.json({ packages: await listPackages(env, name) }, 202);
  });

  app.get("/packages", async (c) => c.json({ packages: await listPackages(env) }));

  app.post("/packages", async (c) => {
    const parsed = packageItemV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env);
    if (actuales.includes(parsed.data.source)) return c.json({ packages: actuales }, 202);
    const result = await piInstall(env.dataDir, parsed.data.source);
    if (!result.ok) return fail(c, "BAD_REQUEST", "Could not install package");
    scheduleGlobalReload(supervisor);
    return c.json({ packages: await listPackages(env) }, 202);
  });

  app.delete("/packages", async (c) => {
    const parsed = packageItemV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid package payload");

    const actuales = await listPackages(env);
    if (!actuales.includes(parsed.data.source)) return c.json({ packages: actuales }, 202);
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
        return fail(c, "TURN_IN_PROGRESS", "Agent has a turn in progress; retry after it finishes");
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

  // --- §4.4 Sesiones ---

  app.post("/agents/:name/sessions", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    // El 404 va ANTES de validar el body: un agente inexistente no debe
    // revelar si el payload era válido.
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = createSessionV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid session payload");

    return c.json(
      {
        key: parsed.data.sessionKey,
        channel: parsed.data.channel,
        agent: name,
        createdAt: new Date().toISOString(),
      },
      201,
    );
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
    if (status.state !== "running") return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/api/transcribe`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.apiToken}`,
          ...(c.req.header("content-type") ? { "content-type": c.req.header("content-type")! } : {}),
        },
        body: c.req.raw.body,
        duplex: "half",
      } as RequestInit);

      if (response.status === 501) return c.json({ error: "STT no configurado" }, 501);
      if (response.status === 413) return fail(c, "PAYLOAD_TOO_LARGE", "Audio too large");
      if (response.status === 400) return fail(c, "BAD_REQUEST", "Invalid audio upload");
      if (response.status >= 500) return fail(c, "VOICE_PROVIDER_ERROR", "Voice provider failed");
      if (!response.ok) return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");

      const body = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
      if (typeof body?.text !== "string") return fail(c, "INTERNAL_ERROR", "Invalid transcription response");
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
    if (estado.state !== "running") return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");

    try {
      const response = await fetch(`http://127.0.0.1:${estado.port}/api/upload`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.apiToken}`,
          ...(c.req.header("content-type") ? { "content-type": c.req.header("content-type")! } : {}),
        },
        body: c.req.raw.body,
        duplex: "half",
      } as RequestInit);

      // Codigo propio: el caller necesita distinguir "pasa del limite" de
      // "la peticion es invalida" para poder decirselo al usuario, y el
      // mensaje no es contrato — el catalogo cerrado si.
      if (response.status === 413) return fail(c, "PAYLOAD_TOO_LARGE", "File too large");
      if (response.status === 400) return fail(c, "BAD_REQUEST", "Invalid upload");
      if (!response.ok) return fail(c, "RESOURCE_UNAVAILABLE", "Runner unavailable");

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
    // El body se valida PRIMERO: turnId/idempotencyKey/correlationId son
    // obligatorios (H01.04) y su ausencia es 400 aunque el agente tampoco
    // exista — así lo fija el contract test de §4.5.
    const parsed = createTurnV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return fail(c, "BAD_REQUEST", "turnId, idempotencyKey and correlationId are required");
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
    rememberTurn(turnosVistos, idempotencyKey, turnId);

    const estado = await supervisor.statusOf(config);
    if (estado.state !== "running") {
      return fail(c, "RESOURCE_UNAVAILABLE", "Agent is not running");
    }

    // Puente WebSocket → SSE. El Runner solo acepta prompts por WS
    // (`/ws`), y la spec §7 prohíbe exponer WebSockets al dashboard: el
    // Manager traduce. El puerto del Runner NUNCA sale de aquí.
    return streamSSE(c, async (stream) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${estado.port}/ws?sessionKey=${encodeURIComponent(parsed.data.sessionKey)}`,
        { headers: { authorization: `Bearer ${env.apiToken}` } },
      );

      const clave = claveTurno(name, turnId);
      await new Promise<void>((resolve) => {
        let cerrado = false;
        const cerrar = () => {
          if (cerrado) return;
          cerrado = true;
          turnosVivos.delete(clave);
          try {
            ws.close();
          } catch {
            // El socket ya podía estar cerrado; da igual.
          }
          resolve();
        };

        // Si el cliente se va, se corta el turno: mantener el WS abierto
        // contra un Runner que sigue generando sería una fuga.
        stream.onAbort(cerrar);

        ws.on("open", () => {
          // Registrado solo tras `open`: mandar `{type:"abort"}` antes de
          // que el WS esté realmente conectado no es seguro.
          turnosVivos.set(clave, ws);
          ws.send(JSON.stringify({ type: "prompt", text: message }));
        });

        // Las escrituras se ENCADENAN: `writeSSE` es asíncrona y los
        // mensajes del WS llegan en ráfaga. Sin esta cadena, el evento
        // terminal cerraba el stream antes de que su propia escritura se
        // vaciara y `turn-complete` NO llegaba nunca al cliente —
        // encontrado con un turno real, no en los tests unitarios.
        let escrituras: Promise<void> = Promise.resolve();
        const emitir = (evento: { event: string; data: Record<string, unknown> }) => {
          escrituras = escrituras.then(() =>
            stream.writeSSE({ event: evento.event, data: JSON.stringify(evento.data) }),
          );
          return escrituras;
        };

        ws.on("message", (raw: unknown) => {
          let mensaje: { type: string; delta?: string; message?: string };
          try {
            mensaje = JSON.parse(String(raw)) as typeof mensaje;
          } catch {
            return;
          }
          const evento = toTurnEvent(mensaje, turnId);
          if (!evento) return;

          const escrito = emitir(evento);
          // `agent_end` y `error` son terminales: se cierra DESPUÉS de
          // que el evento haya salido de verdad.
          if (evento.event === "turn-complete" || evento.event === "turn-error") {
            void escrito.then(cerrar, cerrar);
          }
        });

        ws.on("error", () => {
          void emitir({
            event: "turn-error",
            data: {
              turnId,
              code: "RESOURCE_UNAVAILABLE",
              message: "Runner unavailable",
            },
          }).then(cerrar, cerrar);
        });

        ws.on("close", cerrar);
      });
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

    const ws = turnosVivos.get(claveTurno(name, turnId));
    if (!ws) return fail(c, "TURN_NOT_FOUND", "Turn not found or already finished");

    ws.send(JSON.stringify({ type: "abort" }));
    return c.body(null, 202);
  });

  return app;
}

interface UploadV1Response {
  path: string;
  name: string;
  size: number;
  type: string;
}

/** Solo se permite el path que el Runner devuelve relativo al workspace. */
function toUploadV1(value: unknown): UploadV1Response | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
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
  if (typeof value !== "string" || !value.startsWith("uploads/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  return value
    .split("/")
    .slice(1)
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Snapshot de todo lo que el Runner de `config.name` lee al arrancar, para
 * calcular su huella (`restart-policy.ts`). `env`/`packages` se leen del
 * disco en cada llamada a propósito: no cachear evita decidir sobre un
 * valor obsoleto si algo los cambió por otra vía entre medias.
 */
async function snapshotRuntimeInput(
  env: PihubEnv,
  config: Pick<AgentConfig, "name" | "model" | "thinkingLevel" | "telegramToken" | "ttsVoice" | "memory">,
) {
  const [systemPrompt, envStore, packages] = await Promise.all([
    readSystemPrompt(env, config.name),
    readEnvStore(env.dataDir, config.name),
    listPackages(env, config.name),
  ]);
  return {
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    telegramToken: config.telegramToken,
    ttsVoice: config.ttsVoice,
    memory: config.memory,
    systemPrompt,
    env: envStore,
    packages,
  };
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
export function fail(c: Context<ApiV1Env>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}
