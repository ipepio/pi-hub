import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// §1.3 del plan: GET /models (catálogo con `configured`) y GET /status
// (estado global, SIN portRange — spec §7 prohíbe exponer topología
// interna de puertos).

function fakeSupervisor(): Supervisor {
  return { state: () => ({ state: "stopped" }) } as unknown as Supervisor;
}

test("GET /models devuelve un catálogo (array), incluso sin credenciales configuradas", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/models", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.models), true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /models exige la credencial de servicio", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/models", { method: "GET" });
    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /status devuelve version/agents/panel y NUNCA portRange", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-status-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token", panelEnabled: true },
      fakeSupervisor(),
    );

    const response = await app.request("http://pihub.test/status", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.agents, 0);
    assert.equal(body.panel, true);
    assert.equal(typeof body.version, "string");
    assert.equal("portRange" in body, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /status exige la credencial de servicio", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-status-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/status", { method: "GET" });
    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
