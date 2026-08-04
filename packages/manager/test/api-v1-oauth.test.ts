import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";

function fakeSupervisor(): Supervisor {
  return { state: () => ({ state: "stopped" }) } as unknown as Supervisor;
}

function fakeOAuth(): OAuthService {
  const flow = {
    id: "flow-1",
    provider: "anthropic",
    phase: "input",
    message: "code",
  } as const;
  return {
    providers: () => [{ id: "anthropic", name: "Anthropic", loggedIn: false }],
    startLogin: (provider: string) => ({ ...flow, provider }),
    getFlow: (id: string) => (id === flow.id ? flow : undefined),
    submitInput: (id: string, value: string) => ({ ...flow, id, value }),
    logout: (provider: string) => {
      assert.equal(provider, "anthropic");
    },
  } as unknown as OAuthService;
}

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-oauth-"));
  await scaffoldGlobalDirs(dataDir);
  return dataDir;
}

function headers() {
  return { authorization: "Bearer service-token", "content-type": "application/json" };
}

function fakeOAuthQueFalla(mensaje: string): OAuthService {
  return {
    providers: () => [{ id: "anthropic", name: "Anthropic", loggedIn: false }],
    startLogin: () => {
      throw new Error(mensaje);
    },
    getFlow: () => undefined,
    submitInput: () => {
      throw new Error(mensaje);
    },
    logout: () => {},
  } as unknown as OAuthService;
}

test("/api/v1/auth/providers conserva el catálogo del OAuthService", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(), fakeOAuth());
    const response = await app.request("http://pihub.test/auth/providers", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      providers: [{ id: "anthropic", name: "Anthropic", loggedIn: false }],
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("/api/v1/auth conserva login, consulta de flow, input y logout", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(), fakeOAuth());
    const login = await app.request("http://pihub.test/auth/login/anthropic", {
      method: "POST",
      headers: headers(),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).id, "flow-1");

    const flow = await app.request("http://pihub.test/auth/flows/flow-1", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(flow.status, 200);
    assert.equal((await flow.json()).provider, "anthropic");

    const input = await app.request("http://pihub.test/auth/flows/flow-1/input", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ value: "123" }),
    });
    assert.equal(input.status, 200);
    assert.equal((await input.json()).value, "123");

    const logout = await app.request("http://pihub.test/auth/logout/anthropic", {
      method: "POST",
      headers: headers(),
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("/api/v1/auth/flows inexistente conserva 404", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(), fakeOAuth());
    const response = await app.request("http://pihub.test/auth/flows/no-existe", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "No existe" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("/api/v1/auth/login/:provider devuelve el envelope estándar y no filtra rutas internas cuando falla", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      fakeOAuthQueFalla(`ENOENT: no such file or directory, open ${dataDir}/global/auth.json`),
    );
    const response = await app.request("http://pihub.test/auth/login/anthropic", {
      method: "POST",
      headers: headers(),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "BAD_REQUEST");
    assert.equal(typeof body.correlationId, "string");
    assert.equal(JSON.stringify(body).includes(dataDir), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("/api/v1/auth/flows/:id/input devuelve el envelope estándar y no filtra rutas internas cuando falla", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      fakeSupervisor(),
      fakeOAuthQueFalla(`ENOENT: no such file or directory, open ${dataDir}/global/auth.json`),
    );
    const response = await app.request("http://pihub.test/auth/flows/flow-1/input", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ value: "123" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "BAD_REQUEST");
    assert.equal(typeof body.correlationId, "string");
    assert.equal(JSON.stringify(body).includes(dataDir), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
