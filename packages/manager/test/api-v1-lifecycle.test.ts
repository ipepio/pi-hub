import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgent, scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// §1.3 del plan: POST /agents/:name/{start,stop,restart} — ciclo de vida
// explícito, separado del estado declarativo del PATCH.

async function setup(enabled: boolean) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-lifecycle-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    enabled,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function fakeSupervisor(actions: string[], running: boolean): Supervisor {
  return {
    state: () => ({ state: running ? "running" : "stopped", pid: running ? 42 : undefined }),
    start: async () => actions.push("start"),
    stop: async () => actions.push("stop"),
    restart: async () => actions.push("restart"),
    statusOf: async (config: { name: string }) => ({
      ...config,
      state: running ? "running" : "stopped",
      port: 4100,
      pid: running ? 42 : undefined,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

test("POST /agents/:name/start arranca el proceso y fija enabled:true", async () => {
  const dataDir = await setup(false);
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(actions, false));

    const response = await app.request("http://pihub.test/agents/agent/start", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, ["start"]);
    assert.equal((await readAgent(dataDir, "agent"))?.enabled, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/stop para el proceso y fija enabled:false", async () => {
  const dataDir = await setup(true);
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(actions, true));

    const response = await app.request("http://pihub.test/agents/agent/stop", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, ["stop"]);
    assert.equal((await readAgent(dataDir, "agent"))?.enabled, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/restart reinicia sin tocar enabled", async () => {
  const dataDir = await setup(true);
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(actions, true));

    const response = await app.request("http://pihub.test/agents/agent/restart", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, ["restart"]);
    assert.equal((await readAgent(dataDir, "agent"))?.enabled, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

for (const action of ["start", "stop", "restart"]) {
  test(`POST /agents/:name/${action} de un Agent inexistente da AGENT_NOT_FOUND`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-lifecycle-"));
    try {
      const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor([], true));
      const response = await app.request(`http://pihub.test/agents/no-existe/${action}`, {
        method: "POST",
        headers: { authorization: "Bearer service-token" },
      });
      assert.equal(response.status, 404);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test(`POST /agents/:name/${action} exige la credencial de servicio`, async () => {
    const dataDir = await setup(true);
    try {
      const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor([], true));
      const response = await app.request(`http://pihub.test/agents/agent/${action}`, { method: "POST" });
      assert.equal(response.status, 401);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}
