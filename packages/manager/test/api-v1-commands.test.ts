import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function setupAgent(port: number): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-commands-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function runningSupervisor(port: number): Supervisor {
  return {
    statusOf: async (config: { name: string; port: number }) => ({
      ...config,
      state: "running",
      port,
      pid: 42,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

test("GET /agents/:name/commands devuelve el catálogo del Runner sin exponer su puerto", async () => {
  const runner = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/commands");
    assert.equal(request.headers.authorization, "Bearer service-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ skills: ["review"], prompts: ["summarize"] }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(port));
    const response = await app.request("http://pihub.test/agents/agent/commands", {
      headers: { authorization: "Bearer service-token" },
    });
    const rawText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(rawText), { skills: ["review"], prompts: ["summarize"] });
    assert.doesNotMatch(rawText, /4100|127\.0\.0\.1|\/data/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("GET /agents/:name/commands traduce un error del Runner a RESOURCE_UNAVAILABLE", async () => {
  const runner = createServer((_request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Runner path /data/private" }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(port));
    const response = await app.request("http://pihub.test/agents/agent/commands", {
      headers: { authorization: "Bearer service-token" },
    });
    const rawText = await response.text();
    const body = JSON.parse(rawText) as { code?: string };

    assert.equal(response.status, 503);
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
    assert.doesNotMatch(rawText, /Runner path|\/data\/private/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("GET /agents/:name/commands de un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-commands-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(4100));
    const response = await app.request("http://pihub.test/agents/no-existe/commands", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
