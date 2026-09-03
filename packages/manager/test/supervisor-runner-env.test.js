import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dataPaths,
  resolveRunnerEnv,
  scaffoldAgentDirs,
  setEnv,
  writeAgent,
} from "@pihub/shared";
import { runnerEnvFor, Supervisor } from "../dist/supervisor.js";

test("runnerEnvFor inyecta API_TOKEN cuando env.apiToken está seteado y lo omite cuando vacío", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-supervisor-env-"),
  );
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
    const callbackToken = "ab".repeat(32);
    const runnerEnv = runnerEnvFor(
      storeEnv,
      {
        dataDir,
        apiToken: "cd".repeat(32),
        managerPort: 4567,
        memoryEnabled: true,
        sharedMemoryDefault: "none",
        telegramAllowedUsers: [],
      },
      {
        name: "agent",
        port: 4100,
        enabled: true,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      callbackToken,
    );

    // The service credential is the Runner's inbound-auth secret AND the one
    // the governed tools forward to the Manager; it must be present so
    // `loadEnv()` in the runner captures it into `env.apiToken` (the boot
    // scrub removes it from process.env afterwards, R1-001).
    assert.equal(runnerEnv.API_TOKEN, "cd".repeat(32));
    assert.equal(runnerEnv.PIHUB_RUNNER_CALLBACK_TOKEN, callbackToken);
    assert.equal(runnerEnv.PIHUB_MANAGER_PORT, "4567");
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

test("runnerEnvFor propaga la allowlist de Telegram al env del Runner", () => {
  const storeEnv = {};
  const callbackToken = "ef".repeat(32);
  const runnerEnv = runnerEnvFor(
    {
      ...storeEnv,
      PIHUB_RUNNER_CALLBACK_TOKEN: "00".repeat(32),
      PIHUB_MANAGER_PORT: "4000",
    },
    {
      dataDir: "/data",
      managerPort: 4789,
      memoryEnabled: true,
      sharedMemoryDefault: "none",
      telegramAllowedUsers: [111, 222],
    },
    {
      name: "agent",
      port: 4100,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    callbackToken,
  );
  // apiToken ausente (vacío) → API_TOKEN no se compone al env del Runner.
  assert.equal(runnerEnv.API_TOKEN, undefined);
  assert.equal(runnerEnv.PIHUB_TELEGRAM_ALLOWED_USERS, "111,222");
  assert.equal(runnerEnv.PIHUB_RUNNER_CALLBACK_TOKEN, callbackToken);
  assert.equal(runnerEnv.PIHUB_MANAGER_PORT, "4789");
});

async function writeRunnableAgent(dataDir, name) {
  await scaffoldAgentDirs(dataDir, name);
  await writeAgent(dataDir, {
    name,
    port: 0,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
}

test("runner callback token is agent-scoped, rotates, and is revoked on stop or exit", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-supervisor-callback-"),
  );
  const alphaFirst = "11".repeat(32);
  const betaFirst = "22".repeat(32);
  const alphaSecond = "33".repeat(32);
  const issuedTokens = [alphaFirst, betaFirst, alphaSecond];
  const supervisor = new Supervisor(
    {
      dataDir,
      apiToken: "44".repeat(32),
      managerPort: 4891,
      memoryEnabled: true,
      sharedMemoryDefault: "none",
      telegramAllowedUsers: [],
    },
    () => issuedTokens.shift(),
  );

  try {
    await writeRunnableAgent(dataDir, "alpha");
    await writeRunnableAgent(dataDir, "beta");
    await supervisor.start("alpha");
    await supervisor.start("beta");

    assert.equal(supervisor.verifyCallbackToken(alphaFirst), "alpha");
    assert.equal(supervisor.verifyCallbackToken(betaFirst), "beta");
    assert.notEqual(supervisor.verifyCallbackToken(alphaFirst), "beta");
    assert.equal(supervisor.verifyCallbackToken("44".repeat(32)), undefined);

    for (const malformed of [
      undefined,
      null,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      Buffer.alloc(32),
    ]) {
      assert.doesNotThrow(() => supervisor.verifyCallbackToken(malformed));
      assert.equal(supervisor.verifyCallbackToken(malformed), undefined);
    }

    await supervisor.restart("alpha");
    assert.equal(issuedTokens.length, 0);
    assert.notEqual(alphaFirst, alphaSecond);
    assert.equal(supervisor.verifyCallbackToken(alphaFirst), undefined);
    assert.equal(supervisor.verifyCallbackToken(alphaSecond), "alpha");
    assert.equal(supervisor.verifyCallbackToken(betaFirst), "beta");

    await supervisor.stop("beta");
    assert.equal(supervisor.verifyCallbackToken(betaFirst), undefined);

    const alphaManaged = supervisor.processes.get("alpha");
    assert.ok(alphaManaged);
    alphaManaged.intentionalStop = true;
    const alphaExit = once(alphaManaged.proc, "exit");
    alphaManaged.proc.kill("SIGKILL");
    await alphaExit;
    assert.equal(supervisor.verifyCallbackToken(alphaSecond), undefined);
  } finally {
    await supervisor.stopAll();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
