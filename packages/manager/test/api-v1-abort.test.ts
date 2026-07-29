import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// Bug 3: abortSignal está en createTurnV1Schema y nunca se lee — no hay
// forma de cortar un turno en curso desde /api/v1. El envío real del
// mensaje {type:"abort"} por el WS del Runner requiere un Runner de verdad
// (contract-red, contra el Manager real); estos dos casos —Agent
// inexistente y turno no vivo— no necesitan WS y se prueban aquí.

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-abort-"));
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
  } as unknown as Supervisor;
}

test("POST /agents/:name/turns/:turnId/abort en un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-abort-"));
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/no-existe/turns/turn-1/abort", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/turns/:turnId/abort de un turno que no está vivo da TURN_NOT_FOUND", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    // Ningún turno se registró como vivo: ni se creó por POST /turns, ni ya
    // terminó y se limpió del registro.
    const response = await app.request("http://pihub.test/agents/agent/turns/turn-fantasma/abort", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "TURN_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/turns/:turnId/abort exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent/turns/turn-1/abort", {
      method: "POST",
    });

    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
