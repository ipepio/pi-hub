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
  type PihubEnv,
} from "@pihub/shared";
import type { ChannelAdapter } from "@pihub/channels";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { createApiV1Router, type ApiV1ChannelDeps } from "../dist/api-v1/routes.js";
import { ChannelRuntimeRegistry } from "../dist/channels/registry.js";
import { ChannelOutbox } from "../dist/channels/outbox.js";
import { ChannelExchangeLog } from "../dist/channels/exchange-log.js";
import { openTestDb, type SqliteDb } from "../dist/storage/sqlite.js";

// B2 (verify round, blocker) — spec `agent-channels` → "Revocation semantics (c)":
//   «The purge path stops the channel adapter / clears the vault entry / drains the
//   channel outbox to terminal state» (+ I2: a deleted Agent's queue must reach the
//   terminal state instead of retrying forever, and "Silent teardown").
//
// `DELETE /api/v1/agents/:name` — the endpoint D's `purge-agent` reaches through
// `AgentExecutionPlatform.removeAgent` — only did `supervisor.stop` + `deleteAgent`.
// The consequence is the highest-incident-risk gap of the change: the bot of a
// purged Agent keeps long-polling until the Manager restarts (duplicate-token
// conflicts, a live bot answering a chat whose Agent no longer exists), its
// `channel_outbox` rows keep being claimed and retried, and its `channel_exchanges`
// mirror stays in the database that `rm -rf` of the agent directory cannot reach.
//
// These tests pin the teardown as ONE observable effect set: adapter stopped, outbox
// terminal without a single send, exchange feed deleted, channel records gone —
// scoped to the deleted Agent, and with the pre-existing behavior intact for an
// Agent that never had channels (and for a Manager with no channel deps composed).

const SERVICE_TOKEN = "service-token";
const CHANNEL_TOKEN = "771234:AA-secreto-de-bot-telegram";
const CHAT_ID = "424242";

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

async function setup(...agentNames: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-agent-delete-"));
  dirs.push(dir);
  await scaffoldGlobalDirs(dir);
  for (const name of agentNames) {
    await scaffoldAgentDirs(dir, name);
    await writeAgent(dir, {
      name,
      port: 4100,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  }
  return dir;
}

test.afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Adapter factory that records lifecycle: `stops` is what a teardown must produce. */
function recordingFactory(sends: Array<{ chatId: string; text: string }>, stops: string[]) {
  return (kind: string): ChannelAdapter => ({
    kind: kind as never,
    async start(): Promise<void> {},
    async send({ chatId, text }) {
      sends.push({ chatId, text });
      return { messageId: `msg-${sends.length}` };
    },
    async stop(): Promise<void> {
      stops.push(kind);
    },
  });
}

function idleSupervisor(): Supervisor {
  return {
    state: () => ({ state: "stopped" as never, pid: undefined }),
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    statusOf: async (config: { name: string }) => ({
      ...config,
      state: "stopped",
      port: 4100,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

function noLiveTurn(): TurnExecution {
  return {
    hasLiveTurnForAgent: () => false,
    hasAnyLiveTurn: () => false,
  } as unknown as TurnExecution;
}

interface Harness {
  app: ReturnType<typeof createApiV1Router>;
  deps: ApiV1ChannelDeps;
  registry: ChannelRuntimeRegistry;
  outbox: ChannelOutbox;
  exchanges: ChannelExchangeLog;
  sends: Array<{ chatId: string; text: string }>;
  stops: string[];
  db: SqliteDb;
}

/**
 * `bindLate` reproduces the REAL boot order: `createApp` runs at step 10 of
 * `runStartup`, while the outbox and its persistence are only built at step 13
 * (`createOutboxWorker`). A router that snapshots `channels.outbox` at construction
 * would therefore never see the queue — exactly how FIX H4's drain stayed inert.
 */
async function buildApp(dataDir: string, options: { bindLate?: boolean } = {}): Promise<Harness> {
  const sends: Array<{ chatId: string; text: string }> = [];
  const stops: string[] = [];
  const registry = new ChannelRuntimeRegistry({ adapterFactory: recordingFactory(sends, stops) });
  const db = await openTestDb(dataDir);
  dbs.push(db);
  const outbox = new ChannelOutbox(db, {
    send: async (row) => {
      sends.push({ chatId: row.target, text: row.text });
      return `msg-${sends.length}`;
    },
  });
  const exchanges = new ChannelExchangeLog(db);

  const deps: ApiV1ChannelDeps = {
    registry,
    adapterFactory: recordingFactory(sends, stops),
    exchanges,
    outbox: options.bindLate ? undefined : outbox,
  };
  const app = createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN } as unknown as PihubEnv,
    idleSupervisor(),
    undefined as unknown as OAuthService,
    undefined,
    noLiveTurn(),
    undefined,
    deps,
  );
  if (options.bindLate) deps.outbox = outbox;

  return { app, deps, registry, outbox, exchanges, sends, stops, db };
}

function request(app: Harness["app"], method: string, url: string, body?: unknown) {
  return app.request(`http://pihub.test${url}`, {
    method,
    headers:
      body === undefined
        ? { authorization: `Bearer ${SERVICE_TOKEN}` }
        : { authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Project a live telegram channel and queue one message + one mirror row for it. */
async function seedChannelState(handle: Harness, agentName = "agent"): Promise<void> {
  const put = await request(handle.app, "PUT", `/agents/${agentName}/channels`, {
    channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
  });
  assert.equal(put.status, 202);
  await handle.outbox.enqueue({
    agentName,
    kind: "telegram",
    target: CHAT_ID,
    payload: JSON.stringify({ text: "mensaje en cola" }),
  });
  handle.exchanges.append({
    agentName,
    turnId: `turn-${agentName}`,
    origin: "telegram",
    chatId: CHAT_ID,
    userText: "hola",
    replyText: "adiós",
    now: Date.now(),
  });
}

test("revocation (c): DELETE /agents/:name detiene el adapter, dreña el outbox y borra el feed", async () => {
  const dataDir = await setup("agent");
  const handle = await buildApp(dataDir);
  await seedChannelState(handle);

  assert.equal(handle.registry.isRunning("agent", "telegram"), true, "fixture: adapter vivo");
  assert.equal((await handle.outbox.pendingOf("agent", "telegram")).length, 1);
  assert.equal(handle.exchanges.listAfter("agent", 0).length, 1);

  const response = await request(handle.app, "DELETE", "/agents/agent");
  assert.equal(response.status, 204);

  // 1. The bot stops polling — the incident this blocker is about.
  assert.equal(handle.registry.isRunning("agent", "telegram"), false, "adapter follow life");
  assert.deepEqual(handle.stops, ["telegram"], "el adapter se para una sola vez y en silencio");
  // 2. The queue reaches the terminal state WITHOUT a delivery.
  assert.equal((await handle.outbox.pendingOf("agent", "telegram")).length, 0, "cola drenada");
  const states = handle.db
    .prepare("SELECT state, last_error FROM channel_outbox WHERE agent_name = ?")
    .all("agent") as Array<{ state: string; last_error: string }>;
  assert.equal(states.length, 1);
  assert.equal(states[0]!.state, "dead", "terminal, no retryable");
  assert.match(states[0]!.last_error, /agent deletion|delete/i);
  assert.deepEqual(handle.sends, [], "un purgado no envía nada (no farewell, no ghost)");
  // 3. The projection-in mirror goes with the Agent.
  assert.deepEqual(handle.exchanges.listAfter("agent", 0), [], "el feed desaparece");
  // 4. The channel records go with the agent directory (and stay unreadable).
  assert.equal(await readAgent(dataDir, "agent"), undefined, "Agent purgado");
  await assert.rejects(() => fs.readFile(path.join(dataDir, "agents", "agent", "channels.json")));
});

test("el outbox enlazado TARDE (createOutboxWorker) también se dreña al borrar el Agent", async () => {
  const dataDir = await setup("agent");
  // El router se construye ANTES de que exista la cola y recibe el MISMO objeto de
  // deps que después le ponen el outbox: la ruta debe leerlo perezosamente.
  const handle = await buildApp(dataDir, { bindLate: true });
  await seedChannelState(handle);

  const response = await request(handle.app, "DELETE", "/agents/agent");
  assert.equal(response.status, 204);

  assert.equal(handle.registry.isRunning("agent", "telegram"), false);
  const rows = handle.db.prepare("SELECT state FROM channel_outbox").all() as Array<{
    state: string;
  }>;
  assert.deepEqual(rows.map((row) => row.state), ["dead"], "nada sigue reintentando");
  assert.deepEqual(handle.sends, []);
});

test("el purgado no apaga a su vecina: adapter, cola y feed ajenos sobreviven", async () => {
  const dataDir = await setup("agent", "vecina");
  const handle = await buildApp(dataDir);
  await seedChannelState(handle, "agent");
  await seedChannelState(handle, "vecina");
  handle.stops.length = 0;

  const response = await request(handle.app, "DELETE", "/agents/agent");
  assert.equal(response.status, 204);

  assert.equal(handle.registry.isRunning("vecina", "telegram"), true, "la vecina sigue votando");
  assert.deepEqual(handle.stops, ["telegram"], "solo se paró el purgado");
  assert.equal((await handle.outbox.pendingOf("vecina", "telegram")).length, 1);
  assert.equal(
    handle.db
      .prepare("SELECT state FROM channel_outbox WHERE agent_name = ?")
      .get("vecina")!.state,
    "pending",
    "la cola de otra Agent no se toca",
  );
  assert.equal(handle.exchanges.listAfter("vecina", 0).length, 1);
  assert.ok(await readAgent(dataDir, "vecina"), "la vecina conserva su config");
});

test("sin canales compuestos (deps pelados) borrar un Agent sigue respondiendo 204", async () => {
  const dataDir = await setup("agent");
  const app = createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN } as unknown as PihubEnv,
    idleSupervisor(),
    undefined as unknown as OAuthService,
    undefined,
    noLiveTurn(),
  );

  const response = await request(app, "DELETE", "/agents/agent");
  assert.equal(response.status, 204);
  assert.equal(await readAgent(dataDir, "agent"), undefined);
});

test("DELETE de un Agent inexistente: 404 y ningún efecto de teardown", async () => {
  const dataDir = await setup("vecina");
  const handle = await buildApp(dataDir);
  await seedChannelState(handle, "vecina");
  handle.stops.length = 0;

  const response = await request(handle.app, "DELETE", "/agents/fantasma");
  assert.equal(response.status, 404);
  assert.deepEqual(handle.sends, []);
  assert.deepEqual(handle.stops, [], "nadie para el bot de otra Agent");
  assert.equal((await handle.outbox.pendingOf("vecina", "telegram")).length, 1);
  assert.equal(handle.exchanges.listAfter("vecina", 0).length, 1);
});
