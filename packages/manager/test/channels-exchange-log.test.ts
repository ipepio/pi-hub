import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/storage/migrations.ts";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import {
  ChannelExchangeLog,
  EXCHANGE_RETENTION_MS,
  EXCHANGE_FEED_DEFAULT_LIMIT,
  type ChannelExchangeOrigin,
} from "../src/channels/exchange-log.ts";

// Slice (c) part 2b, item 3 — the projection-in mirror the Dashboard drains.
//
// P produces channel-origin exchanges (the Manager runs those turns) and there
// is no P→D trust direction, so the exchange is persisted HERE and D pulls it
// through `GET /agents/:name/channel-exchanges?after=<seq>`. These tests pin:
//   - the table exists in migration v4 and its `origin` CHECK excludes `human`
//     (a web turn is D's own transcript, never a mirror row — design §1.2);
//   - `turn_id` is UNIQUE so an at-least-once delivery hook cannot double-append;
//   - the feed is ordered by a monotonic seq (the D cursor), bounded per call and
//     scoped to one Agent;
//   - the feed is PRUNED: a 30-day window, because an unbounded mirror would grow
//     forever with no owner (design §6.2 — the invariant is "bounded", the
//     constant is not).

const openDbs: SqliteDb[] = [];

function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db as unknown as SqliteDb);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_761_100_800_000;

describe("channel_exchanges — migration v4", () => {
  it("v4 crea la tabla con turn_id único y origin sin 'human'", () => {
    const db = openMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    assert.ok(
      tables.some((table) => table.name === "channel_exchanges"),
      "channel_exchanges presente en v4",
    );

    const ddl = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'channel_exchanges'")
        .get() as { sql: string }
    ).sql;
    assert.match(ddl, /turn_id TEXT NOT NULL UNIQUE/);
    // `human` está deliberadamente fuera del vocabulario: un turno web ya lo
    // escribe el Dashboard, y duplicarlo aquí sería un segundo amo del transcript.
    assert.match(ddl, /origin TEXT NOT NULL CHECK \(origin IN \('telegram', 'proactive'\)\)/);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO channel_exchanges
               (agent_name, turn_id, origin, chat_id, user_text, reply_text, created_at)
             VALUES ('agent', 't-web', 'human', NULL, 'h', 'r', 1)`,
          )
          .run(),
      /CHECK constraint failed/,
    );
  });

  it("un turn_id duplicado choca con el índice único (append at-least-once)", () => {
    const db = openMemoryDb();
    const log = new ChannelExchangeLog(db);
    log.append({
      agentName: "agent",
      turnId: "t-1",
      origin: "telegram",
      chatId: "chat-1",
      userText: "hola",
      replyText: "adiós",
      now: NOW,
    });
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO channel_exchanges
               (agent_name, turn_id, origin, chat_id, user_text, reply_text, created_at)
             VALUES ('agent', 't-1', 'telegram', 'chat-1', 'h', 'r', 1)`,
          )
          .run(),
      /UNIQUE constraint failed/,
    );
  });
});

describe("ChannelExchangeLog — append / feed / prune", () => {
  it("append asigna un seq monótono y listAfter devuelve el cursor exclusivo", () => {
    const log = new ChannelExchangeLog(openMemoryDb());
    const first = log.append({
      agentName: "agent",
      turnId: "t-1",
      origin: "telegram",
      chatId: "chat-1",
      userText: "primera",
      replyText: "respuesta 1",
      now: NOW,
    });
    const second = log.append({
      agentName: "agent",
      turnId: "t-2",
      origin: "proactive",
      chatId: "chat-1",
      userText: "",
      replyText: "aviso del agenda",
      now: NOW + 1,
    });

    assert.ok(second.seq > first.seq, "el seq es monotónico");
    assert.equal(first.origin satisfies ChannelExchangeOrigin, "telegram");
    assert.equal(first.chatId, "chat-1");
    assert.equal(first.replyText, "respuesta 1");

    const afterFirst = log.listAfter("agent", first.seq);
    assert.deepEqual(
      afterFirst.map((row) => row.turnId),
      ["t-2"],
      "el cursor es exclusivo: D vuelve a pedir desde el último seq visto",
    );
    assert.deepEqual(
      log.listAfter("agent", 0).map((row) => row.turnId),
      ["t-1", "t-2"],
    );
  });

  it("el feed está acotado por Agent y por tamaño máximo", () => {
    const log = new ChannelExchangeLog(openMemoryDb());
    for (let index = 0; index < 5; index += 1) {
      log.append({
        agentName: "agent",
        turnId: `t-${index}`,
        origin: "telegram",
        chatId: "chat-1",
        userText: "h",
        replyText: "r",
        now: NOW + index,
      });
    }
    log.append({
      agentName: "otra",
      turnId: "t-otros",
      origin: "telegram",
      chatId: "chat-9",
      userText: "h",
      replyText: "r",
      now: NOW,
    });

    assert.deepEqual(log.listAfter("agent", 0, 2).map((row) => row.turnId), ["t-0", "t-1"]);
    assert.equal(log.listAfter("otra", 0).length, 1);
    assert.equal(log.latestSeq("agent") >= 5, true);
    assert.equal(log.latestSeq("inexistente"), 0);
  });

  it("prune deja el feed acotado a la ventana de retención", () => {
    const log = new ChannelExchangeLog(openMemoryDb());
    log.append({
      agentName: "agent",
      turnId: "viejo",
      origin: "telegram",
      chatId: "chat-1",
      userText: "h",
      replyText: "r",
      now: NOW - EXCHANGE_RETENTION_MS - 1,
    });
    log.append({
      agentName: "agent",
      turnId: "joven",
      origin: "telegram",
      chatId: "chat-1",
      userText: "h",
      replyText: "r",
      now: NOW - EXCHANGE_RETENTION_MS + DAY_MS,
    });

    const removed = log.prune(NOW);
    assert.equal(removed, 1);
    assert.deepEqual(log.listAfter("agent", 0).map((row) => row.turnId), ["joven"]);
    assert.equal(EXCHANGE_RETENTION_MS, 30 * DAY_MS, "retención de 30 días por diseño");
  });

  it("re-apendar el mismo turn_id es idempotente: ni lanza ni duplica", () => {
    const log = new ChannelExchangeLog(openMemoryDb());
    const input = {
      agentName: "agent",
      turnId: "t-dup",
      origin: "telegram" as const,
      chatId: "chat-1",
      userText: "h",
      replyText: "r-1",
      now: NOW,
    };
    const first = log.append(input);
    const again = log.append({ ...input, replyText: "r-2", now: NOW + 5 });

    assert.equal(again.seq, first.seq, "la segunda llamada no crea fila");
    assert.equal(again.replyText, "r-1", "la primera escritura gana");
    assert.equal(log.listAfter("agent", 0).length, 1);
  });

  it("el feed respeta el límite por defecto (nunca un volcado ilimitado)", () => {
    const log = new ChannelExchangeLog(openMemoryDb());
    for (let index = 0; index < EXCHANGE_FEED_DEFAULT_LIMIT + 5; index += 1) {
      log.append({
        agentName: "agent",
        turnId: `t-${index}`,
        origin: "telegram",
        chatId: "chat-1",
        userText: "h",
        replyText: "r",
        now: NOW + index,
      });
    }
    assert.equal(log.listAfter("agent", 0).length, EXCHANGE_FEED_DEFAULT_LIMIT);
  });

  // B2 (verify round, revocation 3c): Agent deletion is a purge, and the mirror
  // feed is SQLite state that `deleteAgent()` (rm -rf of the agent dir) cannot
  // reach. `prune()` is age-based, so without an agent-scoped delete the exchanges
  // of a purged Agent would linger for 30 days — and a NEW Agent reusing the name
  // would inherit somebody else's transcript.
  it("deleteForAgent borra SOLO el feed del Agent purgado", () => {
    const db = openMemoryDb();
    const log = new ChannelExchangeLog(db);
    log.append({
      agentName: "agent",
      turnId: "t-purged-1",
      origin: "telegram",
      chatId: "chat-1",
      userText: "h",
      replyText: "r",
      now: NOW,
    });
    log.append({
      agentName: "agent",
      turnId: "t-purged-2",
      origin: "proactive",
      chatId: null,
      userText: "",
      replyText: "r2",
      now: NOW + 1,
    });
    log.append({
      agentName: "vecina",
      turnId: "t-keep",
      origin: "telegram",
      chatId: "chat-9",
      userText: "h",
      replyText: "r",
      now: NOW + 2,
    });

    assert.equal(log.deleteForAgent("agent"), 2);
    assert.deepEqual(log.listAfter("agent", 0), [], "el feed del purgado desaparece");
    assert.deepEqual(
      log.listAfter("vecina", 0).map((row) => row.turnId),
      ["t-keep"],
      "el de otra Agent no se toca",
    );
    assert.equal(log.deleteForAgent("agent"), 0, "idempotente");
  });
});
