import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import {
  ChannelDeliveryRouter,
  type EnqueueOutboxFn,
} from "../src/channels/delivery-router.ts";
import { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import type { CompletedTurn } from "../src/agenda/turn-execution.ts";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";

// Slice (c) part 2b, items 1 (delivery half) + 6 — the delivery-by-origin table
// of design §1.4, in code, with one owner per decision:
//
//   origin            outbox push          web transcript (channel_exchanges)
//   human (web)       NEVER                NEVER (D writes it: authoritative)
//   channel (telegram) always → bound chat mirrored
//   initiative         only if a channel is mirrored together with the delivery
//                      bound and active
//
// The router is the only writer of the outbox and of the mirror, so "did this
// reply leave pihub, and where" has exactly one answer. The TurnExecution hook
// reports facts; nothing here knows about WebSockets.

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

const NOW = 1_761_100_800_000;

function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  dbs.push(db);
  return db;
}

async function setup(agentName = "agent"): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-delivery-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  await writeAgent(dataDir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  dirs.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

function record(pairingWindowEndsAt: string | null = null): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "b".repeat(64),
    pairingWindowEndsAt,
    observedStatus: "active",
    updatedAt: NOW,
  };
}

function enqueueSink() {
  const rows: Array<{ agentName: string; kind: string; target: string; payload: string }> = [];
  const enqueue: EnqueueOutboxFn = async (input) => {
    rows.push({
      agentName: input.agentName,
      kind: input.kind,
      target: input.target,
      payload: input.payload,
    });
  };
  return { rows, enqueue };
}

function turn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    agentName: "agent",
    turnId: "turn-1",
    origin: { kind: "channel", channelKind: "telegram", chatId: "12345" },
    userText: "hola",
    replyText: "adiós",
    finalEvent: "turn-complete",
    ...overrides,
  };
}

async function boundRouter(dataDir: string, sink = enqueueSink()) {
  const pairing = new PairingMachine({ dataDir });
  await writeChannelRecords(dataDir, "agent", [record("2099-01-01T00:00:00.000Z")]);
  await pairing.requestPairing("agent", "telegram", "12345");
  const exchanges = new ChannelExchangeLog(openMemoryDb());
  const router = new ChannelDeliveryRouter({
    dataDir,
    pairing,
    enqueue: sink.enqueue,
    exchanges,
    now: () => NOW,
  });
  return { pairing, router, sink, exchanges };
}

describe("ChannelDeliveryRouter — delivery-by-origin (design §1.4)", () => {
  it("un turno de canal se entrega por el outbox Y se refleja en el mirror", async () => {
    const dataDir = await setup();
    const { router, sink, exchanges } = await boundRouter(dataDir);

    await router.onTurnCompletedAsync(turn());

    assert.deepEqual(sink.rows, [
      {
        agentName: "agent",
        kind: "telegram",
        target: "12345",
        payload: JSON.stringify({ text: "adiós" }),
      },
    ]);
    const feed = exchanges.listAfter("agent", 0);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.origin, "telegram");
    assert.equal(feed[0]!.chatId, "12345");
    assert.equal(feed[0]!.userText, "hola");
    assert.equal(feed[0]!.replyText, "adiós");
  });

  it("la entrega va al chat ENLAZADO, no al chat que traía el turno", async () => {
    const dataDir = await setup();
    const { router, sink } = await boundRouter(dataDir);
    // Un chat distinto (el binding real es la única autoridad del destino).
    await router.onTurnCompletedAsync(
      turn({ origin: { kind: "channel", channelKind: "telegram", chatId: "otro-chat" } }),
    );
    assert.equal(sink.rows[0]!.target, "12345");
  });

  it("un turno web NO toca el outbox ni el mirror: el transcript lo escribe D", async () => {
    const dataDir = await setup();
    const { router, sink, exchanges } = await boundRouter(dataDir);

    await router.onTurnCompletedAsync(turn({ origin: { kind: "human" } }));

    assert.deepEqual(sink.rows, []);
    assert.deepEqual(exchanges.listAfter("agent", 0), []);
  });

  it("una Iniciativa con canal activo se entrega a ambos lados", async () => {
    const dataDir = await setup();
    const { router, sink, exchanges } = await boundRouter(dataDir);

    await router.onTurnCompletedAsync(
      turn({
        turnId: "turn-init",
        origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
        userText: "",
        replyText: "aviso del agenda",
      }),
    );

    assert.equal(sink.rows.length, 1);
    assert.equal(sink.rows[0]!.target, "12345");
    assert.equal(exchanges.listAfter("agent", 0)[0]!.origin, "proactive");
  });

  it("una Iniciativa sin canal enlazado no inventa una entrega por canal", async () => {
    const dataDir = await setup();
    const pairing = new PairingMachine({ dataDir });
    await writeChannelRecords(dataDir, "agent", [record(null)]); // sin binding
    const exchanges = new ChannelExchangeLog(openMemoryDb());
    const sink = enqueueSink();
    const router = new ChannelDeliveryRouter({
      dataDir,
      pairing,
      enqueue: sink.enqueue,
      exchanges,
      now: () => NOW,
    });

    await router.onTurnCompletedAsync(
      turn({ origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" } }),
    );

    assert.deepEqual(sink.rows, []);
    assert.deepEqual(exchanges.listAfter("agent", 0), [], "nada salió por el canal");
  });

  it("un terminal de error o abort nunca entrega texto vacío", async () => {
    const dataDir = await setup();
    const { router, sink, exchanges } = await boundRouter(dataDir);

    await router.onTurnCompletedAsync(turn({ finalEvent: "turn-error", replyText: "" }));
    await router.onTurnCompletedAsync(turn({ turnId: "turn-2", finalEvent: "turn-aborted", replyText: "" }));
    await router.onTurnCompletedAsync(turn({ turnId: "turn-3", replyText: "   " }));

    assert.deepEqual(sink.rows, []);
    assert.deepEqual(exchanges.listAfter("agent", 0), []);
  });

  it("un reenvío del mismo turno no duplica la fila del mirror (at-least-once)", async () => {
    const dataDir = await setup();
    const { router, exchanges } = await boundRouter(dataDir);

    await router.onTurnCompletedAsync(turn());
    await router.onTurnCompletedAsync(turn({ replyText: "adiós otra vez" }));

    const feed = exchanges.listAfter("agent", 0);
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.replyText, "adiós");
  });

  it("`handle` es fire-and-forget: nunca lanza hacia el puente de turnos", async () => {
    const dataDir = await setup();
    const pairing = new PairingMachine({ dataDir });
    const router = new ChannelDeliveryRouter({
      dataDir,
      pairing,
      enqueue: () => {
        throw new Error("outbox caído");
      },
      exchanges: new ChannelExchangeLog(openMemoryDb()),
      now: () => NOW,
      log: () => {},
    });

    assert.doesNotThrow(() => router.handle(turn()));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});

describe("ChannelDeliveryRouter — proactive enqueue (item 6)", () => {
  it("exposes an internal enqueue path for agenda/autonomy messages", async () => {
    const dataDir = await setup();
    const { router, sink, exchanges } = await boundRouter(dataDir);

    const delivered = await router.enqueueProactive({
      agentName: "agent",
      text: "recordatorio del agenda",
      turnId: "turn-pro",
    });

    assert.equal(delivered, true);
    assert.deepEqual(sink.rows, [
      {
        agentName: "agent",
        kind: "telegram",
        target: "12345",
        payload: JSON.stringify({ text: "recordatorio del agenda" }),
      },
    ]);
    assert.equal(exchanges.listAfter("agent", 0)[0]!.origin, "proactive");
  });

  it("sin canal enlazado devuelve false y no encola nada", async () => {
    const dataDir = await setup();
    const pairing = new PairingMachine({ dataDir });
    await writeChannelRecords(dataDir, "agent", [record(null)]);
    const sink = enqueueSink();
    const router = new ChannelDeliveryRouter({
      dataDir,
      pairing,
      enqueue: sink.enqueue,
      exchanges: new ChannelExchangeLog(openMemoryDb()),
      now: () => NOW,
    });

    const delivered = await router.enqueueProactive({ agentName: "agent", text: "hola" });
    assert.equal(delivered, false);
    assert.deepEqual(sink.rows, []);
  });

  it("un texto vacío no se entrega: no existe el mensaje vacío por contrato", async () => {
    const dataDir = await setup();
    const { router, sink } = await boundRouter(dataDir);
    const delivered = await router.enqueueProactive({ agentName: "agent", text: "  " });
    assert.equal(delivered, false);
    assert.deepEqual(sink.rows, []);
  });
});
