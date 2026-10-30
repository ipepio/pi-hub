import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentPaths,
  readAgent,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { ChannelAdapter } from "@pihub/channels";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { openTestDb } from "../src/storage/sqlite.ts";
import {
  HumanRequestDeliveriesRepository,
  type HumanRequest,
} from "../src/agenda/human-requests.ts";
import {
  HumanRequestDelivery,
  deliveryCardText,
} from "../src/primary-channel/human-request-delivery.ts";
import { openChannelPersistence } from "../src/channels/persistence.ts";
import { ChannelRuntimeRegistry } from "../src/channels/registry.ts";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords } from "../src/channels/store.ts";
import {
  composeChannels,
  type ChannelComposition,
} from "../src/channels/composition.ts";
import type {
  StartTurnCommand,
  TurnExecution,
} from "../src/agenda/turn-execution.ts";

// FIX H3 (slice (c) review round 2, HIGH) — the waiting-human card was DEAD.
//
// `HumanRequestDelivery` gated every Telegram delivery on `config.telegramToken`,
// a field that has not been written into `agent.json` since the channels
// cutover. The gate therefore never opened: a `waiting_human` card silently
// stopped reaching Telegram — no row, no send, no log line.
//
// The fix routes the card through the SAME door every other non-web message
// uses (delivery router → `channel_outbox` → live adapter) and decides
// «can this be delivered?» from the BINDING (pairing state + projected channel),
// never from a token in the Agent config. These tests pin the whole path:
//   1. bound telegram channel → one outbox row, drained onto the live adapter,
//      with an `agent.json` that carries no `telegramToken` at all;
//   2. no bound channel → the documented skip, with zero queue rows;
//   3. a pending HITL row is re-queued through the outbox, not through a bot
//      client — the outbox is the only retry owner.

const dirs: string[] = [];
const dbs: SqliteDb[] = [];
const compositions: ChannelComposition[] = [];

const BOT_TOKEN = "771234:AA-secreto-de-bot-telegram";
const CHAT_ID = "424242";

async function setup(agentName = "alice"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-hitl-delivery-"));
  dirs.push(dir);
  await scaffoldGlobalDirs(dir);
  await scaffoldAgentDirs(dir, agentName);
  // Post-cutover `agent.json`: no `telegramToken` anywhere. The delivery must
  // not need one to work.
  await writeAgent(dir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dir;
}

afterEach(async () => {
  for (const composition of compositions.splice(0)) {
    await composition.worker.stop({ graceMs: 0 });
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Fake transport, so nothing here touches the network. */
function fakeTransport() {
  const sends: Array<{ chatId: string; text: string }> = [];
  const adapterFactory = (): ChannelAdapter => ({
    kind: "telegram",
    async start(): Promise<void> {},
    async send({ chatId, text }) {
      sends.push({ chatId, text });
      return { messageId: `msg-${sends.length}` };
    },
    async stop(): Promise<void> {},
  });
  return { sends, adapterFactory };
}

function fakeTurns(): Pick<TurnExecution, "startTurn"> {
  return {
    startTurn(command: StartTurnCommand) {
      return {
        completion: Promise.resolve({
          event: "turn-complete",
          data: { turnId: command.turnId },
        }),
        disconnect(): void {},
      };
    },
  } as unknown as Pick<TurnExecution, "startTurn">;
}

/** A question of the shape `TurnExecution.onHumanRequest` hands over. */
function requestOf(overrides: Partial<HumanRequest> = {}): HumanRequest {
  return {
    agentName: "alice",
    initiativeId: "ini-hitl",
    requestId: "req-hitl",
    turnId: "turn-hitl",
    toolCallId: "tool-hitl",
    question: "¿Cuál es el plan?",
    summary: "resumen del contexto",
    expiresAt: 1_760_000_000_000,
    ...overrides,
  };
}

interface Harness {
  dataDir: string;
  db: SqliteDb;
  deliveries: HumanRequestDeliveriesRepository;
  registry: ChannelRuntimeRegistry;
  pairing: PairingMachine;
  composition: ChannelComposition;
  transport: ReturnType<typeof fakeTransport>;
}

async function harness(dataDir: string): Promise<Harness> {
  const db = await openTestDb(dataDir);
  dbs.push(db);
  const transport = fakeTransport();
  const registry = new ChannelRuntimeRegistry({
    adapterFactory: transport.adapterFactory,
  });
  const pairing = new PairingMachine({ dataDir, now: () => 1_761_100_800_000 });
  const composition = composeChannels({
    dataDir,
    persistence: openChannelPersistence(db),
    registry,
    pairing,
    turns: fakeTurns(),
    resolveRunner: async () => ({ port: 4100 }),
    log: () => {},
  });
  compositions.push(composition);
  return {
    dataDir,
    db,
    deliveries: new HumanRequestDeliveriesRepository(db),
    registry,
    pairing,
    composition,
    transport,
  };
}

/** Project a live telegram channel exactly like `PUT /agents/:name/channels`. */
async function projectChannel(h: Harness): Promise<void> {
  const records = await h.registry.replaceAll("alice", [
    {
      kind: "telegram",
      token: BOT_TOKEN,
      // Open auto-pair window: the binding below is the Dashboard's own flow.
      pairingWindowEndsAt: "2036-01-01T00:00:00.000Z",
    },
  ]);
  await writeChannelRecords(h.dataDir, "alice", records);
  const result = await h.pairing.requestPairing("alice", "telegram", CHAT_ID);
  assert.equal(result.autoPaired, true, "el canal debe vincularse en la ventana abierta");
}

/** The Initiative row `human_request_deliveries.initiative_id` points at (FK). */
function seedInitiative(
  db: SqliteDb,
  input: {
    id: string;
    requestId: string;
    question: string;
    summary: string;
    expiresAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, intent, mode, session_key, available_at,
        bound_model, chain_depth, visible_effects_declared, summary, created_at,
        state_changed_at, human_question, human_expires_at, human_request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    "alice",
    "waiting_human",
    "human",
    "haz algo",
    "solo",
    "agent:alice:main",
    1,
    "gpt-5",
    0,
    0,
    input.summary,
    1000,
    1000,
    input.question,
    input.expiresAt ?? 1_760_000_000_000,
    input.requestId,
  );
}

describe("HITL delivery through the channel outbox (fix H3)", () => {
  it("bound telegram channel: the card becomes an outbox row with no agent.json token", async () => {
    const dataDir = await setup();
    const h = await harness(dataDir);
    await projectChannel(h);
    seedInitiative(h.db, {
      id: "ini-hitl",
      requestId: "req-hitl",
      question: "¿Cuál es el plan?",
      summary: "resumen del contexto",
    });

    const logs: string[] = [];
    const delivery = new HumanRequestDelivery({
      deliveries: h.deliveries,
      channel: h.composition.hitl,
      log: (line) => logs.push(line),
    });

    // No `client`, no `agentConfigFor`, no `primaryChatId`: the binding IS the
    // credential question, and it is a channel fact.
    await delivery.deliver(requestOf());

    const rows = await h.composition.outbox.pendingOf("alice", "telegram");
    assert.equal(rows.length, 1, "la tarjeta entra en la cola del canal");
    assert.equal(rows[0].target, CHAT_ID, "el destino es el VÍNCULO");
    assert.equal(
      rows[0].text,
      deliveryCardText("¿Cuál es el plan?", "resumen del contexto", 1_760_000_000_000),
    );
    assert.deepEqual(logs, [], "una entrega encolada no es un fallo");

    // The durable HITL reservation still lands: at-least-once evidence.
    assert.ok(
      h.deliveries.lookupDelivery("alice", "telegram", CHAT_ID, "pending:req-hitl"),
      "la fila pending de human_request_deliveries existe",
    );

    // And the queue's own drain puts it on the transport.
    await h.composition.worker.tick();
    const card = rows[0].text;
    assert.deepEqual(h.transport.sends, [{ chatId: CHAT_ID, text: card }]);
    const delivered = await h.composition.outbox.byId(rows[0].id);
    assert.equal(delivered?.state, "delivered");
    assert.equal(delivered?.externalMessageId, "msg-1");

    // No secret leaves the process: the queue row and `agent.json` carry none.
    const onDisk = await fs.readFile(
      agentPaths(dataDir, "alice").configFile,
      "utf8",
    );
    assert.equal(onDisk.includes("telegramToken"), false);
    assert.equal(
      JSON.stringify(await h.composition.outbox.pendingOf("alice", "telegram")).includes(
        BOT_TOKEN,
      ),
      false,
    );
  });

  it("sin canal vinculado: skip documentado, cero filas de outbox y cero reservas", async () => {
    const dataDir = await setup();
    const h = await harness(dataDir);
    const logs: string[] = [];
    const delivery = new HumanRequestDelivery({
      deliveries: h.deliveries,
      channel: h.composition.hitl,
      log: (line) => logs.push(line),
    });

    await delivery.deliver(requestOf({ requestId: "req-unbound" }));

    assert.equal((await h.composition.outbox.pendingOf("alice", "telegram")).length, 0);
    assert.deepEqual(h.deliveries.listPendingDeliveries("alice"), []);
    assert.ok(
      logs.some(
        (line) =>
          line.includes("HUMAN_REQUEST_DELIVERY_SKIPPED") &&
          line.includes("reason=no_bound_channel") &&
          line.includes("agent=alice"),
      ),
      `skip no registrado: ${logs.join(" | ")}`,
    );
  });

  it("retry de una fila pending: vuelve al outbox, nunca a un cliente de token", async () => {
    const dataDir = await setup();
    const h = await harness(dataDir);
    await projectChannel(h);
    seedInitiative(h.db, {
      id: "ini-retry",
      requestId: "req-retry",
      question: "¿Cuál es la prioridad?",
      summary: "el cliente espera",
    });
    h.db
      .prepare(
        `INSERT INTO human_request_deliveries
           (human_request_id, agent_name, initiative_id, channel,
            external_chat_id, external_message_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run("req-retry", "alice", "ini-retry", "telegram", CHAT_ID, "pending:req-retry", 1000);

    const delivery = new HumanRequestDelivery({
      deliveries: h.deliveries,
      channel: h.composition.hitl,
      log: () => {},
    });

    await delivery.retryPendingDeliveries("alice");

    const rows = await h.composition.outbox.pendingOf("alice", "telegram");
    assert.equal(rows.length, 1, "la fila pending se re-encola por el outbox");
    assert.ok(rows[0].text.includes("¿Cuál es la prioridad?"), "reconstruye la pregunta");
    assert.ok(rows[0].text.includes("el cliente espera"), "reconstruye el summary");
  });

  it("el Agent no necesita ningún config resolver para que la tarjeta salga", async () => {
    const dataDir = await setup();
    const config = await readAgent(dataDir, "alice");
    assert.equal(config?.telegramToken, undefined, "sin residuo de token");
    assert.equal(
      "telegramToken" in (config ?? {}),
      false,
      "ni siquiera la clave: el gate de H3 no puede leerla",
    );
  });
});
