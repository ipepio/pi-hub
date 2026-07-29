import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentPaths,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  setEnv,
  writeAgent,
} from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// Bug 4: la spec §4.3 promete GET /api/v1/agents/:name y no existía.
// systemPrompt/packages/envKeys son solo de aquí — nunca del listado.

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-get-agent-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    model: "anthropic/claude-sonnet-5",
    telegramToken: "secret-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function fakeSupervisor(): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    statusOf: async (config: { name: string; telegramToken?: string }) => {
      const { telegramToken: _telegramToken, ...safe } = config;
      return { ...safe, state: "running", port: 4100, pid: 42, telegram: Boolean(config.telegramToken) };
    },
  } as unknown as Supervisor;
}

test("GET /agents/:name devuelve systemPrompt, envKeys y packages", async () => {
  const dataDir = await setup();
  try {
    await fs.writeFile(agentPaths(dataDir, "agent").systemPromptFile, "Eres Linus Torvalds.", "utf8");
    await setEnv(dataDir, "MY_VAR", "v1", "agent");
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.name, "agent");
    assert.equal(body.systemPrompt, "Eres Linus Torvalds.");
    assert.deepEqual(body.envKeys, ["MY_VAR"]);
    assert.deepEqual(body.packages, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name nunca expone el token de Telegram, solo el booleano", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.text();

    assert.doesNotMatch(body, /secret-token/);
    assert.match(body, /"telegram":true/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name de un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-get-agent-"));
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/no-existe", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent", { method: "GET" });

    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents (listado) NO expone systemPrompt/envKeys/packages", async () => {
  const dataDir = await setup();
  try {
    await fs.writeFile(agentPaths(dataDir, "agent").systemPromptFile, "Persona secreta.", "utf8");
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.text();

    assert.doesNotMatch(body, /Persona secreta/);
    assert.doesNotMatch(body, /systemPrompt/);
    assert.doesNotMatch(body, /envKeys/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
