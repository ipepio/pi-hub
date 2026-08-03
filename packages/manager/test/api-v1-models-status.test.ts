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

test("GET /models conserva un contrato seguro por Model", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/models", {
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    for (const model of body.models) {
      assert.deepEqual(Object.keys(model).sort(), ["configured", "id", "name", "provider"]);
      assert.equal(JSON.stringify(model).includes(dataDir), false);
    }
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

test("GET /providers publica el catálogo first-class sin secretos ni paths", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-providers-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const response = await app.request("http://pihub.test/providers", {
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.providers), true);
    for (const provider of body.providers) {
      assert.equal(typeof provider.id, "string");
      assert.equal(["built_in", "models_json", "managed", "extension"].includes(provider.origin), true);
      assert.equal(["connected", "missing_credentials", "error"].includes(provider.status), true);
      assert.equal(JSON.stringify(provider).includes(dataDir), false);
      assert.equal(JSON.stringify(provider).includes("auth.json"), false);
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("custom Provider se actualiza y borra por la Interface HTTP sin devolver su API key", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-custom-provider-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const put = await app.request("http://pihub.test/providers/custom/acme", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:9998/v1",
        models: [{ id: "acme-model", name: "Acme Model" }],
        apiKey: "acme-secret",
      }),
    });
    const putBody = await put.json();

    assert.equal(put.status, 200);
    assert.equal(putBody.provider.id, "acme");
    assert.equal(JSON.stringify(putBody).includes("acme-secret"), false);
    assert.equal(
      (await fs.readFile(path.join(dataDir, "global", "models.json"), "utf8")).includes("acme-secret"),
      false,
    );
    assert.equal(
      (await fs.readFile(path.join(dataDir, "global", "auth.json"), "utf8")).includes("acme-secret"),
      true,
    );

    const remove = await app.request("http://pihub.test/providers/custom/acme", {
      method: "DELETE",
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(remove.status, 200);
    assert.deepEqual(await remove.json(), { ok: true });
    const listed = await app.request("http://pihub.test/providers", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal((await listed.json()).providers.some((provider: { id: string }) => provider.id === "acme"), false);
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
