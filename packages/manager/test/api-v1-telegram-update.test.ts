import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAgent,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
  type AgentConfig,
} from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { Supervisor as RealSupervisor } from "../dist/supervisor.js";
import { writeChannelRecords } from "../dist/channels/store.js";
import type { Supervisor } from "../src/supervisor.ts";

// Cutover (channels-and-mcp, slice (c) part 3b, proposal R3).
//
// Este fichero era LA prueba de que `telegramToken` movía el Runner: rotar el
// token reiniciaba, quitarlo reiniciaba, y el booleano `telegram` salía del
// config. Ese contrato caducó: el bot de Telegram ahora es del Manager
// (`channels/registry.ts`) y lo que mueve la huella de arranque es el canal
// proyectado (`restart-policy.ts: channels`), no un secreto del Agent.
//
// Lo que sigue vivo aquí es el contrato que el corte NO toca:
// - un secreto jamás sale por la API (redacción de `statusOf`);
// - un Agent parado nunca se arranca solo por un PATCH;
// - la deprecación es TOLERANTE: un caller que siga mandando `telegramToken`
//   recibe 200, no un 400 en medio de un reconcile (ventana de un release, R10),
//   pero el campo no escribe nada.

async function setup(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-telegram-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    // Residuo de antes del corte: un `agent.json` real aún puede tenerlo.
    telegramToken: "old-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function statusOfFake(state: "running" | "stopped") {
  return async (config: AgentConfig) => {
    // Espejo de `Supervisor.statusOf`: el token se redacta SIEMPRE.
    const { telegramToken: _telegramToken, ...safe } = config;
    return {
      ...safe,
      state,
      port: config.port,
      pid: state === "running" ? 42 : undefined,
      // Desde el corte, `telegram` viene del registro de canal, y aquí no hay
      // ningún canal proyectado.
      telegram: false,
    };
  };
}

function runningSupervisor(restarts: string[]): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    restart: async (name: string) => {
      restarts.push(name);
    },
    stop: async () => {},
    statusOf: statusOfFake("running"),
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
    statusOf: statusOfFake("stopped"),
  } as unknown as Supervisor;
}

function patch(dataDir: string, supervisor: Supervisor, body: unknown) {
  const app = createApiV1Router({ dataDir, apiToken: "service-token" }, supervisor);
  return app.request("http://pihub.test/agents/agent", {
    method: "PATCH",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("statusOf nunca proyecta el token legado y `telegram` ya no depende de él", async () => {
  const dataDir = await setup();
  try {
    const supervisor = new RealSupervisor({ dataDir } as never);
    const config = await readAgent(dataDir, "agent");
    assert.ok(config);

    const sinCanal = await supervisor.statusOf(config);
    assert.equal("telegramToken" in sinCanal, false);
    assert.equal(sinCanal.telegram, false, "un residuo legado ya no pinta un bot");

    // Con el canal proyectado por el Dashboard, el booleano se vuelve cierto sin
    // que ningún secreto entre en la respuesta.
    await writeChannelRecords(dataDir, "agent", [
      { kind: "telegram", observedStatus: "active", updatedAt: 1 },
    ]);
    const conCanal = await supervisor.statusOf(config);
    assert.equal(conCanal.telegram, true);
    assert.equal("telegramToken" in conCanal, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name con el MISMO telegramToken legado: 200, sin reinicio y sin escribirlo", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const response = await patch(dataDir, runningSupervisor(restarts), {
      telegramToken: "old-token",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(restarts, [], "el campo legado no forma parte de la huella");
    const onDisk = await readAgent(dataDir, "agent");
    assert.equal("telegramToken" in (onDisk ?? {}), false, "no se persiste");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name con un telegramToken NUEVO tampoco rota ningún bot", async () => {
  // Antes del corte este era el caso "rotar el token reinicia". Ahora rotar un
  // token es `PUT /agents/:name/channels` (digest → huella); por el PATCH no pasa
  // nada observable, y ni una palabra del secreto llega al cuerpo de la respuesta.
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const response = await patch(dataDir, runningSupervisor(restarts), {
      telegramToken: "new-token",
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(restarts, []);
    assert.doesNotMatch(body, /new-token/);
    assert.equal("telegramToken" in ((await readAgent(dataDir, "agent")) ?? {}), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name limpia el token legado que había en disco", async () => {
  // Cualquier escritura del Manager por `/api/v1` purga el residuo: así el
  // `agent.json` deja de ser nunca un camino por el que un secreto de canal
  // llegue al Runner (el guard `channels/cutover.ts` protege el intervalo
  // entre el despliegue y esa primera escritura).
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const response = await patch(dataDir, runningSupervisor(restarts), {});

    assert.equal(response.status, 200);
    assert.deepEqual(restarts, []);
    assert.equal("telegramToken" in ((await readAgent(dataDir, "agent")) ?? {}), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /agents/:name de un Agent parado nunca lo arranca", async () => {
  const cases = [
    { name: "mismo token legado", payload: { telegramToken: "old-token" } },
    { name: "otro token legado", payload: { telegramToken: "new-token" } },
    { name: "token quitado", payload: { telegramToken: null } },
    { name: "cambio de modelo", payload: { model: "new-model" } },
    { name: "body vacío", payload: {} },
  ] as const;

  for (const currentCase of cases) {
    const dataDir = await setup();
    try {
      const actions: string[] = [];
      const response = await patch(dataDir, stoppedSupervisor(actions), currentCase.payload);

      assert.equal(response.status, 200, currentCase.name);
      assert.deepEqual(actions, [], currentCase.name);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("PATCH /agents/:name con telegramToken null es un no-op deprecado, no un reinicio", async () => {
  const dataDir = await setup();
  try {
    const restarts: string[] = [];
    const response = await patch(dataDir, runningSupervisor(restarts), {
      telegramToken: null,
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal("telegramToken" in ((await readAgent(dataDir, "agent")) ?? {}), false);
    assert.deepEqual(restarts, [], "quitar un campo legado no tumba un turno vivo");
    assert.match(body, /"telegram":false/);
    assert.doesNotMatch(body, /telegramToken/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
