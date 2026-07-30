import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

const SKILL_ID = "0d1c80cf-7889-4ab6-9a5c-8d5b32b3b530";

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-skills-"));
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

function stoppedSupervisor(): Supervisor {
  return {
    state: () => ({ state: "stopped" }),
  } as unknown as Supervisor;
}

test("GET de Skills por contenido lista solo skillIds, nunca paths persistentes", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, stoppedSupervisor());
    const local = await app.request("http://pihub.test/agents/agent/skills", {
      headers: { authorization: "Bearer service-token" },
    });
    const global = await app.request("http://pihub.test/skills", {
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(local.status, 200);
    assert.deepEqual(await local.json(), { skills: [] });
    assert.equal(global.status, 200);
    assert.deepEqual(await global.json(), { skills: [] });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST de Skill exige skillId UUID y contenido, sin reinterpretar el endpoint de packages", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, stoppedSupervisor());
    const response = await app.request("http://pihub.test/agents/agent/skills", {
      method: "POST",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ skillId: SKILL_ID }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "BAD_REQUEST");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST local resuelve Agent inexistente antes de consumir contenido", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, stoppedSupervisor());
    const response = await app.request("http://pihub.test/agents/no-existe/skills", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "multipart/form-data; boundary=not-read",
      },
      body: "body que no se debe parsear",
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
