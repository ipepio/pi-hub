import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { openTestDb, type SqliteDb } from "../src/storage/sqlite.ts";
import {
  ChannelExchangeLog,
  EXCHANGE_FEED_DEFAULT_LIMIT,
  EXCHANGE_FEED_MAX_LIMIT,
} from "../src/channels/exchange-log.ts";

// Slice (c) part 3a, item 3 — the projection-in feed the Dashboard drains.
//
// `channel_exchanges` is the only way a non-web exchange reaches D: there is no
// P→D trust direction, so D PULLS with `GET /agents/:name/channel-exchanges?after=<seq>`
// (design §1.2). The contract this pins is the cursor semantics D depends on:
//   * `after` is EXCLUSIVE and rows come back ascending by `seq`;
//   * `latestSeq` is the Agent-wide cursor, so a page that is empty still tells
//     D where it stands;
//   * the page is bounded, whatever the caller asks for;
//   * an unknown Agent is a 404, an Agent with nothing mirrored is a 200 empty —
//     "no exchanges" is not an error, it is the normal state of a web-only Agent.

const SERVICE_TOKEN = "service-token";
const dirs: string[] = [];
const dbs: SqliteDb[] = [];

async function setup(agentName = "agent"): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-channel-exchanges-"));
  dirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  await writeAgent(dataDir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

/** The log over a real migrated v4 database. */
async function logFor(dataDir: string): Promise<ChannelExchangeLog> {
  const db = await openTestDb(dataDir);
  dbs.push(db);
  return new ChannelExchangeLog(db);
}

function router(dataDir: string, deps: Record<string, unknown> = {}) {
  return createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN },
    {
      state: () => ({ state: "running", pid: 42 }),
      statusOf: async (config: { name: string }) => ({
        ...config,
        state: "running",
        port: 4100,
      }),
    } as unknown as Supervisor,
    undefined as unknown as OAuthService,
    undefined,
    { hasLiveTurnForAgent: () => false, hasAnyLiveTurn: () => false } as unknown as TurnExecution,
    undefined,
    deps,
  );
}

function get(app: ReturnType<typeof router>, url: string, token = SERVICE_TOKEN) {
  return app.request(`http://pihub.test${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function seed(log: ChannelExchangeLog, agentName: string, count: number, startAt = 1) {
  for (let index = startAt; index < startAt + count; index += 1) {
    log.append({
      agentName,
      turnId: `turn-${index}`,
      origin: index % 2 === 0 ? "proactive" : "telegram",
      chatId: `12345`,
      userText: `pregunta ${index}`,
      replyText: `respuesta ${index}`,
      now: 1_761_100_800_000 + index,
    });
  }
}

test("exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir);
    const response = await get(app, "/agents/agent/channel-exchanges?after=0", "");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "MISSING_AUTH");
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("404 AGENT_NOT_FOUND cuando el Agent no existe", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir, { exchanges: await logFor(dataDir) });
    const response = await get(app, "/agents/nadie/channel-exchanges?after=0");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("200 vacío para un Agent sin intercambios (no es un error)", async () => {
  const dataDir = await setup();
  try {
    const log = await logFor(dataDir);
    const app = router(dataDir, { exchanges: log });
    const response = await get(app, "/agents/agent/channel-exchanges?after=0");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.agentName, "agent");
    assert.deepEqual(body.exchanges, []);
    assert.equal(body.latestSeq, 0);
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("`after` es exclusivo y las filas vienen ascendentes por `seq`", async () => {
  const dataDir = await setup();
  try {
    const log = await logFor(dataDir);
    seed(log, "agent", 3);
    const app = router(dataDir, { exchanges: log });

    const response = await get(app, "/agents/agent/channel-exchanges?after=1");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.exchanges.map((row: { turnId: string; seq: number }) => row.turnId),
      ["turn-2", "turn-3"],
    );
    assert.ok(body.exchanges[0].seq < body.exchanges[1].seq);
    assert.equal(body.latestSeq, body.exchanges[1].seq);
    const first = body.exchanges[0];
    assert.deepEqual(Object.keys(first).sort(), [
      "chatId",
      "createdAt",
      "hasFull",
      "origin",
      "replyFullText",
      "replyText",
      "seq",
      "turnId",
      "userFullText",
      "userText",
    ]);
    assert.equal(first.origin, "proactive");
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("la página está acotada: default y techo, y el eco del `limit` efectivo", async () => {
  const dataDir = await setup();
  try {
    const log = await logFor(dataDir);
    seed(log, "agent", 3);
    const app = router(dataDir, { exchanges: log });

    const bounded = await (
      await get(app, "/agents/agent/channel-exchanges?after=0&limit=2")
    ).json();
    assert.equal(bounded.exchanges.length, 2);
    assert.equal(bounded.limit, 2);
    assert.equal(bounded.latestSeq, 3, "latestSeq es el cursor total, no el de la página");

    const defaulted = await (await get(app, "/agents/agent/channel-exchanges")).json();
    assert.equal(defaulted.limit, EXCHANGE_FEED_DEFAULT_LIMIT);
    assert.equal(defaulted.after, 0);

    const greedy = await (
      await get(app, "/agents/agent/channel-exchanges?after=0&limit=99999")
    ).json();
    assert.equal(greedy.limit, EXCHANGE_FEED_MAX_LIMIT);
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("`after` no numérico es BAD_REQUEST (un cursor roto no puede ser un 0 silencioso)", async () => {
  const dataDir = await setup();
  try {
    const log = await logFor(dataDir);
    seed(log, "agent", 1);
    const app = router(dataDir, { exchanges: log });
    const response = await get(app, "/agents/agent/channel-exchanges?after=abc");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "BAD_REQUEST");

    const negative = await get(app, "/agents/agent/channel-exchanges?after=-3");
    assert.equal(negative.status, 400);
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sin persistencia compuesta: feed vacío, nunca un 500", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir);
    const response = await get(app, "/agents/agent/channel-exchanges?after=0");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.exchanges, []);
    assert.equal(body.latestSeq, 0);
  } finally {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  }
});
