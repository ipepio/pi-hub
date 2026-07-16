import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer, type WebSocket } from "ws";
import {
  agentPaths,
  dataPaths,
  isAuthorized,
  listEnvKeys,
  piInstall,
  piRemove,
  readPackageSources,
  sessionCookie,
  type AgentConfig,
  type ClientWsMessage,
  type PihubEnv,
  type ServerWsMessage,
} from "@pihub/shared";
import type { ChatHub } from "./hub.js";
import type { SessionFactory } from "./session.js";
import { sttEnabled, transcribe, ttsEnabled } from "./speech.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Borra los archivos de workspace/uploads más viejos que la retención configurada. */
async function cleanUploads(uploadsDir: string, retentionHours: number): Promise<void> {
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const entries = await fs.readdir(uploadsDir).catch(() => [] as string[]);
  for (const entry of entries) {
    const file = path.join(uploadsDir, entry);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
  }
}

export function startServer(env: PihubEnv, config: AgentConfig, hub: ChatHub, factory: SessionFactory): Server {
  const paths = agentPaths(env.dataDir, config.name);
  const app = new Hono();

  app.post("/auth/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (env.apiToken && body.token !== env.apiToken) {
      return c.json({ error: "Token incorrecto" }, 401);
    }
    c.header("Set-Cookie", sessionCookie(env.apiToken));
    return c.json({ ok: true, agent: config.name });
  });

  app.use("/api/*", async (c, next) => {
    if (!isAuthorized(env.apiToken, c.req.header("authorization"), c.req.header("cookie"))) {
      return c.json({ error: "No autorizado" }, 401);
    }
    await next();
  });

  app.get("/api/status", (c) =>
    c.json({
      agent: config.name,
      model: hub.modelId,
      streaming: hub.isStreaming,
      sessionId: hub.sessionId,
      telegram: Boolean(config.telegramToken),
      memory: env.memoryEnabled,
      stt: sttEnabled(env),
      tts: ttsEnabled(env),
    }),
  );

  app.post("/api/session/new", async (c) => c.json({ sessionId: await hub.newSession() }));

  // --- Comandos del agente: skills y prompt templates instalados ---
  app.get("/api/commands", async (c) => c.json(await factory.listCommands()));

  // --- Voz: transcripción (el audio no se guarda, solo pasa por memoria) ---
  app.post("/api/transcribe", async (c) => {
    if (!sttEnabled(env)) return c.json({ error: "STT no configurado" }, 501);
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Falta el campo file (multipart)" }, 400);
    if (file.size > MAX_AUDIO_BYTES) return c.json({ error: "Audio demasiado grande (máx. 25 MB)" }, 413);
    try {
      const text = await transcribe(
        env,
        Buffer.from(await file.arrayBuffer()),
        file.name || "audio.webm",
        file.type || "audio/webm",
      );
      return c.json({ text });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  // --- Archivos: se guardan en workspace/uploads y el agente los procesa con sus tools.
  //     Retención limitada (PIHUB_UPLOADS_RETENTION_HOURS); se borran solos. ---
  app.post("/api/upload", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Falta el campo file (multipart)" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "Archivo demasiado grande (máx. 50 MB)" }, 413);
    const safeName = (file.name || "archivo").replace(/[^\w.\-]+/g, "_").slice(0, 120);
    const uploadsDir = path.join(paths.workspaceDir, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const stored = `${Date.now()}-${safeName}`;
    await fs.writeFile(path.join(uploadsDir, stored), Buffer.from(await file.arrayBuffer()));
    return c.json({
      path: `uploads/${stored}`,
      name: file.name || safeName,
      size: file.size,
      type: file.type || "application/octet-stream",
    });
  });

  // --- Modelos disponibles (solo lectura; los providers se gestionan por env/archivos/CLI) ---
  app.get("/api/models", (c) =>
    c.json({
      models: factory.listModels(),
      current: hub.modelId ?? null,
      default: config.model ?? null,
    }),
  );

  // --- Recursos (extensiones, skills, prompts, templates) ---
  app.get("/api/resources", async (c) =>
    c.json({
      agent: await readPackageSources(path.join(paths.workspacePiDir, "settings.json")),
      global: await readPackageSources(path.join(dataPaths(env.dataDir).globalDir, "settings.json")),
    }),
  );

  app.post("/api/resources", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { source?: string; scope?: string };
    if (!body.source) return c.json({ error: "Falta source" }, 400);
    if (body.scope === "global") {
      return forwardToManager(env, c.req.header("cookie"), "POST", "/api/packages", {
        source: body.source,
        scope: "global",
      }).then((r) => c.json(r.body, r.status as 200));
    }
    const result = await piInstall(env.dataDir, body.source, paths.workspaceDir);
    if (!result.ok) return c.json({ error: result.stderr.slice(0, 1000) }, 500);
    hub.reset();
    return c.json({ ok: true, output: result.stdout.slice(0, 1000) });
  });

  app.delete("/api/resources", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { source?: string; scope?: string };
    if (!body.source) return c.json({ error: "Falta source" }, 400);
    if (body.scope === "global") {
      return forwardToManager(env, c.req.header("cookie"), "DELETE", "/api/packages", {
        source: body.source,
        scope: "global",
      }).then((r) => c.json(r.body, r.status as 200));
    }
    const result = await piRemove(env.dataDir, body.source, paths.workspaceDir);
    if (!result.ok) return c.json({ error: result.stderr.slice(0, 1000) }, 500);
    hub.reset();
    return c.json({ ok: true });
  });

  // --- Variables de entorno (solo claves; fijar/borrar requiere respawn → lo hace el manager) ---
  app.get("/api/env", async (c) =>
    c.json({
      agent: await listEnvKeys(env.dataDir, config.name),
      global: await listEnvKeys(env.dataDir),
      protectedKeys: ["API_TOKEN", "PIHUB_*", "PI_CODING_AGENT_*"],
    }),
  );

  app.post("/api/env", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string; scope?: string };
    if (!body.key) return c.json({ error: "Falta key" }, 400);
    const scope = body.scope === "global" ? "global" : "agent";
    const r = await forwardToManager(env, c.req.header("cookie"), "POST", "/api/env", {
      key: body.key,
      value: body.value ?? "",
      scope,
      ...(scope === "agent" ? { agent: config.name } : {}),
    });
    return c.json(r.body, r.status as 200);
  });

  app.delete("/api/env", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: string; scope?: string };
    if (!body.key) return c.json({ error: "Falta key" }, 400);
    const scope = body.scope === "global" ? "global" : "agent";
    const r = await forwardToManager(env, c.req.header("cookie"), "DELETE", "/api/env", {
      key: body.key,
      scope,
      ...(scope === "agent" ? { agent: config.name } : {}),
    });
    return c.json(r.body, r.status as 200);
  });

  app.use("/*", serveStatic({ root: path.relative(process.cwd(), publicDir) }));

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(`[runner:${config.name}] escuchando en :${info.port}`);
  }) as Server;

  const uploadsDir = path.join(paths.workspaceDir, "uploads");
  void cleanUploads(uploadsDir, env.uploadsRetentionHours);
  const cleanupTimer = setInterval(
    () => void cleanUploads(uploadsDir, env.uploadsRetentionHours),
    CLEANUP_INTERVAL_MS,
  );
  cleanupTimer.unref();

  attachWebSocket(server, env, config, hub);
  return server;
}

function attachWebSocket(server: Server, env: PihubEnv, config: AgentConfig, hub: ChatHub): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isAuthorized(env.apiToken, request.headers.authorization, request.headers.cookie)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket) => {
    const send = (message: ServerWsMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const unsubscribe = hub.subscribe(send);

    send({
      type: "ready",
      agent: config.name,
      model: hub.modelId,
      sessionId: hub.sessionId ?? "",
      stt: sttEnabled(env),
      tts: ttsEnabled(env),
    });

    ws.on("message", (raw) => {
      let message: ClientWsMessage;
      try {
        message = JSON.parse(String(raw)) as ClientWsMessage;
      } catch {
        return;
      }
      if (message.type === "prompt" && message.text?.trim()) {
        void hub.prompt(message.text);
      } else if (message.type === "abort") {
        void hub.abort();
      } else if (message.type === "new_session") {
        void hub.newSession();
      } else if (message.type === "set_model" && message.model?.trim()) {
        // Éxito → broadcast model_changed a todos; error → solo a este cliente.
        hub.setModel(message.model.trim()).catch((error: unknown) => {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        });
      }
    });

    ws.on("close", unsubscribe);
  });
}

/** Reenvía una operación al manager (para cambios que requieren respawnear el runner). */
async function forwardToManager(
  env: PihubEnv,
  cookie: string | undefined,
  method: "POST" | "DELETE",
  route: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`http://127.0.0.1:${env.managerPort}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(env.apiToken ? { authorization: `Bearer ${env.apiToken}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch (error) {
    return { status: 502, body: { error: `Manager inaccesible: ${(error as Error).message}` } };
  }
}
