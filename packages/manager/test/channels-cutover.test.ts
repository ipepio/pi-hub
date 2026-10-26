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
  type PihubEnv,
} from "@pihub/shared";
import { createAgent, updateAgent } from "../dist/agents.js";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { assertNoDoubleTelegramBot } from "../dist/channels/cutover.js";
import { writeChannelRecords } from "../dist/channels/store.js";
import { Supervisor as RealSupervisor } from "../dist/supervisor.js";
import { runStartup, type ServerLike, type StartupDeps } from "../dist/startup.js";
import type { Supervisor } from "../src/supervisor.ts";

// Cutover (slice (c) part 3b, proposal R3). Before this pass the Telegram bot
// lived TWICE: the Runner's grammy bot (fed by `agent.json.telegramToken`) and
// the Manager adapter (fed by the projected channel record). Two processes
// long-polling one token means Telegram answers only one of them — messages are
// lost at random. The cutover makes the Manager the only owner, so:
// - `agent.json.telegramToken` is never WRITTEN again (and a legacy value that
//   is already on disk is stripped on the next write), and
// - a Manager that starts with BOTH paths configured aborts instead of racing.

async function setup(agentName = "agent"): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-cutover-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  return dataDir;
}

function legacyConfig(name = "agent", extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    port: 4100,
    model: "anthropic/claude-sonnet-5",
    telegramToken: "legacy-bot-token",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

const telegramRecord = [
  { kind: "telegram" as const, observedStatus: "active" as const, updatedAt: 1 },
];

// --- 1. La aserción de arranque (R3) -------------------------------------

test("assertNoDoubleTelegramBot: no aborta cuando no hay ningún canal proyectado", async () => {
  const dataDir = await setup();
  await writeAgent(dataDir, legacyConfig());
  // Token legado sin canal = el bot legado (ya suprimido) era el único dueño.
  await assert.doesNotReject(() => assertNoDoubleTelegramBot(dataDir));
});

test("assertNoDoubleTelegramBot: no aborta cuando el canal no convive con un token legado", async () => {
  const dataDir = await setup();
  await writeAgent(dataDir, { ...legacyConfig(), telegramToken: undefined });
  await writeChannelRecords(dataDir, "agent", telegramRecord);
  await assert.doesNotReject(() => assertNoDoubleTelegramBot(dataDir));
});

test("assertNoDoubleTelegramBot: limpia el token legado y arranca (H6: log-and-clean)", async () => {
  const dataDir = await setup();
  await writeAgent(dataDir, legacyConfig("agent"));
  await writeAgent(dataDir, legacyConfig("otro"));
  await writeChannelRecords(dataDir, "agent", telegramRecord);

  // H6: ya no aborta — limpia el residuo (solo de los Agents en conflicto)
  // y arranca con warning ruidoso.
  await assert.doesNotReject(() => assertNoDoubleTelegramBot(dataDir));

  const cleaned = await readAgent(dataDir, "agent");
  assert.equal(cleaned?.telegramToken, undefined);
  // "otro" no tiene canal proyectado → no está en conflicto → su residuo
  // sobrevive (lo borra la próxima escritura normal del Agent).
  const untouched = await readAgent(dataDir, "otro");
  assert.ok(untouched?.telegramToken);
});

test("assertNoDoubleTelegramBot: un agente desconocido o sin canales no cuenta", async () => {
  const dataDir = await setup("limpio");
  await writeAgent(dataDir, legacyConfig("limpio"));
  await writeChannelRecords(dataDir, "sin-agente", telegramRecord);
  await assert.doesNotReject(() => assertNoDoubleTelegramBot(dataDir));
});

// --- 2. El sitio del guard en la composición de arranque ------------------

function startupRecorder(recorder: string[], guardFails: boolean) {
  const store = {
    agenda: {
      recoverRunningOnStartup: () => ({ runningRecovered: [], deadlineExpired: 0 }),
      triggers: { reconcileAuthority: () => 0 },
    },
    close: () => recorder.push("store.close"),
  };
  const deps = {
    openStore: async () => {
      recorder.push("openStore");
      return store;
    },
    providers: {
      async initialize(): Promise<void> {
        recorder.push("providers.initialize");
      },
    },
    provision: async () => {
      recorder.push("provision");
    },
    createSupervisor: () => ({
      async startAll(): Promise<void> {
        recorder.push("supervisor.startAll");
      },
      async stopAll(): Promise<void> {},
    }),
    createTurns: () => {
      recorder.push("createTurns");
      return {};
    },
    createOAuth: () => ({}),
    createApp: () => {
      recorder.push("createApp");
      return {};
    },
    createLoop: () => ({
      start(): void {
        recorder.push("loop.start");
      },
      async stop(): Promise<void> {},
    }),
    serve: () => {
      recorder.push("serve");
      return { close: () => {} } satisfies ServerLike;
    },
    assertNoDoubleTelegramBot: async () => {
      recorder.push("assertNoDoubleTelegramBot");
      if (guardFails) throw new Error("doble bot: agent telegramToken");
    },
  };
  return deps as unknown as StartupDeps<
    typeof store,
    { initialize(): Promise<void> },
    { startAll(): Promise<void> },
    unknown,
    unknown,
    { start(): void; stop(options?: { graceMs?: number }): Promise<void> },
    unknown
  >;
}

test("runStartup: el guard corre tras `provision` y antes de arrancar ningún Runner", async () => {
  const recorder: string[] = [];
  await runStartup(startupRecorder(recorder, false), "owner");
  assert.ok(
    recorder.includes("assertNoDoubleTelegramBot"),
    `el guard no se ejecutó: ${recorder.join(" → ")}`,
  );
  assert.deepEqual(recorder, [
    "openStore",
    "providers.initialize",
    "provision",
    "assertNoDoubleTelegramBot",
    "supervisor.startAll",
    "createTurns",
    "createApp",
    "serve",
    "loop.start",
  ]);
});

test("runStartup: si el guard aborta, no se levantan Runners, ni HTTP, ni Loop (R3)", async () => {
  const recorder: string[] = [];
  await assert.rejects(
    () => runStartup(startupRecorder(recorder, true), "owner"),
    /doble bot/,
  );
  assert.equal(recorder.includes("supervisor.startAll"), false);
  assert.equal(recorder.includes("createApp"), false);
  assert.equal(recorder.includes("serve"), false);
  assert.equal(recorder.includes("loop.start"), false);
});

test("runStartup: sin guard compuesto el arranque es idéntico al de antes", async () => {
  const recorder: string[] = [];
  const deps = startupRecorder(recorder, false);
  delete (deps as { assertNoDoubleTelegramBot?: unknown }).assertNoDoubleTelegramBot;
  await runStartup(deps, "owner");
  assert.deepEqual(recorder, [
    "openStore",
    "providers.initialize",
    "provision",
    "supervisor.startAll",
    "createTurns",
    "createApp",
    "serve",
    "loop.start",
  ]);
});

// --- 3. `agent.json` ya no escribe el token -------------------------------

test("createAgent: un telegramToken en el input no acaba en agent.json", async () => {
  const dataDir = await setup();
  await createAgent(
    { dataDir, agentPortRange: [4100, 4199] } as unknown as PihubEnv,
    { name: "agent", telegramToken: "legacy-bot-token" } as unknown as Parameters<
      typeof createAgent
    >[1],
  );
  const config = await readAgent(dataDir, "agent");
  assert.equal("telegramToken" in (config ?? {}), false);
});

test("updateAgent: nunca escribe telegramToken y limpia el que ya estaba en disco", async () => {
  const dataDir = await setup();
  await writeAgent(dataDir, legacyConfig());
  const updated = await updateAgent({ dataDir } as unknown as PihubEnv, "agent", {
    model: "openai/gpt-5",
    // Campo legado: aunque el caller lo mande, no se persiste.
    telegramToken: "otro-legado" as unknown as undefined,
  });
  assert.equal("telegramToken" in updated, false);
  const onDisk = await readAgent(dataDir, "agent");
  assert.equal("telegramToken" in (onDisk ?? {}), false);
  assert.equal(onDisk?.model, "openai/gpt-5");
});

// --- 4. El PATCH /api/v1 ya no decide nada por el token legado ------------

function runningSupervisor(actions: string[]): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    start: async () => actions.push("start"),
    stop: async () => actions.push("stop"),
    restart: async () => actions.push("restart"),
    statusOf: async (config: AgentConfig) => ({
      ...config,
      state: "running",
      port: config.port,
      pid: 42,
      telegram: true,
    }),
  } as unknown as Supervisor;
}

async function patchAgent(dataDir: string, body: Record<string, unknown>) {
  const actions: string[] = [];
  const router = createApiV1Router(
    { dataDir, apiToken: "service-token" } as unknown as PihubEnv,
    runningSupervisor(actions),
    {} as never,
  );
  const response = await router.request("http://pihub.test/agents/agent", {
    method: "PATCH",
    headers: {
      authorization: "Bearer service-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, actions };
}

test("PATCH /agents/:name: un telegramToken legado no reinicia ni se persiste", async () => {
  const dataDir = await setup();
  await writeAgent(dataDir, legacyConfig());
  const { response, actions } = await patchAgent(dataDir, {
    model: "anthropic/claude-sonnet-5",
    telegramToken: "rotado-legado",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(actions, [], "el token legado ya no forma parte de la huella");
  const onDisk = await readAgent(dataDir, "agent");
  assert.equal("telegramToken" in (onDisk ?? {}), false);
});

// --- 5. `telegram` del status pasa a ser el canal, no el config -----------

test("statusOf: `telegram` refleja el registro de canal, no el token legado", async () => {
  const dataDir = await setup();
  const supervisor = new RealSupervisor({ dataDir } as unknown as PihubEnv);

  // Sin canal proyectado: false, aunque el fichero aún traiga el token legado.
  await writeAgent(dataDir, legacyConfig());
  const sinCanal = await supervisor.statusOf(await readAgent(dataDir, "agent"));
  assert.equal(sinCanal.telegram, false);
  assert.equal("telegramToken" in sinCanal, false, "el token jamás sale por la API");

  // Con canal proyectado: true, y sigue sin salir ningún secreto.
  await writeChannelRecords(dataDir, "agent", telegramRecord);
  const conCanal = await supervisor.statusOf(await readAgent(dataDir, "agent"));
  assert.equal(conCanal.telegram, true);
  assert.equal("telegramToken" in conCanal, false);
});
