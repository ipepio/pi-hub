import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentPaths,
  readAgent,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  setEnv,
  writeAgent,
} from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// Bug 1: el PATCH solo reiniciaba el Runner si cambiaba telegramToken. El
// dashboard reconcilia mandando el estado completo en CADA llamada
// (model + systemPrompt en cada reconcile), así que cambiar el Model o
// editar la Persona se persistía sin que el Runner en marcha se enterara
// nunca. Estos tests reproducen el bug contra el PATCH real, no contra la
// huella aislada (ya cubierta en api-v1-restart-policy.test.ts).

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-fingerprint-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    model: "anthropic/claude-sonnet-5",
    telegramToken: "old-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function runningSupervisor(actions: string[]): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    start: async () => {
      actions.push("start");
    },
    stop: async () => {
      actions.push("stop");
    },
    restart: async () => {
      actions.push("restart");
    },
    statusOf: async (config: { name: string; telegramToken?: string }) => {
      const { telegramToken: _telegramToken, ...safe } = config;
      return { ...safe, state: "running", port: 4100, pid: 42, telegram: Boolean(config.telegramToken) };
    },
  } as unknown as Supervisor;
}

test("PATCH /agents/:name reinicia el Runner cuando cambia el model", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.model, "openai/gpt-5");
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name reinicia el Runner cuando cambia el systemPrompt", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ systemPrompt: "Eres Linus Torvalds." }),
    });

    assert.equal(response.status, 200);
    const persistido = await fs.readFile(agentPaths(dataDir, "agent").systemPromptFile, "utf8");
    assert.equal(persistido, "Eres Linus Torvalds.");
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name reconciliando el MISMO model y systemPrompt NO reinicia", async () => {
  // Es el caso que 87b3c78 ya resolvió para telegramToken, generalizado: el
  // dashboard manda el estado completo en cada reconcile. Si el estado no
  // cambió, reiniciar no tendría ningún efecto observable y solo cortaría
  // el turno en curso.
  const dataDir = await setup();
  try {
    await fs.writeFile(agentPaths(dataDir, "agent").systemPromptFile, "Persona actual.", "utf8");
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        systemPrompt: "Persona actual.",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name reconciliando el mismo estado con env del Agent ya fijado tampoco reinicia", async () => {
  // Control negativo: el env store del Agent influye en la huella (ver
  // api-v1-restart-policy.test.ts), pero el PATCH no lo toca — leerlo antes
  // y después dentro de la MISMA petición da el mismo valor. Que un PATCH
  // sin cambios de config siga sin reiniciar aunque haya env fijado
  // confirma que no hay una lectura obsoleta escondida.
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "MY_VAR", "v1", "agent");
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name con enabled:false para el proceso de verdad (bug 2)", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.enabled, false);
    assert.deepEqual(actions, ["stop"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
