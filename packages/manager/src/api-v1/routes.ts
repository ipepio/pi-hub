import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import WebSocket from "ws";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { listAgents, readAgent, type AgentStatus, type PihubEnv } from "@pihub/shared";
import { createAgent, deleteAgent, updateAgent } from "../agents.js";
import type { Supervisor } from "../supervisor.js";
import { apiError, HTTP_STATUS_BY_CODE, type ApiErrorCode } from "./errors.js";
import { classifyServiceAuth } from "./auth.js";
import { isDuplicateTurn, rememberTurn, toTurnEvent } from "./turns.js";
import {
  createAgentV1Schema,
  createSessionV1Schema,
  createTurnV1Schema,
  updateAgentV1Schema,
} from "./schemas.js";

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
  /** Idempotencia de turnos por instancia del Manager (spec §5). */
  const turnosVistos = new Map<string, string>();

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

  // Spec §4.3. Faltaba: `contract-red` no lo cubre, asi que nadie lo
  // echo en falta hasta que el adapter del dashboard intento su camino
  // idempotente (POST -> 409 -> PATCH) y se comio un 404.
  app.patch("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await readAgent(env.dataDir, name).catch(() => undefined);
    if (!config) return fail(c, "AGENT_NOT_FOUND", "Agent not found");

    const parsed = updateAgentV1Schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "BAD_REQUEST", "Invalid agent payload");

    try {
      // El Runner crea el long-polling de Telegram al arrancar; un cambio de
      // credencial solo es efectivo después de recrearlo. Si el Agent estaba
      // parado no se arranca por sorpresa: el siguiente start leerá el nuevo
      // config.
      const wasRunning = supervisor.state(name).state === "running";
      const actualizado = await updateAgent(env, name, parsed.data);
      if ("telegramToken" in parsed.data && wasRunning) {
        if (actualizado.enabled) await supervisor.restart(name);
        else await supervisor.stop(name);
      }
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

      await new Promise<void>((resolve) => {
        let cerrado = false;
        const cerrar = () => {
          if (cerrado) return;
          cerrado = true;
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

/** Helper compartido por las rutas: traduce un código a su respuesta. */
export function fail(c: Context<ApiV1Env>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}
