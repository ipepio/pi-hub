import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// §1.3 del plan: GET/PUT /agents/:name/packages — conjunto COMPLETO,
// converge con `pi install`/`pi remove`. Instalar/quitar de verdad requiere
// el binario `pi` y red — eso se verifica con contract-red (§1.5), no aquí.
// Estos tests cubren las rutas de guardia: 404, 400, auth y el camino
// "sin diferencia" (no toca pi ni el registro de turnos).

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-packages-"));
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

function fakeSupervisor(): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    restart: async () => {
      throw new Error("no debía reiniciar: no había diferencia de paquetes");
    },
  } as unknown as Supervisor;
}

test("GET /agents/:name/packages devuelve la lista actual (vacía en un Agent nuevo)", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/agents/agent/packages", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { packages: [] });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name/packages de un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-packages-"));
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/agents/no-existe/packages", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 404);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/packages con el MISMO conjunto no toca pi ni reinicia", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/agents/agent/packages", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ packages: [] }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { packages: [] });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/packages rechaza un payload sin el campo packages", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/agents/agent/packages", {
      method: "PUT",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT /agents/:name/packages exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/agents/agent/packages", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packages: [] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
