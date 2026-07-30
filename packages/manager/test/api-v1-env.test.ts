import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvStore, scaffoldAgentDirs, scaffoldGlobalDirs, setEnv, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// §1.3 del plan: GET/PUT /agents/:name/env — conjunto COMPLETO. GET
// devuelve SOLO claves (nunca valores, para no exponer secretos).

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-env-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function runningSupervisor(actions: string[]): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    start: async () => actions.push("start"),
    stop: async () => actions.push("stop"),
    restart: async () => actions.push("restart"),
    restartAllRunning: async () => actions.push("restartAllRunning"),
    statusOf: async (config: { name: string }) => ({ ...config, state: "running", port: 4100, pid: 42, telegram: false }),
  } as unknown as Supervisor;
}

function stoppedSupervisor(actions: string[]): Supervisor {
  return {
    state: () => ({ state: "stopped" }),
    start: async () => actions.push("start"),
    stop: async () => actions.push("stop"),
    restart: async () => actions.push("restart"),
    statusOf: async (config: { name: string }) => ({ ...config, state: "stopped", port: 4100, telegram: false }),
  } as unknown as Supervisor;
}

test("GET /agents/:name/env devuelve solo las claves, nunca los valores", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "MY_SECRET", "top-secret-value", "agent");
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor([]));

    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /"keys":\["MY_SECRET"\]/);
    assert.doesNotMatch(body, /top-secret-value/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name/env de un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-env-"));
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor([]));
    const response = await app.request("http://pihub.test/agents/no-existe/env", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 404);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env reemplaza el conjunto y reinicia si el Runner corre", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "OLD_KEY", "old-value", "agent");
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ env: { NEW_KEY: "new-value" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { NEW_KEY: "new-value" });
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env con el MISMO conjunto no reinicia", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "SAME_KEY", "same-value", "agent");
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ env: { SAME_KEY: "same-value" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env con un Agent parado solo persiste, no arranca", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, stoppedSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ env: { SOME_KEY: "value" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { SOME_KEY: "value" });
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env rechaza una clave protegida con BAD_REQUEST y no persiste nada", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "KEEP_ME", "kept", "agent");
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));

    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ env: { API_TOKEN: "nope" } }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { KEEP_ME: "kept" });
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor([]));
    const response = await app.request("http://pihub.test/agents/agent/env", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: {} }),
    });
    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/env/:key fija una variable atómica y solo devuelve claves", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(actions));
    const response = await app.request("http://pihub.test/agents/agent/env/NEW_KEY", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ value: "secret-value" }),
    });
    const rawText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(rawText), { keys: ["NEW_KEY"] });
    assert.doesNotMatch(rawText, /secret-value/);
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { NEW_KEY: "secret-value" });
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("DELETE /agents/:name/env/:key elimina solo esa variable", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "REMOVE_ME", "secret", "agent");
    await setEnv(dataDir, "KEEP_ME", "keep", "agent");
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor([]));
    const response = await app.request("http://pihub.test/agents/agent/env/REMOVE_ME", {
      method: "DELETE",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { keys: ["KEEP_ME"] });
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { KEEP_ME: "keep" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("el store global de /api/v1/env está separado del Agent y opera por clave", async () => {
  const dataDir = await setup();
  try {
    await setEnv(dataDir, "AGENT_ONLY", "agent-secret", "agent");
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor([]));
    const put = await app.request("http://pihub.test/env/GLOBAL_KEY", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ value: "global-secret" }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { keys: ["GLOBAL_KEY"] });

    const get = await app.request("http://pihub.test/env", {
      headers: { authorization: "Bearer service-token" },
    });
    const getText = await get.text();
    assert.deepEqual(JSON.parse(getText), { keys: ["GLOBAL_KEY"] });
    assert.doesNotMatch(getText, /global-secret|agent-secret|AGENT_ONLY/);
    assert.deepEqual(await readEnvStore(dataDir), { GLOBAL_KEY: "global-secret" });

    const remove = await app.request("http://pihub.test/env/GLOBAL_KEY", {
      method: "DELETE",
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(remove.status, 200);
    assert.deepEqual(await remove.json(), { keys: [] });
    assert.deepEqual(await readEnvStore(dataDir), {});
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { AGENT_ONLY: "agent-secret" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
