import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import {
  agentPaths,
  isAuthorized,
  isProtectedEnvKey,
  listAgents,
  listEnvKeys,
  piInstall,
  piRemove,
  piVersion,
  readAgent,
  sessionCookie,
  setEnv,
  unsetEnv,
  type PihubEnv,
} from "@pihub/shared";
import {
  createAgent,
  deleteAgent,
  listPackages,
  readSystemPrompt,
  updateAgent,
} from "./agents.js";
import type { Supervisor } from "./supervisor.js";
import type { OAuthService } from "./oauth.js";
import { listModels } from "./models.js";
import { panelDir } from "./paths.js";
import path from "node:path";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const sharedMemoryAccessValues = ["none", "read", "read-write"] as const;

const memorySchema = z.object({
  sharedAccess: z.enum(sharedMemoryAccessValues).optional(),
});

export const createAgentSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  systemPrompt: z.string().optional(),
  telegramToken: z.string().optional(),
  ttsVoice: z.string().optional(),
  memory: memorySchema.optional(),
  packages: z.array(z.string()).optional(),
});

export const updateAgentSchema = z.object({
  model: z.string().optional(),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  systemPrompt: z.string().optional(),
  telegramToken: z.string().nullable().optional(),
  ttsVoice: z.string().nullable().optional(),
  memory: memorySchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

const packageSchema = z.object({
  source: z.string().min(1),
  scope: z.enum(["global", "agent"]),
  agent: z.string().optional(),
});

const envSetSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  scope: z.enum(["global", "agent"]),
  agent: z.string().optional(),
});

const envUnsetSchema = z.object({
  key: z.string().min(1),
  scope: z.enum(["global", "agent"]),
  agent: z.string().optional(),
});

export function createApi(env: PihubEnv, supervisor: Supervisor, oauth: OAuthService): Hono {
  const app = new Hono();

  app.post("/auth/session", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (env.apiToken && body.token !== env.apiToken) {
      return c.json({ error: "Token incorrecto" }, 401);
    }
    c.header("Set-Cookie", sessionCookie(env.apiToken));
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    if (!isAuthorized(env.apiToken, c.req.header("authorization"), c.req.header("cookie"))) {
      return c.json({ error: "No autorizado" }, 401);
    }
    await next();
  });

  app.get("/api/status", async (c) => {
    const agents = await listAgents(env.dataDir);
    return c.json({
      ok: true,
      version: "0.1.0",
      pi: await piVersion(env.dataDir),
      agents: agents.length,
      panel: env.panelEnabled,
      oauthProviders: env.oauthProviders,
      portRange: env.agentPortRange,
    });
  });

  // --- Modelos disponibles (solo lectura) ---
  app.get("/api/models", (c) => {
    try {
      return c.json({ models: listModels(env) });
    } catch (error) {
      console.error("[manager] error listando modelos:", error);
      return c.json({ models: [] });
    }
  });

  // --- Agentes ---
  app.get("/api/agents", async (c) => {
    const agents = await listAgents(env.dataDir);
    return c.json(await Promise.all(agents.map((a) => supervisor.statusOf(a))));
  });

  app.post("/api/agents", async (c) => {
    const parsed = createAgentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const config = await createAgent(env, parsed.data);
      await supervisor.start(config.name);
      return c.json(await supervisor.statusOf(config), 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/agents/:name", async (c) => {
    const config = await readAgent(env.dataDir, c.req.param("name"));
    if (!config) return c.json({ error: "No existe" }, 404);
    return c.json({
      ...(await supervisor.statusOf(config)),
      systemPrompt: await readSystemPrompt(env, config.name),
      packages: await listPackages(env, config.name),
    });
  });

  // Proxy al runner: comandos (skills/templates) del agente. Evita CORS
  // (el panel no puede llamar al puerto del runner directamente por HTTP).
  app.get("/api/agents/:name/commands", async (c) => {
    const config = await readAgent(env.dataDir, c.req.param("name"));
    if (!config) return c.json({ error: "No existe" }, 404);
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/api/commands`, {
        headers: env.apiToken ? { authorization: `Bearer ${env.apiToken}` } : {},
      });
      return c.json(await response.json(), response.status as 200);
    } catch {
      return c.json({ skills: [], prompts: [] });
    }
  });

  // Proxies multipart al runner (voz y archivos del workspace del agente).
  for (const route of ["transcribe", "upload"] as const) {
    app.post(`/api/agents/:name/${route}`, async (c) => {
      const config = await readAgent(env.dataDir, c.req.param("name"));
      if (!config) return c.json({ error: "No existe" }, 404);
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/api/${route}`, {
          method: "POST",
          headers: {
            ...(env.apiToken ? { authorization: `Bearer ${env.apiToken}` } : {}),
            ...(c.req.header("content-type") ? { "content-type": c.req.header("content-type")! } : {}),
          },
          body: c.req.raw.body,
          duplex: "half", // requerido por Node para streams en fetch
        } as RequestInit);
        return c.json(await response.json(), response.status as 200);
      } catch (error) {
        return c.json({ error: `Runner inaccesible: ${(error as Error).message}` }, 502);
      }
    });
  }

  app.patch("/api/agents/:name", async (c) => {
    const parsed = updateAgentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const config = await updateAgent(env, c.req.param("name"), parsed.data);
      await supervisor.restart(config.name).catch(() => {});
      return c.json(await supervisor.statusOf(config));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    if (!(await readAgent(env.dataDir, name))) return c.json({ error: "No existe" }, 404);
    await supervisor.stop(name);
    await deleteAgent(env, name);
    return c.json({ ok: true });
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post(`/api/agents/:name/${action}`, async (c) => {
      const name = c.req.param("name");
      const config = await readAgent(env.dataDir, name);
      if (!config) return c.json({ error: "No existe" }, 404);
      try {
        if (action === "start") {
          await updateAgent(env, name, { enabled: true });
          await supervisor.start(name);
        } else if (action === "stop") {
          await updateAgent(env, name, { enabled: false });
          await supervisor.stop(name);
        } else {
          await supervisor.restart(name);
        }
        return c.json(await supervisor.statusOf((await readAgent(env.dataDir, name))!));
      } catch (error) {
        return c.json({ error: (error as Error).message }, 500);
      }
    });
  }

  // --- Paquetes (extensiones, skills, prompts, temas) ---
  app.get("/api/packages", async (c) => {
    const agent = c.req.query("agent");
    return c.json({ packages: await listPackages(env, agent || undefined) });
  });

  app.post("/api/packages", async (c) => {
    const parsed = packageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { source, scope, agent } = parsed.data;
    const workspace = await resolveWorkspace(env, scope, agent);
    if (workspace === null) return c.json({ error: "Agente requerido o inexistente" }, 400);
    const result = await piInstall(env.dataDir, source, workspace);
    if (!result.ok) return c.json({ error: result.stderr.slice(0, 1000) }, 500);
    scheduleReload(supervisor, scope, agent);
    return c.json({ ok: true, output: result.stdout.slice(0, 1000) });
  });

  app.delete("/api/packages", async (c) => {
    const parsed = packageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { source, scope, agent } = parsed.data;
    const workspace = await resolveWorkspace(env, scope, agent);
    if (workspace === null) return c.json({ error: "Agente requerido o inexistente" }, 400);
    const result = await piRemove(env.dataDir, source, workspace);
    if (!result.ok) return c.json({ error: result.stderr.slice(0, 1000) }, 500);
    scheduleReload(supervisor, scope, agent);
    return c.json({ ok: true });
  });

  // --- Variables de entorno (global / por agente) ---
  // Solo se devuelven las claves; los valores nunca se exponen (son secretos).
  app.get("/api/env", async (c) => {
    const agent = c.req.query("agent");
    if (agent && !(await readAgent(env.dataDir, agent))) return c.json({ error: "Agente inexistente" }, 400);
    return c.json({
      global: await listEnvKeys(env.dataDir),
      agent: agent ? await listEnvKeys(env.dataDir, agent) : undefined,
      protectedKeys: ["API_TOKEN", "PIHUB_*", "PI_CODING_AGENT_*"],
    });
  });

  app.post("/api/env", async (c) => {
    const parsed = envSetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { key, value, scope, agent } = parsed.data;
    if (isProtectedEnvKey(key)) return c.json({ error: `La variable "${key}" está protegida` }, 400);
    if (scope === "agent" && (!agent || !(await readAgent(env.dataDir, agent)))) {
      return c.json({ error: "Agente requerido o inexistente" }, 400);
    }
    try {
      await setEnv(env.dataDir, key, value, scope === "agent" ? agent : undefined);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    scheduleReload(supervisor, scope, agent);
    return c.json({ ok: true });
  });

  app.delete("/api/env", async (c) => {
    const parsed = envUnsetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { key, scope, agent } = parsed.data;
    if (scope === "agent" && (!agent || !(await readAgent(env.dataDir, agent)))) {
      return c.json({ error: "Agente requerido o inexistente" }, 400);
    }
    await unsetEnv(env.dataDir, key, scope === "agent" ? agent : undefined);
    scheduleReload(supervisor, scope, agent);
    return c.json({ ok: true });
  });

  // --- OAuth (gated por PIHUB_OAUTH_PROVIDERS) ---
  app.get("/api/auth/providers", (c) => c.json({ providers: oauth.providers() }));

  app.post("/api/auth/login/:provider", (c) => {
    try {
      return c.json(oauth.startLogin(c.req.param("provider")));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/auth/flows/:id", (c) => {
    const flow = oauth.getFlow(c.req.param("id"));
    return flow ? c.json(flow) : c.json({ error: "No existe" }, 404);
  });

  app.post("/api/auth/flows/:id/input", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    try {
      return c.json(oauth.submitInput(c.req.param("id"), body.value ?? ""));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/auth/logout/:provider", (c) => {
    oauth.logout(c.req.param("provider"));
    return c.json({ ok: true });
  });

  // --- Panel (desactivable) ---
  if (env.panelEnabled) {
    app.use(
      "/*",
      serveStatic({
        root: path.relative(process.cwd(), panelDir),
      }),
    );
  }

  return app;
}

async function resolveWorkspace(
  env: PihubEnv,
  scope: "global" | "agent",
  agent: string | undefined,
): Promise<string | undefined | null> {
  if (scope === "global") return undefined;
  if (!agent || !(await readAgent(env.dataDir, agent))) return null;
  return agentPaths(env.dataDir, agent).workspaceDir;
}

/** Reinicia runners tras un cambio de paquetes, en diferido para no cortar la respuesta HTTP. */
function scheduleReload(
  supervisor: Supervisor,
  scope: "global" | "agent",
  agent: string | undefined,
): void {
  setTimeout(() => {
    if (scope === "global") {
      void supervisor.restartAllRunning();
    } else if (agent) {
      void supervisor.restart(agent).catch(() => {});
    }
  }, 500);
}
