import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { listAgents, readAgent, type AgentStatus, type PihubEnv } from "@pihub/shared";
import { createAgent, deleteAgent } from "../agents.js";
import type { Supervisor } from "../supervisor.js";
import { apiError, HTTP_STATUS_BY_CODE, type ApiErrorCode } from "./errors.js";
import { classifyServiceAuth } from "./auth.js";
import { createAgentV1Schema, createSessionV1Schema, createTurnV1Schema } from "./schemas.js";

const MANAGER_VERSION = "0.1.0";

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
export function createApiV1Router(env: PihubEnv, supervisor: Supervisor): Hono<ApiV1Env> {
  const app = new Hono<ApiV1Env>();

  app.use("*", async (c, next) => {
    c.set("correlationId", correlationIdOf(c));
    await next();
  });

  // Auth de servicio: `/api/v1` es servicio-a-servicio y la cookie del
  // panel NO vale aquí (ver api-v1/auth.ts).
  app.use("*", async (c, next) => {
    const verdict = classifyServiceAuth(c.req.header("authorization"), env.apiToken);
    if (verdict !== "ok") {
      return fail(c, verdict, "Service credential required");
    }
    await next();
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

  app.delete("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");
    await supervisor.stop(name);
    await deleteAgent(env, name);
    return c.body(null, 204);
  });

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

    // El turno real (streaming SSE contra el Runner) es H01.04 completo y
    // no está implementado todavía. Se declara indisponible en vez de
    // devolver un turno falso que parezca funcionar.
    return fail(c, "RESOURCE_UNAVAILABLE", "Turn execution not implemented yet");
  });

  return app;
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
function toAgentV1(status: AgentStatus): Omit<AgentStatus, "port" | "pid"> {
  const { port: _port, pid: _pid, ...safe } = status;
  return safe;
}

/** Helper compartido por las rutas: traduce un código a su respuesta. */
export function fail(c: Context<ApiV1Env>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}
