import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { createAgent, updateAgent } from "../dist/agents.js";
import { createAgentSchema, updateAgentSchema } from "../dist/api.js";

async function testEnv() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-agents-"));
  await scaffoldGlobalDirs(dataDir);
  return { dataDir, agentPortRange: [4100, 4199], sharedMemoryDefault: "none", memoryEnabled: true };
}

async function readConfig(dataDir, name) {
  return JSON.parse(await fs.readFile(path.join(dataDir, "agents", name, "agent.json"), "utf8"));
}

test("createAgent sin override no materializa memory en agent.json", async () => {
  const env = await testEnv();
  await createAgent(env, { name: "sin-override" });
  const config = await readConfig(env.dataDir, "sin-override");
  assert.ok(!("memory" in config), "agent.json no debe llevar memory sin override");
});

test("createAgent con memory.sharedAccess lo persiste", async () => {
  const env = await testEnv();
  await createAgent(env, { name: "con-acceso", memory: { sharedAccess: "read" } });
  const config = await readConfig(env.dataDir, "con-acceso");
  assert.deepEqual(config.memory, { sharedAccess: "read" });
});

test("updateAgent cambia y elimina el override sin tocar otros campos", async () => {
  const env = await testEnv();
  await createAgent(env, { name: "mutable", ttsVoice: "ef_dora" });
  await updateAgent(env, "mutable", { memory: { sharedAccess: "read-write" } });
  let config = await readConfig(env.dataDir, "mutable");
  assert.deepEqual(config.memory, { sharedAccess: "read-write" });
  assert.equal(config.ttsVoice, "ef_dora");

  await updateAgent(env, "mutable", { memory: null });
  config = await readConfig(env.dataDir, "mutable");
  assert.ok(!("memory" in config), "memory: null debe eliminar el override");
  assert.equal(config.ttsVoice, "ef_dora");
});

test("schema create: acepta los 3 niveles y rechaza valores inválidos", () => {
  for (const sharedAccess of ["none", "read", "read-write"]) {
    const result = createAgentSchema.safeParse({ name: "a", memory: { sharedAccess } });
    assert.ok(result.success, `create debe aceptar ${sharedAccess}`);
  }
  assert.ok(!createAgentSchema.safeParse({ name: "a", memory: { sharedAccess: "all" } }).success);
  assert.ok(!createAgentSchema.safeParse({ name: "a", memory: null }).success, "create no admite memory: null");
});

test("schema update: admite memory: null para quitar el override", () => {
  assert.ok(updateAgentSchema.safeParse({ memory: null }).success);
  assert.ok(updateAgentSchema.safeParse({ memory: { sharedAccess: "read" } }).success);
  assert.ok(!updateAgentSchema.safeParse({ memory: { sharedAccess: "escribir" } }).success);
});
