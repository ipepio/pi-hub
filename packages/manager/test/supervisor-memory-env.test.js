import test from "node:test";
import assert from "node:assert/strict";
import { memoryEnvFor } from "../dist/supervisor.js";

const env = { dataDir: "/data", memoryEnabled: true, sharedMemoryDefault: "none" };
const agent = (memory) => ({ name: "bot", memory });

test("none: acceso none y sin PIHUB_GLOBAL_MEMORY_DIR", () => {
  const memEnv = memoryEnvFor(env, agent(undefined));
  assert.equal(memEnv.PIHUB_SHARED_MEMORY_ACCESS, "none");
  assert.ok(!("PIHUB_GLOBAL_MEMORY_DIR" in memEnv));
  assert.equal(memEnv.PIHUB_AGENT_MEMORY_DIR, "/data/agents/bot/memory");
});

test("read y read-write inyectan el dir compartido", () => {
  for (const access of ["read", "read-write"]) {
    const memEnv = memoryEnvFor(env, agent({ sharedAccess: access }));
    assert.equal(memEnv.PIHUB_SHARED_MEMORY_ACCESS, access);
    assert.equal(memEnv.PIHUB_GLOBAL_MEMORY_DIR, "/data/global/memory");
  }
});

test("el override del agente gana al default de runtime y viceversa", () => {
  const readByDefault = { ...env, sharedMemoryDefault: "read" };
  assert.equal(memoryEnvFor(readByDefault, agent(undefined)).PIHUB_SHARED_MEMORY_ACCESS, "read");
  assert.equal(memoryEnvFor(readByDefault, agent({ sharedAccess: "none" })).PIHUB_SHARED_MEMORY_ACCESS, "none");
});

test("con memoria deshabilitada se fuerza none aunque haya override", () => {
  const disabled = { ...env, memoryEnabled: false };
  const memEnv = memoryEnvFor(disabled, agent({ sharedAccess: "read-write" }));
  assert.equal(memEnv.PIHUB_SHARED_MEMORY_ACCESS, "none");
  assert.ok(!("PIHUB_GLOBAL_MEMORY_DIR" in memEnv));
});
