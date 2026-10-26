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
import { writeChannelRecords } from "../dist/channels/store.js";
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

// Slice (c) part 2b, item 1 (tasks c-I12): `GET /agents/:name` is the single
// describe the Dashboard reconciles against, so the channel rows have to be
// readable without a second round trip to `…/channels`. The whitelist is
// OBSERVED state only — `kind`, `pairingState` (the binding), `externalChatId`,
// `observedStatus` (transport health), `lastError`, `lastSeenAt`. Everything
// that could carry a secret or a desired-state claim stays out:
// `token`, `tokenDigest`, the pairing code hash, and even `label`/`updatedAt`,
// which belong to `…/channels`.
test("GET /agents/:name incluye channels[] SOLO con los campos observados de la lista blanca", async () => {
  const dataDir = await setup();
  try {
    await writeChannelRecords(dataDir, "agent", [
      {
        kind: "telegram",
        label: "bot principal",
        tokenDigest: "a".repeat(64),
        observedStatus: "error",
        lastError: "401 Unauthorized",
        lastSeenAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      },
    ]);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(body.channels, [
      {
        kind: "telegram",
        // Sin vínculo de pairing, el estado del BINDING es "unpaired" aunque la
        // marca del transporte esté en "error": dos hechos distintos (I3).
        pairingState: "unpaired",
        externalChatId: null,
        observedStatus: "error",
        lastError: "401 Unauthorized",
        lastSeenAt: 1_700_000_000_000,
      },
    ]);

    // Ningún secreto ni huella: la proyección observada no puede servir para
    // comparar tokens por fuera del Manager.
    assert.equal(raw.includes("a".repeat(64)), false);
    assert.doesNotMatch(raw, /tokenDigest/);
    assert.doesNotMatch(raw, /pairingCodeHash/);
    assert.doesNotMatch(raw, /"label"/);
    assert.doesNotMatch(raw, /"updatedAt"/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// I2 en la superficie describe: un Agent sin canales reporta `[]`, nunca
// `undefined` — el dashboard diferencia "sin canales" de "campo no implementado".
test("GET /agents/:name sin canales reporta channels: [] (nunca undefined)", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.channels));
    assert.deepEqual(body.channels, []);
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
