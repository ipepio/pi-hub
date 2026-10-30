import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
  type PihubEnv,
} from "@pihub/shared";
import type { ChannelAdapter } from "@pihub/channels";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { ChannelRuntimeRegistry } from "../dist/channels/registry.js";
import { ChannelOutbox } from "../dist/channels/outbox.js";
import { readChannelRecords } from "../dist/channels/store.js";
import { openTestDb, type SqliteDb } from "../dist/storage/sqlite.js";

// FIX H4 (slice (c) review round 2, HIGH) — teardown drain was never called.
//
// `ChannelOutbox.deadFor()` shipped in part 2a with a documented caller («the
// `PUT /channels` replace-all and `DELETE /channels/:kind` paths») and design
// §13 documents the same for both routes... but no route ever called it. A
// channel the owner removed therefore left its queue behind: the drain worker of
// the next tick claimed those rows and tried to send them through an adapter
// that no longer exists — `unavailable`, retryable, backoff, eight attempts, and
// finally `dead` anyway, but after up to 15 minutes of queue noise and, worse,
// through whatever adapter later took that kind's slot.
//
// Spec invariant I2 + the "Teardown drains to terminal without delivery"
// scenario: the rows reach the terminal state WITHOUT a single delivery attempt
// and with no farewell to the chat. These tests pin exactly that, on the real v4
// table, plus the negative half: an idempotent projection that KEEPS the channel
// must not touch the queue.

const SERVICE_TOKEN = "service-token";
const CHANNEL_TOKEN = "771234:AA-secreto-de-bot-telegram";
const CHAT_ID = "424242";

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

async function setup(agentName = "agent"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-channels-teardown-"));
  dirs.push(dir);
  await scaffoldGlobalDirs(dir);
  await scaffoldAgentDirs(dir, agentName);
  await writeAgent(dir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dir;
}

async function readState(db: SqliteDb, id: string): Promise<{ state: string; last_error: string }> {
  return db
    .prepare("SELECT state, last_error FROM channel_outbox WHERE id = ?")
    .get(id) as { state: string; last_error: string };
}

test.afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Adapter factory that records sends: a teardown must never reach it. */
function silentFactory(sends: Array<{ chatId: string; text: string }>) {
  return (): ChannelAdapter => ({
    kind: "telegram",
    async start(): Promise<void> {},
    async send({ chatId, text }) {
      sends.push({ chatId, text });
      return { messageId: `msg-${sends.length}` };
    },
    async stop(): Promise<void> {},
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

interface AppHandle {
  app: ReturnType<typeof createApiV1Router>;
  outbox: ChannelOutbox;
  sends: Array<{ chatId: string; text: string }>;
  registry: ChannelRuntimeRegistry;
  db: SqliteDb;
}

async function buildApp(dataDir: string, withOutbox = true): Promise<AppHandle> {
  const sends: Array<{ chatId: string; text: string }> = [];
  const registry = new ChannelRuntimeRegistry({ adapterFactory: silentFactory(sends) });
  const db = await openTestDb(dataDir);
  dbs.push(db);
  const outbox = withOutbox
    ? new ChannelOutbox(db, {
        // A teardown that works never calls this: any call is a delivery attempt.
        send: async (row) => {
          sends.push({ chatId: row.target, text: row.text });
          return `msg-${sends.length}`;
        },
      })
    : undefined;
  const app = createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN } as unknown as PihubEnv,
    idleSupervisor(),
    undefined as unknown as OAuthService,
    undefined,
    noLiveTurn(),
    undefined,
    {
      registry,
      adapterFactory: silentFactory(sends),
      outbox,
    },
  );
  return { app, outbox: outbox as unknown as ChannelOutbox, sends, registry, db };
}

function call(
  app: AppHandle["app"],
  method: string,
  body?: unknown,
  kindPath?: string,
) {
  const url = kindPath
    ? `http://pihub.test/agents/agent/channels/${kindPath}`
    : "http://pihub.test/agents/agent/channels";
  return app.request(url, {
    method,
    headers:
      body === undefined
        ? { authorization: `Bearer ${SERVICE_TOKEN}` }
        : {
            authorization: `Bearer ${SERVICE_TOKEN}`,
            "content-type": "application/json",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Project one telegram channel and queue a message for it. */
async function seededQueue(handle: AppHandle): Promise<string> {
  const put = await call(handle.app, "PUT", {
    channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
  });
  assert.equal(put.status, 202);
  const row = await handle.outbox.enqueue({
    agentName: "agent",
    kind: "telegram",
    target: CHAT_ID,
    payload: JSON.stringify({ text: "mensaje en cola" }),
  });
  return row.id;
}

test("PUT replace-all que quita un canal pasa sus filas de outbox a `dead` sin enviarlas", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir);
  const id = await seededQueue(handle);

  const response = await call(handle.app, "PUT", { channels: [] });
  assert.equal(response.status, 202);

  const state = await readState(handle.db, id);
  assert.equal(state.state, "dead", "la fila de un canal retirado es terminal");
  assert.match(state.last_error, /teardown|remov/i, "la razón dice qué pasó");
  assert.deepEqual(handle.sends, [], "teardown no es entrega: cero intentos");
});

test("DELETE /channels/:kind pasa sus filas de outbox a `dead` sin enviarlas", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir);
  const id = await seededQueue(handle);

  const response = await call(handle.app, "DELETE", undefined, "telegram");
  assert.equal(response.status, 202);

  const state = await readState(handle.db, id);
  assert.equal(state.state, "dead");
  assert.deepEqual(handle.sends, []);
  assert.equal((await readChannelRecords(dataDir, "agent")).length, 0);
});

test("un drain posterior al teardown no reenvía nada", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir);
  const id = await seededQueue(handle);
  await call(handle.app, "PUT", { channels: [] });

  const result = await handle.outbox.drain();

  assert.equal(result.attempted, 0, "una fila `dead` no se reclama");
  assert.deepEqual(handle.sends, []);
  assert.equal((await readState(handle.db, id)).state, "dead");
});

test("PUT idempotente que CONSERVA el canal no toca la cola", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir);
  const id = await seededQueue(handle);

  // La misma proyección, otra vez (el reconcile del Dashboard): el canal sigue
  // ahí, así que su cola también.
  const response = await call(handle.app, "PUT", {
    channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
  });
  assert.equal(response.status, 202);

  assert.equal((await readState(handle.db, id)).state, "pending");
});

test("PUT que añade un canal no drena las filas de los demás", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir);
  const id = await seededQueue(handle);
  // Un segundo Agent tiene su propia fila: no es asunto de este teardown.
  await handle.outbox.enqueue({
    agentName: "otro",
    kind: "telegram",
    target: "999",
    payload: JSON.stringify({ text: "de otro agent" }),
  });

  await call(handle.app, "PUT", { channels: [] });

  const db = handle.db;
  assert.equal((await readState(db, id)).state, "dead");
  const other = db
    .prepare("SELECT state FROM channel_outbox WHERE agent_name = 'otro'")
    .get() as { state: string };
  assert.equal(other.state, "pending", "el teardown es por (agent, kind)");
});

test("sin outbox compuesto las rutas de canales siguen funcionando (deps opcionales)", async () => {
  const dataDir = await setup();
  const handle = await buildApp(dataDir, false);
  const put = await call(handle.app, "PUT", {
    channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
  });
  assert.equal(put.status, 202);
  const removed = await call(handle.app, "DELETE", undefined, "telegram");
  assert.equal(removed.status, 202);
}
);
