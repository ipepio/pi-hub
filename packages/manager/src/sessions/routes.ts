import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorCode } from "../api-v1/errors.ts";
import { HTTP_STATUS_BY_CODE, apiError } from "../api-v1/errors.ts";
import { createSessionV1Schema, selectSessionV1Schema } from "../api-v1/schemas.ts";
import {
  SessionCatalogueError,
  type AgentSession,
  type AgentSessionCatalogue,
} from "./catalogue.ts";

/**
 * Superficie HTTP del catálogo de sesiones (T3 del ODD `agent-session-workspace`,
 * spec S3; contrato legacy de `docs/manager-api-v1.md` §8 conservado).
 *
 * Las rutas son DELGADAS a propósito: validar forma, comprobar que el Agent
 * existe, delegar en `AgentSessionCatalogue` y presentar. Toda la decisión
 * (identidad por Agent, idempotencia, adopción legacy, selección por superficie)
 * vive en el catálogo, que es donde se puede probar sin HTTP.
 *
 * Este módulo NO añade autenticación propia: `createApiV1Router` lo registra
 * DENTRO del router que ya lleva el guard dual Bearer/cookie + CSRF, así que las
 * rutas heredan exactamente la misma protección que el resto de `/api/v1`. Se
 * registra con la interfaz estructural `{get, post}` —igual que
 * `registerAutonomyRoutes`— para no acoplarse al tipo `Env` de Hono del router.
 */

/**
 * Variables de contexto que estas rutas leen. El `principal` no se consulta
 * (el guard ya decidió); está en el tipo para que el `Context<ApiV1Env>` del
 * router real encaje sin un cast.
 */
interface SessionEnv {
  Variables: {
    correlationId: string;
    principal: { kind: "service" | "panel" };
  };
}

export interface SessionRouteDeps {
  /**
   * Puerta de propiedad del Agent: la MISMA comprobación que el resto de rutas
   * (`readAgent` sobre el `dataDir`). Un Agent inexistente responde 404 antes de
   * mirar el body, para no revelar si el payload era válido.
   */
  readonly agentExists: (name: string) => Promise<boolean>;
  /**
   * Catálogo durable, o `undefined` si el composition root no compuso almacén. Se
   * lee por request (lector, no copia) porque el router se construye antes de que
   * exista el store en algunos arranques/tests. Ausente = 503 explícito: no hay
   * catálogo que prometer.
   */
  readonly catalogue: () => AgentSessionCatalogue | undefined;
  readonly now: () => number;
}

function fail(c: Context<SessionEnv>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}

/**
 * Vista pública de una sesión. Expone la identidad durable (`id`), la key del
 * Runner (`key`), la superficie de origen, la etiqueta opcional y `legacy` — el
 * dato que permite a la UI decir la verdad sobre una entrada adoptada (S7).
 */
function sessionView(session: AgentSession) {
  return {
    id: session.id,
    key: session.key,
    channel: session.channel,
    agent: session.agentName,
    name: session.name,
    legacy: session.legacy,
    createdAt: new Date(session.createdAt).toISOString(),
  };
}

/**
 * Body JSON tolerante SOLO con la ausencia de body: un POST sin cuerpo crea una
 * sesión con identidad generada, pero un cuerpo mal formado es un 400 y nunca una
 * sesión fantasma (el `catch(() => ({}))` de otras rutas sería justo eso).
 */
async function readJsonBody(
  c: Context<SessionEnv>,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await c.req.text();
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Traduce el error del catálogo: sus códigos YA son del catálogo cerrado de
 * `api-v1/errors.ts`, así que la ruta no traduce nada. Cualquier otra cosa es un
 * fallo interno: se registra con el correlationId y no se describe al caller.
 */
function catalogueFailure(c: Context<SessionEnv>, error: unknown, what: string) {
  if (error instanceof SessionCatalogueError) {
    return fail(c, error.code, error.message);
  }
  console.error(`[api-v1] fallo en ${what}:`, c.get("correlationId"), error);
  return fail(c, "INTERNAL_ERROR", "Could not process the session request");
}

/**
 * Catálogo o el 503 que corresponde a un despliegue sin almacén durable. El
 * llamador comprueba `instanceof Response` y devuelve tal cual: un `undefined`
 * silencioso dejaría la respuesta vacía que este test encontró.
 */
function resolveCatalogue(
  c: Context<SessionEnv>,
  deps: SessionRouteDeps,
): AgentSessionCatalogue | Response {
  const catalogue = deps.catalogue();
  if (catalogue) return catalogue;
  return fail(c, "RESOURCE_UNAVAILABLE", "Session catalogue is not available");
}

/**
 * `:name` de la ruta. El router siempre lo trae, pero el tipo de Hono lo declara
 * opcional: ausente = 400, nunca un agente vacío consultando el almacén.
 */
function agentNameOf(c: Context<SessionEnv>): string | Response {
  const name = c.req.param("name");
  if (!name) return fail(c, "BAD_REQUEST", "Missing agent name");
  return name;
}

async function handleCreateSession(
  c: Context<SessionEnv>,
  deps: SessionRouteDeps,
): Promise<Response> {
  const agentName = agentNameOf(c);
  if (typeof agentName !== "string") return agentName;
  if (!(await deps.agentExists(agentName))) {
    return fail(c, "AGENT_NOT_FOUND", "Agent not found");
  }
  const catalogue = resolveCatalogue(c, deps);
  if (catalogue instanceof Response) return catalogue;

  const body = await readJsonBody(c);
  if (!body.ok) return fail(c, "BAD_REQUEST", "Invalid session payload");
  const parsed = createSessionV1Schema.safeParse(body.value);
  if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid session payload");

  try {
    const session = catalogue.create({
      agentName,
      channel: parsed.data.channel ?? "web",
      sessionKey: parsed.data.sessionKey,
      name: parsed.data.name,
      now: deps.now(),
    });
    // 201 también en el replay idempotente: la fila devuelta es la original (mismo
    // id y mismo createdAt), así que el caller legacy sigue viendo su contrato.
    return c.json(sessionView(session), 201);
  } catch (error) {
    return catalogueFailure(c, error, "crear sesión");
  }
}

async function handleListSessions(
  c: Context<SessionEnv>,
  deps: SessionRouteDeps,
): Promise<Response> {
  const agentName = agentNameOf(c);
  if (typeof agentName !== "string") return agentName;
  if (!(await deps.agentExists(agentName))) {
    return fail(c, "AGENT_NOT_FOUND", "Agent not found");
  }
  const catalogue = resolveCatalogue(c, deps);
  if (catalogue instanceof Response) return catalogue;

  try {
    // Un GET que materializa la entrada legacy la primera vez (ver
    // `sessions/catalogue.ts`): idempotente y probado, no un efecto accidental.
    const snapshot = catalogue.list(agentName, deps.now());
    return c.json({
      agent: agentName,
      sessions: snapshot.sessions.map(sessionView),
      selection: snapshot.selection,
    });
  } catch (error) {
    return catalogueFailure(c, error, "listar sesiones");
  }
}

async function handleSelectSession(
  c: Context<SessionEnv>,
  deps: SessionRouteDeps,
): Promise<Response> {
  const agentName = agentNameOf(c);
  if (typeof agentName !== "string") return agentName;
  if (!(await deps.agentExists(agentName))) {
    return fail(c, "AGENT_NOT_FOUND", "Agent not found");
  }
  const catalogue = resolveCatalogue(c, deps);
  if (catalogue instanceof Response) return catalogue;

  const sessionId = c.req.param("sessionId");
  if (!sessionId) return fail(c, "SESSION_NOT_FOUND", "Session not found");

  const body = await readJsonBody(c);
  if (!body.ok) return fail(c, "BAD_REQUEST", "Invalid session selection payload");
  const parsed = selectSessionV1Schema.safeParse(body.value);
  if (!parsed.success) {
    return fail(c, "BAD_REQUEST", "Invalid session selection payload");
  }

  try {
    const session = catalogue.select({
      agentName,
      channel: parsed.data.channel,
      sessionId,
      now: deps.now(),
    });
    return c.json({
      agent: agentName,
      channel: parsed.data.channel,
      session: sessionView(session),
    });
  } catch (error) {
    return catalogueFailure(c, error, "seleccionar sesión");
  }
}

export function registerSessionRoutes(
  app: {
    get: (
      path: string,
      handler: (c: Context<SessionEnv>) => Response | Promise<Response>,
    ) => void;
    post: (
      path: string,
      handler: (c: Context<SessionEnv>) => Response | Promise<Response>,
    ) => void;
  },
  deps: SessionRouteDeps,
): void {
  app.post("/agents/:name/sessions", (c) => handleCreateSession(c, deps));
  app.get("/agents/:name/sessions", (c) => handleListSessions(c, deps));
  app.post("/agents/:name/sessions/:sessionId/select", (c) =>
    handleSelectSession(c, deps),
  );
}
