import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvStore, replaceEnvStore, resolveRunnerEnv, setEnv } from "../dist/envstore.js";

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

test("replaceEnvStore reemplaza el store completo, no lo mezcla con el anterior", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await setEnv(dataDir, "OLD_KEY", "old-value", "agent");

    await replaceEnvStore(dataDir, { NEW_KEY: "new-value" }, "agent");

    const store = await readEnvStore(dataDir, "agent");
    assert.deepEqual(store, { NEW_KEY: "new-value" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("replaceEnvStore con {} vacía el store del Agent", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await setEnv(dataDir, "OLD_KEY", "old-value", "agent");

    await replaceEnvStore(dataDir, {}, "agent");

    assert.deepEqual(await readEnvStore(dataDir, "agent"), {});
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("replaceEnvStore rechaza una clave protegida y no escribe NADA", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await setEnv(dataDir, "KEEP_ME", "kept", "agent");

    await assert.rejects(() => replaceEnvStore(dataDir, { KEEP_ME: "x", API_TOKEN: "nope" }, "agent"));

    // Ni siquiera KEEP_ME (válida) se tocó: la validación es de TODO el
    // conjunto antes de escribir, no clave a clave.
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { KEEP_ME: "kept" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("replaceEnvStore rechaza un nombre de clave inválido", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await assert.rejects(() => replaceEnvStore(dataDir, { "no-valido": "x" }, "agent"));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("replaceEnvStore no toca el store GLOBAL cuando se pasa un agentName", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-envstore-"));
  try {
    await setEnv(dataDir, "GLOBAL_KEY", "global-value");

    await replaceEnvStore(dataDir, { AGENT_KEY: "agent-value" }, "agent");

    assert.deepEqual(await readEnvStore(dataDir), { GLOBAL_KEY: "global-value" });
    assert.deepEqual(await readEnvStore(dataDir, "agent"), { AGENT_KEY: "agent-value" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
