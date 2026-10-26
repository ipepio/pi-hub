import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTestDb, type SqliteDb } from "../src/storage/sqlite.ts";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  runMigrations,
} from "../src/storage/migrations.ts";
import {
  ChannelOutbox,
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_LEASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
  type OutboxRow,
} from "../src/channels/outbox.ts";

// Slice (c) part 2a — durable delivery: SQLite migration v4 (`channel_outbox`)
// and its drain worker, both modeled on `human_request_deliveries` +
// `retryPendingDeliveries` (design §2.2, invariants I2/I4).
//
// The four things the worker must guarantee, and nothing more:
//   * a row is claimed with a reservation (`pending:<id>` PK discipline), so a
//     second worker cannot take it;
//   * a retry never re-sends what is already `delivered` (idempotency via
//     `external_message_id`);
//   * a retryable failure backs off exponentially and dies at
//     `MAX_OUTBOX_ATTEMPTS`;
//   * channel teardown moves pending rows to `dead` WITHOUT delivering them
//     (no farewell, no ghost message after the owner removes the bot).

const tempDirs: string[] = [];
const openDbs: SqliteDb[] = [];

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

async function tmpDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-outbox-"));
  tempDirs.push(dir);
  return dir;
}

function columnsOf(db: SqliteDb, table: string): Set<string> {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableNames(db: SqliteDb): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function indexNames(db: SqliteDb): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function userVersion(db: SqliteDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

/** Migrated database at the current schema, via the production fixture. */
async function migratedDb(): Promise<SqliteDb> {
  const db = await openTestDb(await tmpDataDir());
  openDbs.push(db);
  return db;
}

/** Clock the worker reads; every backoff assertion moves it explicitly. */
function clock(start = 1_761_100_800_000) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

function outboxWith(
  db: SqliteDb,
  time: ReturnType<typeof clock>,
  send: (row: OutboxRow) => Promise<string>,
): ChannelOutbox {
  return new ChannelOutbox(db, { now: time.now, send });
}

const BASE = {
  agentName: "agent",
  kind: "telegram" as const,
  target: "555",
  payload: JSON.stringify({ text: "hola" }),
};

describe("migration v4 — channel_outbox", () => {
  it("SCHEMA_VERSION is 4 and v4 creates the outbox table", async () => {
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(MIGRATIONS.at(-1)?.version, 4);
    const db = await migratedDb();
    assert.equal(userVersion(db), 4);
    assert.equal(tableNames(db).has("channel_outbox"), true);
  });

  it("the table carries the delivery columns plus the three v4 additions", async () => {
    const db = await migratedDb();
    const columns = columnsOf(db, "channel_outbox");
    for (const column of [
      "id",
      "agent_name",
      "kind",
      "target",
      "payload",
      "state",
      "attempts",
      "next_attempt_at",
      "external_message_id",
      "in_flight_at",
      "last_error",
      "delivered_at",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(columns.has(column), true, column);
    }
    assert.equal(indexNames(db).has("channel_outbox_external_message"), true);
    assert.equal(indexNames(db).has("channel_outbox_due"), true);
  });

  it("state and kind are CHECK-constrained: nothing outside the diagram gets in", async () => {
    const db = await migratedDb();
    const insert = db.prepare(
      "INSERT INTO channel_outbox (id, agent_name, kind, target, payload, state, attempts, created_at, updated_at) VALUES (?, 'agent', 'telegram', '555', '{}', ?, 0, 1, 1)",
    );
    insert.run("pending:ok-1", "pending");
    assert.throws(() => insert.run("pending:bad-1", "queued"));
    assert.throws(() => insert.run("pending:bad-2", "delivered-or-something"));
    // The reservation format is part of the pattern, not a comment.
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO channel_outbox (id, agent_name, kind, target, payload, state, attempts, created_at, updated_at) VALUES ('', 'agent', 'telegram', '555', '{}', 'pending', 0, 1, 1)",
        )
        .run(),
    );
  });

  it("upgrading a v3 database keeps existing rows and data", async () => {
    const dir = await tmpDataDir();
    // node:sqlite does not create parent directories: same pre-step the v1→v3
    // upgrade fixtures in storage.test.ts use before opening a raw handle.
    await fs.mkdir(path.join(dir, "manager"), { recursive: true });
    const db = new DatabaseSync(path.join(dir, "manager", "agenda.sqlite3")) as unknown as SqliteDb;
    openDbs.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 3), 3);
    db.exec(
      "INSERT INTO initiatives (id, agent_name, state, origin, intent, mode, session_key, available_at, chain_depth, visible_effects_declared, created_at, state_changed_at) VALUES ('i1','agent','queued','human','intent','solo','k',1,0,0,1,1)",
    );
    assert.equal(userVersion(db), 3);

    runMigrations(db);
    assert.equal(userVersion(db), 4);
    assert.equal(tableNames(db).has("channel_outbox"), true);
    const row = db.prepare("SELECT id FROM initiatives WHERE id = 'i1'").get() as
      | { id: string }
      | undefined;
    assert.equal(row?.id, "i1", "v3 data survived the additive migration");
  });

  it("re-running migrations on a v4 database is a no-op", async () => {
    const db = await migratedDb();
    runMigrations(db);
    assert.equal(userVersion(db), 4);
  });
});

describe("outbox worker — claim and deliver", () => {
  it("enqueue reserves a pending:<id> row and drain delivers it once", async () => {
    const db = await migratedDb();
    const time = clock();
    const sent: Array<{ id: string; text: string }> = [];
    const outbox = outboxWith(db, time, async (row) => {
      sent.push({ id: row.id, text: row.text });
      return `msg-${sent.length}`;
    });

    const row = await outbox.enqueue(BASE);
    assert.match(row.id, /^pending:/);
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 0);

    const drained = await outbox.drain();
    assert.equal(drained.delivered, 1);
    assert.deepEqual(sent, [{ id: row.id, text: "hola" }]);

    const after = await outbox.byId(row.id);
    assert.equal(after?.state, "delivered");
    assert.equal(after?.externalMessageId, "msg-1");
    assert.equal(after?.deliveredAt, time.now());
    assert.equal(after?.lastError, null);

    // Idempotency: a delivered row is never picked up again, even on a re-run.
    assert.equal((await outbox.drain()).delivered, 0);
    assert.equal(sent.length, 1);
  });

  it("a send failure backs off exponentially and the row is not re-claimed early", async () => {
    const db = await migratedDb();
    const time = clock();
    let calls = 0;
    const outbox = outboxWith(db, time, async () => {
      calls += 1;
      throw new Error("429 too many requests");
    });

    const row = await outbox.enqueue(BASE);
    await outbox.drain();
    const first = await outbox.byId(row.id);
    assert.equal(first?.state, "pending", "a retryable failure re-queues");
    assert.equal(first?.attempts, 1);
    assert.equal(first?.lastError, "429 too many requests");
    const firstDelay = first!.nextAttemptAt! - time.now();

    // Not due yet: claiming must skip it, so the lease is never burned.
    assert.equal((await outbox.drain()).attempted, 0);
    assert.equal(calls, 1);

    time.advance(firstDelay);
    await outbox.drain();
    const second = await outbox.byId(row.id);
    assert.equal(second?.attempts, 2);
    assert.ok(
      second!.nextAttemptAt! - time.now() > firstDelay,
      "the backoff must grow",
    );
  });

  it("attempts >= 8 is terminal: the row dies and stops retrying", async () => {
    const db = await migratedDb();
    const time = clock();
    const outbox = outboxWith(db, time, async () => {
      throw new Error("network down");
    });
    const row = await outbox.enqueue(BASE);
    for (let attempt = 0; attempt < MAX_OUTBOX_ATTEMPTS; attempt += 1) {
      await outbox.drain({ force: true });
    }
    const dead = await outbox.byId(row.id);
    assert.equal(dead?.state, "dead");
    assert.ok(dead!.attempts >= MAX_OUTBOX_ATTEMPTS);
    assert.equal((await outbox.drain({ force: true })).attempted, 0);
  });

  it("an invalid chat is terminal on the first attempt, not after 8", async () => {
    const db = await migratedDb();
    const time = clock();
    const { ChannelAdapterError } = await import("@pihub/channels");
    const outbox = outboxWith(db, time, async () => {
      throw new ChannelAdapterError({ code: "invalid_chat", message: "chat gone" });
    });
    const row = await outbox.enqueue(BASE);
    await outbox.drain();
    assert.equal((await outbox.byId(row.id))?.state, "dead");
  });

  it("a crashed in_flight row is reclaimed once its lease expires", async () => {
    const db = await migratedDb();
    const time = clock();
    const outbox = outboxWith(db, time, async () => {
      throw new Error("still failing");
    });
    const row = await outbox.enqueue(BASE);
    const claimed = await outbox.claim(1);
    assert.equal(claimed.length, 1);
    assert.equal((await outbox.byId(row.id))?.state, "in_flight");

    // Second claim: the reservation is what keeps a parallel worker out.
    assert.equal((await outbox.claim(1)).length, 0);

    time.advance(OUTBOX_LEASE_MS + 1);
    const recovered = await outbox.claim(1);
    assert.equal(recovered.length, 1, "expired lease returns the row to the queue");
    assert.equal(recovered[0].id, row.id);
  });

  it("delivery that succeeded after a failed update stays at-least-once, never lost", async () => {
    const db = await migratedDb();
    const time = clock();
    let sends = 0;
    let confirmations = 0;
    const outbox = new ChannelOutbox(db, {
      now: time.now,
      send: async () => {
        sends += 1;
        return "msg-77";
      },
      // Simulated SQLite failure on the confirmation write — the first one only.
      onDelivered: () => {
        confirmations += 1;
        if (confirmations === 1) throw new Error("disk full");
      },
    });
    const row = await outbox.enqueue(BASE);
    const drained = await outbox.drain();
    assert.equal(drained.delivered, 0, "the confirmation never landed");
    const still = await outbox.byId(row.id);
    assert.equal(still?.state, "pending");
    assert.equal(still?.attempts, 1, "the attempt is counted, so a retry can happen");

    // The transport id landed BEFORE the failure, which is exactly what makes the
    // retry safe: the row is finalized instead of sent again (spec: “no message is
    // delivered twice (idempotent via external_message_id)”).
    assert.equal(still?.externalMessageId, "msg-77");
    time.advance(OUTBOX_BACKOFF_CAP_MS);
    const retried = await outbox.drain();
    assert.equal(retried.delivered, 1, "the pending confirmation completes");
    assert.equal(sends, 1, "the retry never re-sends the message");
    assert.equal((await outbox.byId(row.id))?.state, "delivered");
    assert.equal((await outbox.counts()).pending, 0, "the queue is empty again");
  });
});

describe("outbox worker — teardown (I2)", () => {
  it("deadFor moves pending rows to dead without sending anything", async () => {
    const db = await migratedDb();
    const time = clock();
    const sent: string[] = [];
    const outbox = outboxWith(db, time, async (row) => {
      sent.push(row.id);
      return "msg";
    });
    const a = await outbox.enqueue(BASE);
    const b = await outbox.enqueue({ ...BASE, target: "777" });
    await outbox.enqueue({ ...BASE, agentName: "other", target: "999" });

        const drained = await outbox.deadFor("agent", "telegram", "teardown");
        assert.equal(drained, 2);
        assert.deepEqual(sent, [], "teardown never delivers");
        assert.equal((await outbox.byId(a.id))?.state, "dead");
        assert.equal((await outbox.byId(b.id))?.state, "dead");
        assert.equal((await outbox.byId(a.id))?.lastError, "teardown");
        assert.equal((await outbox.pendingOf("agent", "telegram")).length, 0);
        // I2, stated precisely: a later tick cannot resurrect the removed channel.
        // The third row belongs to ANOTHER agent, whose channel is still live, so
        // it is exactly the one thing this drain is allowed to deliver — pinning
        // that is what proves the dead rows are dead for good (the global queue
        // must not be suppressed because one channel went away).
        const afterTeardown = await outbox.drain();
        assert.equal(afterTeardown.delivered, 1, "only the surviving agent's row");
        assert.equal(
          sent.some((id) => id === a.id || id === b.id),
          false,
          "no row of the torn-down channel was ever sent",
        );
        assert.equal((await outbox.byId(a.id))?.state, "dead");
        assert.equal((await outbox.byId(b.id))?.state, "dead");
      });

  it("rows keep their own agent: teardown of one channel cannot touch another", async () => {
    const db = await migratedDb();
    const time = clock();
    const outbox = outboxWith(db, time, async () => "msg");
    const kept = await outbox.enqueue({ ...BASE, agentName: "other-agent" });
    assert.equal(await outbox.deadFor("agent", "telegram", "teardown"), 0);
    assert.equal((await outbox.byId(kept.id))?.state, "pending");
  });
});
