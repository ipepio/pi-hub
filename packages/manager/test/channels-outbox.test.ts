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
  it("the latest schema retains the outbox table introduced in v4", async () => {
    assert.equal(MIGRATIONS.at(-1)?.version, SCHEMA_VERSION);
    const db = await migratedDb();
    assert.equal(userVersion(db), SCHEMA_VERSION);
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
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(tableNames(db).has("channel_outbox"), true);
    const row = db.prepare("SELECT id FROM initiatives WHERE id = 'i1'").get() as
      | { id: string }
      | undefined;
    assert.equal(row?.id, "i1", "v3 data survived the additive migration");
  });

  it("re-running migrations on the current schema is a no-op", async () => {
    const db = await migratedDb();
    runMigrations(db);
    assert.equal(userVersion(db), SCHEMA_VERSION);
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

  // B2 (verify round, revocation 3c): deleting an AGENT is a teardown of every
  // channel it had, and the queue is agent-scoped — `deadFor` takes a kind, so a
  // purge would have to guess which kinds still have rows (by the time the route
  // runs, `channels.json` is gone). `deadForAgent` is the drain that cannot miss.
  it("deadForAgent terminals EVERY row of that agent, without sending a single one", async () => {
    const db = await migratedDb();
    const time = clock();
    const sent: string[] = [];
    const outbox = outboxWith(db, time, async (row) => {
      sent.push(row.id);
      return "msg";
    });
    const first = await outbox.enqueue(BASE);
    const second = await outbox.enqueue({ ...BASE, target: "666" });
    const survived = await outbox.enqueue({ ...BASE, agentName: "other", target: "999" });

    const drained = await outbox.deadForAgent("agent", "agent deletion");
    assert.equal(drained, 2, "both rows of the purged agent");
    assert.deepEqual(sent, [], "a purge never delivers");
    assert.equal((await outbox.byId(first.id))?.state, "dead");
    assert.equal((await outbox.byId(second.id))?.state, "dead");
    assert.equal((await outbox.byId(first.id))?.lastError, "agent deletion");
    assert.equal(
      (await outbox.byId(survived.id))?.state,
      "pending",
      "el otro Agent conserva su cola",
    );
    assert.equal(await outbox.deadForAgent("agent", "replay"), 0, "idempotente por estado");
  });
});

// T6b — el teclado en línea en la cola.
//
// La fila es el envelope serializado, así que el teclado viaja DENTRO del payload
// (`{"text":…,"keyboard":…}`) y se re-lee al despertar la fila: un reinicio del
// Manager no puede perder los botones de un mensaje ya aceptado. Dos reglas, y la
// segunda es la que protege al transporte: un payload cuyo teclado no se puede leer
// NUNCA se envía (un teclado mal formado no mejora reintentando).
describe("outbox — teclado en línea (T6b)", () => {
  const KEYBOARD = [[{ text: "trabajo (s2)", data: "s:s2" }]];

  it("el teclado del payload viaja en la fila y llega al transporte", async () => {
    const db = await migratedDb();
    const time = clock();
    const sent: OutboxRow[] = [];
    const outbox = outboxWith(db, time, async (row) => {
      sent.push(row);
      return "msg-1";
    });

    const row = await outbox.enqueue({
      ...BASE,
      payload: JSON.stringify({ text: "elige una sesión", keyboard: KEYBOARD }),
    });

    assert.equal(row.text, "elige una sesión");
    assert.deepEqual(row.keyboard, KEYBOARD, "el teclado se lee del payload al reservar");
    const pending = await outbox.pendingOf("agent", "telegram");
    assert.deepEqual(pending[0]?.keyboard, KEYBOARD);

    await outbox.drain();
    assert.deepEqual(sent[0]?.keyboard, KEYBOARD, "el worker se lo pasa tal cual al transporte");
    assert.equal(sent[0]?.text, "elige una sesión");
  });

  it("un payload sin teclado no inventa uno: la fila es de solo texto", async () => {
    const db = await migratedDb();
    const outbox = outboxWith(db, clock(), async () => "msg-1");

    const row = await outbox.enqueue(BASE);
    assert.equal(row.keyboard, undefined);
    assert.equal(row.text, "hola");
  });

  it("un teclado mal formado en un payload almacenado se descarta: la fila nunca se envía", async () => {
    const db = await migratedDb();
    const time = clock();
    let sends = 0;
    const logs: string[] = [];
    const outbox = new ChannelOutbox(db, {
      now: time.now,
      send: async () => {
        sends += 1;
        return "msg-1";
      },
      log: (line) => logs.push(line),
    });
    // Fila escrita sin pasar por `enqueue` (una version anterior, o un tercero):
    // nadie validó el payload al insertarlo, así que la defensa vive al leerlo.
    db.prepare(
      `INSERT INTO channel_outbox (id, agent_name, kind, target, payload, state, attempts, created_at, updated_at)
       VALUES (?, 'agent', 'telegram', '555', ?, 'pending', 0, 1, 1)`,
    ).run("pending:broken-keyboard", JSON.stringify({ text: "hola", keyboard: "no-es-un-teclado" }));

    const drained = await outbox.drain();

    assert.equal(sends, 0, "fail-closed: no llega al transporte");
    assert.equal(drained.attempted, 0, "ni siquiera se intenta");
    const stored = db
      .prepare("SELECT state, last_error FROM channel_outbox WHERE id = ?")
      .get("pending:broken-keyboard") as { state: string; last_error: string | null };
    assert.equal(stored.state, "dead", "terminal: un teclado inválido no puede mejorar");
    assert.match(String(stored.last_error), /unreadable_payload/);
    assert.equal(
      await outbox.byId("pending:broken-keyboard"),
      undefined,
      "no se expone una fila ilegible",
    );
    assert.equal((await outbox.counts()).dead, 1);
    assert.ok(
      logs.some(
        (line) =>
          line.includes("CHANNEL_OUTBOX_DIED") && line.includes("unreadable_payload"),
      ),
      `el descarte se registra: ${logs.join(" | ")}`,
    );
  });

  it("enqueue rechaza un payload con teclado mal formado antes de escribir la fila", async () => {
    const db = await migratedDb();
    const outbox = outboxWith(db, clock(), async () => "msg-1");

    await assert.rejects(
      () =>
        outbox.enqueue({
          ...BASE,
          payload: JSON.stringify({ text: "hola", keyboard: [[{ text: "sin datos", data: "" }]] }),
        }),
      RangeError,
    );
    assert.deepEqual(await outbox.counts(), {
      pending: 0,
      in_flight: 0,
      delivered: 0,
      dead: 0,
    });
  });

  it("invalid_keyboard es terminal en el primer intento: reintentar no arregla el payload", async () => {
    const db = await migratedDb();
    const time = clock();
    const { ChannelAdapterError } = await import("@pihub/channels");
    const outbox = outboxWith(db, time, async () => {
      throw new ChannelAdapterError({
        code: "invalid_keyboard",
        message: "invalid inline keyboard: row 0 button 0 carries 65 bytes",
      });
    });
    const row = await outbox.enqueue({
      ...BASE,
      payload: JSON.stringify({ text: "elige", keyboard: KEYBOARD }),
    });

    await outbox.drain();
    assert.equal((await outbox.byId(row.id))?.state, "dead");
  });
});
