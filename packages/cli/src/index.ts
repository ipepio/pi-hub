#!/usr/bin/env node
/**
 * pihub — CLI de administración (cliente fino de la API REST del manager).
 * Config por env: PIHUB_URL (default http://127.0.0.1:4000) y API_TOKEN.
 */
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";

const BASE = process.env.PIHUB_URL ?? `http://127.0.0.1:${process.env.PIHUB_MANAGER_PORT ?? 4000}`;
const TOKEN = process.env.API_TOKEN ?? "";

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...options.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
  }
  return body;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === "-g") {
      flags.global = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.log(`pihub — gestión de agentes pi

Uso:
  pihub status
  pihub agent list
  pihub agent create <nombre> [--model prov/id] [--system "texto"] [--system-file f.md]
                              [--telegram token] [--voice voz] [--packages a,b] [--thinking nivel]
                              [--shared-memory none|read|read-write]
  pihub agent update <nombre> [--model prov/id] [--thinking nivel]
                              [--system "texto" | --system-file f.md]
                              [--telegram token | --no-telegram]
                              [--voice voz | --no-voice]
                              [--shared-memory none|read|read-write|default]
                              [--enable | --disable]
  pihub agent show <nombre>
  pihub agent start|stop|restart|rm <nombre>
  pihub models                   (modelos disponibles: ● con credenciales, ○ sin)
  pihub install <source> [-g | --agent <nombre>]     (por defecto: -g)
  pihub remove <source> [-g | --agent <nombre>]
  pihub env list [-g | --agent <nombre>]
  pihub env set KEY=VALUE [-g | --agent <nombre>]    (por defecto: -g)
  pihub env unset KEY [-g | --agent <nombre>]
  pihub login <proveedor>        (requiere PIHUB_OAUTH_PROVIDERS en el .env)
  pihub logout <proveedor>

Env: PIHUB_URL (default http://127.0.0.1:4000), API_TOKEN`);
  process.exit(1);
}

async function login(provider: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let flow = (await api(`/api/auth/login/${provider}`, { method: "POST" })) as Record<string, unknown>;
  const flowId = flow.id as string;
  const seen = new Set<string>();

  for (;;) {
    flow = (await api(`/api/auth/flows/${flowId}`)) as Record<string, unknown>;
    const phase = flow.phase as string;
    const key = `${phase}:${flow.url ?? ""}:${flow.message ?? ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      if (flow.url) console.log(`\nAbre en el navegador:\n  ${flow.url}`);
      if (flow.userCode) console.log(`Código a introducir: ${flow.userCode}`);
      if (flow.progress) console.log(String(flow.progress));
    }

    if (phase === "done") {
      console.log("✔ Conectado");
      break;
    }
    if (phase === "error") {
      console.error(`⚠️ ${flow.error}`);
      process.exitCode = 1;
      break;
    }
    if (phase === "input") {
      const value = await rl.question(`${flow.message ?? "Código"}: `);
      await api(`/api/auth/flows/${flowId}/input`, { method: "POST", body: JSON.stringify({ value }) });
    } else if (phase === "select") {
      const options = (flow.options ?? []) as Array<{ id: string; label: string }>;
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
      const answer = await rl.question("Elige una opción: ");
      const chosen = options[Number(answer) - 1];
      if (chosen) {
        await api(`/api/auth/flows/${flowId}/input`, {
          method: "POST",
          body: JSON.stringify({ value: chosen.id }),
        });
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  rl.close();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (command) {
    case "status": {
      console.log(JSON.stringify(await api("/api/status"), null, 2));
      break;
    }
    case "agent": {
      const [sub, name] = positional;
      if (sub === "list") {
        const agents = (await api("/api/agents")) as Array<Record<string, unknown>>;
        if (!agents.length) console.log("(sin agentes)");
        for (const a of agents) {
          console.log(
            `${a.state === "running" ? "●" : "○"} ${String(a.name).padEnd(20)} :${a.port}  ${a.model ?? "(modelo default)"}${a.telegram ? "  ✈ telegram" : ""}`,
          );
        }
      } else if (sub === "create") {
        if (!name) usage();
        const systemPrompt = flags["system-file"]
          ? readFileSync(String(flags["system-file"]), "utf8")
          : (flags.system as string | undefined);
        const created = await api("/api/agents", {
          method: "POST",
          body: JSON.stringify({
            name,
            model: flags.model as string | undefined,
            thinkingLevel: flags.thinking as string | undefined,
            telegramToken: flags.telegram as string | undefined,
            ttsVoice: typeof flags.voice === "string" ? flags.voice : undefined,
            memory:
              typeof flags["shared-memory"] === "string" && flags["shared-memory"] !== "default"
                ? { sharedAccess: flags["shared-memory"] }
                : undefined,
            systemPrompt,
            packages: flags.packages ? String(flags.packages).split(",").map((s) => s.trim()) : undefined,
          }),
        });
        const agent = created as Record<string, unknown>;
        console.log(`✔ Agente "${name}" creado en el puerto ${agent.port}`);
      } else if (sub === "update") {
        if (!name) usage();
        const body: Record<string, unknown> = {};
        if (typeof flags.model === "string") body.model = flags.model;
        if (typeof flags.thinking === "string") body.thinkingLevel = flags.thinking;
        if (typeof flags.telegram === "string") body.telegramToken = flags.telegram;
        if (flags["no-telegram"]) body.telegramToken = null;
        if (typeof flags.voice === "string") body.ttsVoice = flags.voice;
        if (flags["no-voice"]) body.ttsVoice = null;
        if (typeof flags["shared-memory"] === "string") {
          // "default" quita el override: el agente vuelve a PIHUB_SHARED_MEMORY_DEFAULT
          body.memory = flags["shared-memory"] === "default" ? null : { sharedAccess: flags["shared-memory"] };
        }
        if (flags["system-file"]) body.systemPrompt = readFileSync(String(flags["system-file"]), "utf8");
        else if (typeof flags.system === "string") body.systemPrompt = flags.system;
        if (flags.enable) body.enabled = true;
        if (flags.disable) body.enabled = false;
        if (!Object.keys(body).length) usage();
        await api(`/api/agents/${name}`, { method: "PATCH", body: JSON.stringify(body) });
        console.log(`✔ Agente "${name}" actualizado (reiniciándose)`);
      } else if (sub === "show") {
        if (!name) usage();
        console.log(JSON.stringify(await api(`/api/agents/${name}`), null, 2));
      } else if (sub === "rm") {
        if (!name) usage();
        await api(`/api/agents/${name}`, { method: "DELETE" });
        console.log(`✔ Agente "${name}" eliminado`);
      } else if (sub === "start" || sub === "stop" || sub === "restart") {
        if (!name) usage();
        await api(`/api/agents/${name}/${sub}`, { method: "POST" });
        console.log(`✔ ${sub} ${name}`);
      } else {
        usage();
      }
      break;
    }
    case "models": {
      const data = (await api("/api/models")) as {
        models: Array<{ provider: string; id: string; name: string; configured: boolean }>;
      };
      if (!data.models.length) {
        console.log("(sin modelos: revisa /data/global/models.json y las credenciales)");
        break;
      }
      for (const m of data.models) {
        console.log(`${m.configured ? "●" : "○"} ${`${m.provider}/${m.id}`.padEnd(44)} ${m.name}`);
      }
      break;
    }
    case "install":
    case "remove": {
      const [source] = positional;
      if (!source) usage();
      const scope = flags.agent ? "agent" : "global";
      await api("/api/packages", {
        method: command === "install" ? "POST" : "DELETE",
        body: JSON.stringify({ source, scope, agent: flags.agent as string | undefined }),
      });
      console.log(`✔ ${command === "install" ? "Instalado" : "Eliminado"} ${source} (${scope}${flags.agent ? `: ${flags.agent}` : ""})`);
      break;
    }
    case "env": {
      const [sub, ...envArgs] = positional;
      const agent = flags.agent as string | undefined;
      const scope = agent ? "agent" : "global";
      if (sub === "list") {
        const data = (await api(`/api/env${agent ? `?agent=${agent}` : ""}`)) as {
          global: string[];
          agent?: string[];
          protectedKeys: string[];
        };
        console.log(`Global: ${data.global.length ? data.global.join(", ") : "(vacío)"}`);
        if (agent) console.log(`Agente ${agent}: ${data.agent?.length ? data.agent.join(", ") : "(vacío)"}`);
        console.log(`Protegidas (no editables): ${data.protectedKeys.join(", ")}`);
      } else if (sub === "set") {
        const pair = envArgs.join(" ");
        const eq = pair.indexOf("=");
        if (eq < 0) usage();
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        await api("/api/env", { method: "POST", body: JSON.stringify({ key, value, scope, agent }) });
        console.log(`✔ ${key} fijada (${scope}${agent ? `: ${agent}` : ""})`);
      } else if (sub === "unset") {
        const key = envArgs[0];
        if (!key) usage();
        await api("/api/env", { method: "DELETE", body: JSON.stringify({ key, scope, agent }) });
        console.log(`✔ ${key} eliminada (${scope}${agent ? `: ${agent}` : ""})`);
      } else {
        usage();
      }
      break;
    }
    case "login": {
      if (!positional[0]) usage();
      await login(positional[0]);
      break;
    }
    case "logout": {
      if (!positional[0]) usage();
      await api(`/api/auth/logout/${positional[0]}`, { method: "POST" });
      console.log("✔ Logout");
      break;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
