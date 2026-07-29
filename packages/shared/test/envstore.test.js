import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRunnerEnv, setEnv } from "../dist/envstore.js";

test("resolveRunnerEnv no hereda secretos ni variables arbitrarias del contenedor", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await setEnv(dataDir, "GLOBAL_ONLY", "global-value");
    await setEnv(dataDir, "SHARED_VALUE", "global-value");
    await setEnv(dataDir, "SHARED_VALUE", "agent-value", "agent");
    await setEnv(dataDir, "AGENT_ONLY", "agent-only-value", "agent");

    const runnerEnv = await resolveRunnerEnv(dataDir, "agent", {
      API_TOKEN: "manager-service-secret",
      CONTAINER_SECRET: "arbitrary-container-secret",
      PATH: "/usr/bin",
      HOME: "/home/pihub",
      LANG: "C.UTF-8",
      TZ: "UTC",
    });

    assert.equal(runnerEnv.API_TOKEN, undefined);
    assert.equal(runnerEnv.CONTAINER_SECRET, undefined);
    assert.equal(runnerEnv.GLOBAL_ONLY, "global-value");
    assert.equal(runnerEnv.SHARED_VALUE, "agent-value");
    assert.equal(runnerEnv.AGENT_ONLY, "agent-only-value");
    assert.equal(runnerEnv.PATH, "/usr/bin");
    assert.equal(runnerEnv.HOME, "/home/pihub");
    assert.equal(runnerEnv.LANG, "C.UTF-8");
    assert.equal(runnerEnv.TZ, "UTC");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
