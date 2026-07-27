import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { listAgents, type PihubEnv } from "@pihub/shared";
import type { Supervisor } from "../supervisor.js";
import { apiError, HTTP_STATUS_BY_CODE, type ApiErrorCode } from "./errors.js";
import { classifyServiceAuth } from "./auth.js";

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
export function createApiV1Router(env: PihubEnv, _supervisor: Supervisor): Hono<ApiV1Env> {
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

  return app;
}

/** Helper compartido por las rutas: traduce un código a su respuesta. */
export function fail(c: Context<ApiV1Env>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}
