import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPaths, resolveRunnerEnv, setEnv } from "@pihub/shared";
import { runnerEnvFor } from "../dist/supervisor.js";

test("runnerEnvFor conserva stores e internas, pero no el entorno del Manager", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-supervisor-env-"));
  try {
    await setEnv(dataDir, "GLOBAL_ONLY", "global-value");
    await setEnv(dataDir, "SHARED_VALUE", "global-value");
    await setEnv(dataDir, "SHARED_VALUE", "agent-value", "agent");
    await setEnv(dataDir, "AGENT_ONLY", "agent-only-value", "agent");

    const storeEnv = await resolveRunnerEnv(dataDir, "agent", {
      API_TOKEN: "manager-service-secret",
      CONTAINER_SECRET: "arbitrary-container-secret",
      PATH: "/usr/bin",
      HOME: "/home/pihub",
      LANG: "C.UTF-8",
      TZ: "UTC",
      PIHUB_DATA_DIR: "/wrong/data",
      PIHUB_AGENT_NAME: "wrong-agent",
      PI_CODING_AGENT_DIR: "/wrong/global",
      PI_CODING_AGENT_SESSION_DIR: "/wrong/sessions",
      PIHUB_GLOBAL_MEMORY_DIR: "/wrong/memory",
    });
    const runnerEnv = runnerEnvFor(
      storeEnv,
      { dataDir, memoryEnabled: true, sharedMemoryDefault: "none" },
      { name: "agent", port: 4100, enabled: true, createdAt: "2026-08-01T00:00:00.000Z" },
    );

    assert.equal(runnerEnv.API_TOKEN, undefined);
    assert.equal(runnerEnv.CONTAINER_SECRET, undefined);
    assert.equal(runnerEnv.GLOBAL_ONLY, "global-value");
    assert.equal(runnerEnv.SHARED_VALUE, "agent-value");
    assert.equal(runnerEnv.AGENT_ONLY, "agent-only-value");
    assert.equal(runnerEnv.PIHUB_DATA_DIR, dataDir);
    assert.equal(runnerEnv.PIHUB_AGENT_NAME, "agent");
    assert.equal(runnerEnv.PI_CODING_AGENT_DIR, dataPaths(dataDir).globalDir);
    assert.equal(
      runnerEnv.PI_CODING_AGENT_SESSION_DIR,
      path.join(dataPaths(dataDir).agentsDir, "agent", "sessions"),
    );
    assert.equal(
      runnerEnv.PIHUB_AGENT_MEMORY_DIR,
      path.join(dataDir, "agents", "agent", "memory"),
    );
    assert.equal(runnerEnv.PIHUB_SHARED_MEMORY_ACCESS, "none");
    assert.equal(runnerEnv.PIHUB_GLOBAL_MEMORY_DIR, undefined);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
