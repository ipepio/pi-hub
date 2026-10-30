import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb, type SqliteDb } from "../src/storage/sqlite.ts";
import { ChannelOutbox, OUTBOX_LEASE_MS, type OutboxRow } from "../src/channels/outbox.ts";
import {
  ChannelOutboxWorker,
  OUTBOX_DRAIN_INTERVAL_MS,
  OUTBOX_STOP_GRACE_MS,
} from "../src/channels/outbox-worker.ts";

// Slice (c) part 3a, item 2 — the drain OWNER.
//
// `ChannelOutbox` is a state machine with no scheduler: `drain()` exists and
// nothing called it, so a proactive message could sit in `channel_outbox`
// forever. The worker is the only loop that claims rows, and its two contract
// points are (a) restart-survival — a row left `in_flight` by a killed process
// comes back through the expired lease, and (b) SIGTERM — stop claiming, never
// fake-settle a row that is still out there (the lease is what reclaims it).
//
// The clock is the manual one the outbox already accepts: `notBefore`/backoff
// windows are moved by advancing time, never by sleeping.

const dirs: string[] = [];
const dbs: SqliteDb[] = [];
const workers: ChannelOutboxWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop({ graceMs: 0 });
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Migrated db + a clock the test owns. */
async function fixture(
  options: { leaseMs?: number; send?: (row: OutboxRow) => Promise<string> } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-outbox-worker-"));
  dirs.push(dir);
  const db = await openTestDb(dir);
  dbs.push(db);

  let nowValue = 1_761_100_800_000;
  const sent: OutboxRow[] = [];
  const send =
    options.send ??
    (async (row: OutboxRow) => {
      sent.push(row);
      return `msg-${sent.length}`;
    });
  const leaseMs = options.leaseMs ?? OUTBOX_LEASE_MS;
  const outbox = new ChannelOutbox(db, {
    send,
    now: () => nowValue,
    leaseMs,
    backoffBaseMs: 1_000,
    backoffCapMs: 4_000,
  });
  const log: string[] = [];
  return {
    db,
    leaseMs,
    outbox,
    sent,
    log,
    now: () => nowValue,
    advance(ms: number): void {
      nowValue += ms;
    },
  };
}

function track(worker: ChannelOutboxWorker): ChannelOutboxWorker {
  workers.push(worker);
  return worker;
}

/** Marks a row `in_flight` at `inFlightAt`, the way a crashed process left it. */
function abandonInFlight(db: SqliteDb, id: string, inFlightAt: number, externalMessageId?: string): void {
  db.prepare(
    "UPDATE channel_outbox SET state = 'in_flight', in_flight_at = ?, external_message_id = ? WHERE id = ?",
  ).run(inFlightAt, externalMessageId ?? null, id);
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ChannelOutboxWorker — el dueño del drenado", () => {
  it("usa un intervalo real cuando el caller no fija uno", () => {
    assert.ok(OUTBOX_DRAIN_INTERVAL_MS > 0);
    assert.ok(OUTBOX_STOP_GRACE_MS > 0);
  });

  it("tick() reclama las filas debidas y las entrega", async () => {
    const f = await fixture();
    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox, log: (l) => f.log.push(l) }));

    await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "proactivo" }),
    });

    const result = await worker.tick();
    assert.equal(result.attempted, 1);
    assert.equal(result.delivered, 1);
    assert.deepEqual(f.sent.map((row) => row.text), ["proactivo"]);
  });

  it("no reclama una fila que aún no vence (`next_attempt_at` en el futuro)", async () => {
    const f = await fixture();
    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox }));

    await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "más tarde" }),
      notBefore: f.now() + 60_000,
    });

    assert.equal((await worker.tick()).attempted, 0);
    assert.equal(f.sent.length, 0);

    f.advance(61_000);
    assert.equal((await worker.tick()).delivered, 1);
  });

  it("start() dreina de inmediato y luego en cada tick del intervalo", async () => {
    const f = await fixture();
    const worker = track(
      new ChannelOutboxWorker({ outbox: f.outbox, intervalMs: 5, log: (l) => f.log.push(l) }),
    );

    await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "1",
      payload: JSON.stringify({ text: "inmediata" }),
    });
    worker.start();
    await worker.idle();
    assert.deepEqual(f.sent.map((row) => row.text), ["inmediata"]);

    // Segunda fila, encolada después de arrancar: la recoge un tick del timer.
    await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "2",
      payload: JSON.stringify({ text: "por timer" }),
    });
    await until(() => f.sent.length === 2);
    assert.equal(f.sent[1]?.text, "por timer");
  });

  it("restart-surviving: una fila `in_flight` con el lease vencido se reentrega", async () => {
    const f = await fixture();
    const row = await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "colgada por el crash" }),
    });
    abandonInFlight(f.db, row.id, f.now() - f.leaseMs - 1);

    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox, log: (l) => f.log.push(l) }));
    const result = await worker.tick();

    assert.equal(result.delivered, 1);
    assert.equal((await f.outbox.byId(row.id))?.state, "delivered");
    assert.ok(
      f.log.some((line) => line.includes("CHANNEL_OUTBOX_RECLAIM")),
      `el worker informa del barrido de leases: ${f.log.join(" | ")}`,
    );
  });

  it("no reenvía lo que ya tenía `external_message_id`: lo confirma", async () => {
    const f = await fixture();
    const row = await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "ya fuera" }),
    });
    abandonInFlight(f.db, row.id, f.now() - OUTBOX_LEASE_MS - 1, "msg-real-9");

    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox }));
    await worker.tick();

    assert.equal(f.sent.length, 0, "el transporte no se vuelve a invocar");
    assert.equal((await f.outbox.byId(row.id))?.externalMessageId, "msg-real-9");
  });

  it("lease vivo: otra fila en vuelo NO se reclama (un dueño por fila)", async () => {
    const f = await fixture();
    const row = await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "en vuelo" }),
    });
    abandonInFlight(f.db, row.id, f.now() - 1_000);

    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox }));
    assert.equal((await worker.tick()).attempted, 0);
    assert.equal((await f.outbox.byId(row.id))?.state, "in_flight");
  });

  it("stop() deja de reclamar: nada nuevo sale por el transporte", async () => {
    const f = await fixture();
    const worker = track(new ChannelOutboxWorker({ outbox: f.outbox, intervalMs: 5 }));
    worker.start();
    await worker.idle();
    await worker.stop();

    await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "después del SIGTERM" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(f.sent.length, 0);
    assert.equal((await f.outbox.pendingOf("agent", "telegram")).length, 1);
  });

  it("stop() con un envío colgado: suelta tras la gracia y DEJA la fila in_flight (la recoge el lease)", async () => {
    // El transporte se libera al final del test: un `send` que nunca resuelve
    // dejaría una promesa colgando cuando el proceso de test termina.
    let release!: (messageId: string) => void;
    const f = await fixture({
      send: () => new Promise<string>((resolve) => {
    release = resolve;
      }),
    });
    const row = await f.outbox.enqueue({
      agentName: "agent",
      kind: "telegram",
      target: "12345",
      payload: JSON.stringify({ text: "lento" }),
    });

    const worker = track(
      new ChannelOutboxWorker({ outbox: f.outbox, log: (l) => f.log.push(l) }),
    );
    const hung = worker.tick();
    void hung.catch(() => undefined);
    await until(async () => (await f.outbox.byId(row.id))?.state === "in_flight");
    
    await worker.stop({ graceMs: 10 });
    
    // SIGTERM no falsifica el estado: la fila sigue `in_flight` y la devuelve
    // a la cola el lease de la próxima arrancada.
    assert.equal((await f.outbox.byId(row.id))?.state, "in_flight");
    assert.ok(
      f.log.some((line) => line.includes("CHANNEL_OUTBOX_IN_FLIGHT_LEFT")),
      `SIGTERM informa lo que queda para el lease: ${f.log.join(" | ")}`,
    );
    
    release("msg-lento-1");
    const result = await hung;
    assert.equal(result.delivered, 1, "el tick que sobrevivió al stop confirma su fila");
  });
});


