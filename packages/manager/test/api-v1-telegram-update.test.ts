import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgent, scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { Supervisor as RealSupervisor } from "../dist/supervisor.js";
import type { Supervisor } from "../src/supervisor.ts";

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-telegram-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    telegramToken: "old-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function runningSupervisor(restarts: string[]): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    restart: async (name: string) => {
      restarts.push(name);
    },
    stop: async () => {},
    statusOf: async (config: { name: string; telegramToken?: string }) => {
      const { telegramToken: _telegramToken, ...safe } = config;
      return {
        ...safe,
        state: "running",
        port: 4100,
        pid: 42,
        telegram: Boolean(config.telegramToken),
      };
    },
  } as unknown as Supervisor;
}

function stoppedSupervisor(actions: string[]): Supervisor {
  return {
    state: () => ({ state: "stopped" }),
    start: async () => {
      actions.push("start");
    },
    restart: async () => {
      actions.push("restart");
    },
    stop: async () => {
      actions.push("stop");
    },
    statusOf: async (config: { name: string; telegramToken?: string }) => {
      const { telegramToken: _telegramToken, ...safe } = config;
      return {
        ...safe,
        state: "stopped",
        port: 4100,
        telegram: Boolean(config.telegramToken),
      };
    },
  } as unknown as Supervisor;
}

test("statusOf nunca proyecta el token de Telegram y conserva el booleano", async () => {
  const status = await new RealSupervisor({ dataDir: "/data" }).statusOf({
    name: "agent",
    port: 4100,
    telegramToken: "secret-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal("telegramToken" in status, false);
  assert.equal(status.telegram, true);
});

test("PATCH /agents/:name con el mismo telegramToken no reinicia el Runner", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const supervisor = runningSupervisor(restarts);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, supervisor);

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ telegramToken: "old-token" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.telegramToken, "old-token");
    assert.deepEqual(restarts, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name acepta telegramToken para un Agent existente", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const supervisor = runningSupervisor(restarts);
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, supervisor);

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ telegramToken: "new-token" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.telegramToken, "new-token");
    assert.deepEqual(restarts, ["agent"]);
    assert.doesNotMatch(await response.text(), /new-token/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name sin telegramToken no reinicia el Runner", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      runningSupervisor(restarts),
    );

    // Cuerpo vacío a propósito, no `{model: "new-model"}` como antes: con la
    // huella de arranque (restart-policy.ts) un cambio de MODEL sí reinicia
    // —es el bug 1 que se acaba de arreglar—, así que usarlo como "campo
    // irrelevante" haría que este test afirmara justo lo contrario de lo que
    // ahora es correcto. Lo que este test verifica es que un PATCH sin
    // ningún campo no reinicia por sí solo.
    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.telegramToken, "old-token");
    assert.deepEqual(restarts, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name de un Agent parado nunca lo arranca", async () => {
  const cases = [
    { name: "mismo token", payload: { telegramToken: "old-token" } },
    { name: "token distinto", payload: { telegramToken: "new-token" } },
    { name: "token quitado", payload: { telegramToken: null } },
    { name: "campo omitido", payload: { model: "new-model" } },
  ] as const;

  for (const currentCase of cases) {
    const dataDir = await setup();
    try {
      const actions: string[] = [];
      const app = createApiV1Router(
        { dataDir, apiToken: "service-token" },
        stoppedSupervisor(actions),
      );

      const response = await app.request("http://pihub.test/agents/agent", {
        method: "PATCH",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(currentCase.payload),
      });

      assert.equal(response.status, 200, currentCase.name);
      assert.deepEqual(actions, [], currentCase.name);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("PATCH /agents/:name con telegramToken null quita el bot y reinicia el Runner", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const app = createApiV1Router(
      { dataDir, apiToken: "service-token" },
      runningSupervisor(restarts),
    );

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ telegramToken: null }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal((await readAgent(dataDir, "agent"))?.telegramToken, undefined);
    assert.deepEqual(restarts, ["agent"]);
    assert.match(body, /"telegram":false/);
    assert.doesNotMatch(body, /telegramToken/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
