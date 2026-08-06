import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { RuntimeProviders } from "@pihub/providers";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";

// §1.3 del plan: GET /models (catálogo con `configured`) y GET /status
// (estado global, SIN portRange — spec §7 prohíbe exponer topología
// interna de puertos).

function fakeSupervisor(): Supervisor {
  return { state: () => ({ state: "stopped" }) } as unknown as Supervisor;
}

// Providers cuyo catálogo NO se puede leer: snapshot() siempre lanza.
// Las rutas GET /models y GET /providers solo llaman a snapshot(), así
// que el resto de métodos pueden no existir (cast estructural).
function brokenProviders(): RuntimeProviders {
  return {
    snapshot: async () => {
      throw new Error("boom");
    },
  } as unknown as RuntimeProviders;
}

// Variante con mensaje de error controlable: permite simular un ENOENT real
// cuyo texto lleva rutas internas del filesystem, para verificar que el
// envelope de error nunca las filtra al cliente.
function brokenProvidersWith(message: string): RuntimeProviders {
  return {
    snapshot: async () => {
      throw new Error(message);
    },
  } as unknown as RuntimeProviders;
}

// Catálogo legítimamente vacío: snapshot() resuelve (no lanza) con arrays
// vacíos. Es el otro lado del contrato: 200 con lista vacía debe seguir
// significando "catálogo vacío de verdad", no un fallo disfrazado.
function emptyProviders(): RuntimeProviders {
  return {
    snapshot: async () => ({
      models: [],
      providers: [],
      oauthProviders: [],
      configurationIssues: [],
    }),
  } as unknown as RuntimeProviders;
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

test("PUT /managed/providers exige Bearer de servicio y preserva Providers standalone", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-managed-providers-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    const payload = {
      providers: [{
        id: "managed",
        baseUrl: "http://127.0.0.1:9997/v1",
        models: [{ id: "managed-model", name: "Managed Model" }],
        apiKey: "managed-secret",
      }],
    };
    const cookieAttempt = await app.request("http://pihub.test/managed/providers", {
      method: "PUT",
      headers: {
        cookie: "pihub_token=service-token; pihub_csrf=csrf",
        "x-csrf-token": "csrf",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(cookieAttempt.status, 401);
    assert.equal((await cookieAttempt.json()).code, "INVALID_AUTH");

    const serviceAttempt = await app.request("http://pihub.test/managed/providers", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(serviceAttempt.status, 200);
    const observed = await serviceAttempt.json();
    assert.equal(observed.providers[0].origin, "managed");
    assert.equal(JSON.stringify(observed).includes("managed-secret"), false);

    const removed = await app.request("http://pihub.test/managed/providers", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ providers: [] }),
    });
    assert.deepEqual(await removed.json(), { providers: [] });
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

test("GET /status y GET /health reportan la version del package.json de @pihub/manager", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-version-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());
    // `../package.json` desde test/ = packages/manager/package.json.
    const pkgVersion = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ).version as string;

    const status = await app.request("http://pihub.test/status", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const statusBody = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusBody.version, pkgVersion);

    const health = await app.request("http://pihub.test/health", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.version, pkgVersion);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /models devuelve 503 RESOURCE_UNAVAILABLE si el catalogo de Providers no se puede leer (no un array vacio disfrazado)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    // oauth no participa en GET /models: `undefined` es seguro y permite
    // inyectar el providers roto como 4º argumento.
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      undefined as unknown as OAuthService,
      brokenProviders(),
    );

    const response = await app.request("http://pihub.test/models", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
    assert.equal(typeof body.correlationId, "string");
    // El envelope de error NO puede colarse con un array vacío disfrazado:
    // si snapshot() falla, la clave "models" no debe existir en absoluto.
    assert.equal("models" in body, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /providers devuelve 503 RESOURCE_UNAVAILABLE si el catalogo de Providers no se puede leer", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-providers-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    // oauth no participa en GET /providers: `undefined` es seguro y permite
    // inyectar el providers roto como 4º argumento.
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      undefined as unknown as OAuthService,
      brokenProviders(),
    );

    const response = await app.request("http://pihub.test/providers", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
    assert.equal(typeof body.correlationId, "string");
    // Igual que en /models: un error real no debe viajar con `providers: []`.
    assert.equal("providers" in body, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("un fallo de catalogo no filtra rutas internas en el envelope de error", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    // oauth no participa en GET /models: `undefined` es seguro y permite
    // inyectar el providers roto como 4º argumento.
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      undefined as unknown as OAuthService,
      brokenProvidersWith(`ENOENT: no such file or directory, open ${dataDir}/global/models.json`),
    );

    const response = await app.request("http://pihub.test/models", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
    assert.equal(typeof body.correlationId, "string");
    // El envelope de error NO puede colarse con rutas internas: ni el mensaje
    // del error (que contiene el dataDir) ni el dataDir temporal pueden
    // aparecer en el body serializado.
    assert.equal(JSON.stringify(body).includes(dataDir), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("un catalogo legitimamente vacio devuelve 200 con models vacio, no un error", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-models-"));
  try {
    await scaffoldGlobalDirs(dataDir);
    // oauth no participa en GET /models: `undefined` es seguro y permite
    // inyectar el providers vacío como 4º argumento.
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      undefined as unknown as OAuthService,
      emptyProviders(),
    );

    const response = await app.request("http://pihub.test/models", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.models, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
