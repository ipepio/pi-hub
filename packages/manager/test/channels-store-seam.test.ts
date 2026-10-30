import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openManagerStore } from "../src/storage/sqlite.ts";
import { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
import { ChannelOutbox, type OutboxRow } from "../src/channels/outbox.ts";

// Slice (c) part 3a, item 1 — the SQLite seam.
//
// `outbox.ts` and `exchange-log.ts` both take a `SqliteDb`, and `ManagerStore`
// hid the driver: nothing in production could construct either class, so the v4
// tables existed but no row ever moved. This file pins the narrow facade the
// store exposes instead of the raw driver — the same way `agenda` wraps it — and
// proves both classes run against the REAL migrated tables, across a reopen
// (which is what "survives Manager restart" means for the drain worker).

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-channel-seam-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("ManagerStore — channel persistence facade", () => {
  it("expone `channels` con `exchanges` y `createOutbox` sobre las tablas v4", async () => {
    const store = await openManagerStore(await dataDir());
    stores.push(store);

    assert.ok(store.channels, "ManagerStore debe exponer la persistencia de canales");
    assert.ok(
      store.channels.exchanges instanceof ChannelExchangeLog,
      "exchanges es el log real, no un stub",
    );
    assert.equal(
      typeof store.channels.createOutbox,
      "function",
      "createOutbox fabrica el worker sobre el mismo driver",
    );
  });

  it("el outbox del almacén encola y dreina contra `channel_outbox`", async () => {
    const store = await openManagerStore(await dataDir());
    stores.push(store);

    const sends: OutboxRow[] = [];
    const outbox = store.channels.createOutbox({
      send: async (row) => {
        sends.push(row);
        return `msg-${row.target}`;
      },
    });

    const enqueued = await outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "hola" }),
    });
    assert.equal(enqueued.state, "pending");

    const result = await outbox.drain();
    assert.deepEqual(result, { attempted: 1, delivered: 1, requeued: 0, dead: 0 });
    assert.equal(sends.length, 1);

    const settled = await outbox.byId(enqueued.id);
    assert.equal(settled?.state, "delivered");
    assert.equal(settled?.externalMessageId, "msg-12345");
  });

  it("sobrevive al reopen: una fila pendiente la ve el siguiente proceso", async () => {
    const dir = await dataDir();
    const first = await openManagerStore(dir);
    const pending = await first.channels
      .createOutbox({ send: async () => "nunca-se-llama" })
      .enqueue({
        agentName: "agent",
        kind: "telegram",
        target: "12345",
        payload: JSON.stringify({ text: "en cola antes del reinicio" }),
      });
    first.close();

    const second = await openManagerStore(dir);
    stores.push(second);
    const sent: string[] = [];
    const outbox = second.channels.createOutbox({
      send: async (row) => {
        sent.push(row.text);
        return "msg-1";
      },
    });

    assert.deepEqual((await outbox.pendingOf("agent", "telegram")).map((r) => r.id), [
      pending.id,
    ]);
    await outbox.drain();
    assert.deepEqual(sent, ["en cola antes del reinicio"]);
  });

  it("el espejo de intercambios escribe y lee en `channel_exchanges` del mismo fichero", async () => {
    const dir = await dataDir();
    const store = await openManagerStore(dir);
    store.channels.exchanges.append({
      agentName: "agent",
      turnId: "turn-1",
      origin: "telegram",
      chatId: "12345",
      userText: "hola",
      replyText: "adiós",
      now: 1_761_100_800_000,
    });
    store.close();

    const reopened = await openManagerStore(dir);
    stores.push(reopened);
    const rows = reopened.channels.exchanges.listAfter("agent", 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.turnId, "turn-1");
    assert.equal(reopened.channels.exchanges.latestSeq("agent"), rows[0]?.seq);
  });
});
