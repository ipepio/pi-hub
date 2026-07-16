import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldGlobalDirs } from "@pihub/shared";
import { provisionAgents } from "../dist/provision.js";

async function setup(manifest) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-provision-"));
  await scaffoldGlobalDirs(dataDir);
  const agentsFile = path.join(dataDir, "agents.json");
  await fs.writeFile(agentsFile, JSON.stringify(manifest), "utf8");
  return {
    env: { dataDir, agentsFile, agentPortRange: [4100, 4199], sharedMemoryDefault: "none", memoryEnabled: true },
    async writeManifest(next) {
      await fs.writeFile(agentsFile, JSON.stringify(next), "utf8");
    },
    async readConfig(name) {
      return JSON.parse(await fs.readFile(path.join(dataDir, "agents", name, "agent.json"), "utf8"));
    },
  };
}

test("el manifiesto crea el agente con su override de memoria", async () => {
  const ctx = await setup({ agents: [{ name: "prov", memory: { sharedAccess: "read" } }] });
  await provisionAgents(ctx.env);
  assert.deepEqual((await ctx.readConfig("prov")).memory, { sharedAccess: "read" });
});

test("segunda pasada idempotente y cambio de sharedAccess aplica patch", async () => {
  const ctx = await setup({ agents: [{ name: "prov", memory: { sharedAccess: "read" } }] });
  await provisionAgents(ctx.env);
  const first = await ctx.readConfig("prov");
  await provisionAgents(ctx.env);
  assert.deepEqual(await ctx.readConfig("prov"), first, "sin cambios en el manifiesto no debe tocar nada");

  await ctx.writeManifest({ agents: [{ name: "prov", memory: { sharedAccess: "read-write" } }] });
  await provisionAgents(ctx.env);
  assert.deepEqual((await ctx.readConfig("prov")).memory, { sharedAccess: "read-write" });
});

test("manifiesto sin memory no resetea un override existente", async () => {
  const ctx = await setup({ agents: [{ name: "prov", memory: { sharedAccess: "read" } }] });
  await provisionAgents(ctx.env);
  await ctx.writeManifest({ agents: [{ name: "prov", model: "anthropic/claude-sonnet-5" }] });
  await provisionAgents(ctx.env);
  const config = await ctx.readConfig("prov");
  assert.deepEqual(config.memory, { sharedAccess: "read" }, "el override debe sobrevivir");
  assert.equal(config.model, "anthropic/claude-sonnet-5");
});
