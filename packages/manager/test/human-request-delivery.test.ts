/**
 * P3.4 — HumanRequestDelivery (A10): entrega at-least-once al canal primario
 * de Telegram con cliente Bot API inyectable (fake).
 *
 * Cubre: sin primary / sin token / Agent inválido (fail-closed, cero llamadas),
 * Gobernado con primary válido, éxito+INSERT (pending → message_id real),
 * fallos 401/429/500/network/json (log saneado, nunca lanza al caller),
 * éxito Telegram + fallo SQLite (fila queda pending), duplicado de fila ya
 * delivered (no reenvía), fila pending (sí reintenta), normalización de IDs
 * TEXT, tarjeta sin IDs/secretos, retry que reconstruye question/summary/
 * deadline y lookupDelivery con scope A/B (null fuera del Agent).
 *
 * Mutación exigida: relanzar el fallo Telegram hacia la pausa (que deliver
 * rechace en vez de loguear) → "Telegram failure keeps waiting_human and
 * releases the Loop slot" se pone ROJO.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import {
  HumanRequestDeliveriesRepository,
  HumanRequestRepository,
  type HumanRequest,
} from "../src/agenda/human-requests.ts";
import {
  HumanRequestDelivery,
  deliveryCardText,
  type TelegramBotClient,
  type TelegramSendMessageParams,
} from "../src/primary-channel/human-request-delivery.ts";
import type { AgentConfig } from "@pihub/shared";

const openDbs: SqliteDb[] = [];

function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Cliente Bot API fake: registra llamadas y puede fallar de forma configurable. */
class FakeTelegramClient implements TelegramBotClient {
  readonly calls: Array<{ token: string; params: TelegramSendMessageParams }> = [];
  /** Fallo a lanzar en la siguiente llamada (o `null` = éxito). */
  failure: unknown = null;
  private nextMessageId = 1000;

  async sendMessage(token: string, params: TelegramSendMessageParams): Promise<{ message_id: number }> {
    this.calls.push({ token, params });
    if (this.failure !== null) throw this.failure;
    return { message_id: this.nextMessageId++ };
  }

  get tokensSent(): string[] {
    return this.calls.map((call) => call.token);
  }

  get textsSent(): string[] {
    return this.calls.map((call) => call.params.text);
  }
}

/** Resolver agent-scoped con un mapa de AgentConfig por nombre. */
function resolverFor(agents: Record<string, AgentConfig>): (agentName: string) => Promise<AgentConfig | null> {
  return async (agentName) => agents[agentName] ?? null;
}

function tokenOf(name: string): string {
  return `bot-${name}-secret-token`;
}

function configOf(name: string): AgentConfig {
  return {
    name,
    port: 4000,
    model: "gpt-5",
    telegramToken: tokenOf(name),
    enabled: true,
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

/** Request con IDs/secretos distintivos para detectar fugas en la tarjeta. */
function requestOf(overrides: Partial<HumanRequest> = {}): HumanRequest {
  return {
    agentName: "alice",
    initiativeId: "ini-leak-test",
    requestId: "req-leak-test",
    turnId: "turn-leak-test",
    toolCallId: "tool-leak-test",
    question: "¿Cuál es el plan?",
    summary: "resumen del contexto",
    expiresAt: 1_760_000_000_000,
    ...overrides,
  };
}

/** Siembra una Initiative `running` con turno reservado (patrón de P3.2). */
function seedRunning(
  db: SqliteDb,
  overrides: {
    id?: string;
    agentName?: string;
    turnId?: string;
    question?: string;
    summary?: string;
    expiresAt?: number;
    requestId?: string;
  } = {},
): void {
  const id = overrides.id ?? "ini-1";
  const agentName = overrides.agentName ?? "alice";
  const turnId = overrides.turnId ?? `turn-${overrides.requestId ?? "1"}`;

  db.prepare(
    `INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at)
     VALUES (?,?,?,?)`,
  ).run(agentName, turnId, `idem-${turnId}`, 1000);

  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at,
        pending_human_input, human_response_idempotency_key,
        human_response_command_hash, human_question, human_expires_at,
        human_request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, agentName, "running", "human", null, "haz algo", "solo", "sk-sesion",
    1, "gpt-5", turnId, 0, null, 0,
    overrides.summary ?? "resumen", null, null, null, 1000, 1000, 1000, null,
    null, null, null,
    overrides.question ?? "¿Cuál es el plan?",
    overrides.expiresAt ?? 1_760_000_000_000,
    overrides.requestId ?? "req-1",
  );
}

/** Siembra la Initiative running que respalda un request (FK de deliveries). */
function seedFor(db: SqliteDb, req: HumanRequest): void {
  seedRunning(db, {
    id: req.initiativeId,
    agentName: req.agentName,
    turnId: `turn-${req.requestId}`,
    requestId: req.requestId,
    question: req.question,
    summary: req.summary,
    expiresAt: req.expiresAt,
  });
}

/** Inserta una fila de delivery directamente (para casos de retry/pending). */
function seedDelivery(
  db: SqliteDb,
  row: {
    humanRequestId?: string;
    agentName?: string;
    initiativeId?: string;
    chatId?: string;
    messageId?: string;
    createdAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO human_request_deliveries
       (human_request_id, agent_name, initiative_id, channel,
        external_chat_id, external_message_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    row.humanRequestId ?? "req-1",
    row.agentName ?? "alice",
    row.initiativeId ?? "ini-1",
    "telegram",
    row.chatId ?? "424242",
    row.messageId ?? "pending:req-1",
    row.createdAt ?? 1000,
  );
}

function rowOf(db: SqliteDb, requestId: string): {
  external_chat_id: string;
  external_message_id: string;
} | undefined {
  return db
    .prepare(
      `SELECT external_chat_id, external_message_id FROM human_request_deliveries
        WHERE human_request_id = ?`,
    )
    .get(requestId) as { external_chat_id: string; external_message_id: string } | undefined;
}

function rowsOf(db: SqliteDb): Array<{ human_request_id: string; external_message_id: string }> {
  return db
    .prepare(
      `SELECT human_request_id, external_message_id FROM human_request_deliveries
        ORDER BY created_at, external_message_id`,
    )
    .all() as Array<{ human_request_id: string; external_message_id: string }>;
}

describe("HumanRequestDelivery (P3.4 A10)", () => {
  it("sin primary chat: fail-closed, cero llamadas al cliente y cero filas", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const deliveries = new HumanRequestDeliveriesRepository(db);
    let resolverCalls = 0;
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      // primaryChatId ausente: no-op aunque el Agent tenga token.
      agentConfigFor: async () => {
        resolverCalls += 1;
        return configOf("alice");
      },
    });

    await delivery.deliver(requestOf());

    assert.equal(client.calls.length, 0);
    assert.equal(rowsOf(db).length, 0);
    assert.equal(resolverCalls, 0, "sin primary no debe ni resolver el Agent");
  });

  it("sin token (o Agent inválido): fail-closed, cero llamadas y cero filas", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const deliveries = new HumanRequestDeliveriesRepository(db);
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: async () => ({ ...configOf("alice"), telegramToken: undefined }),
    });

    await delivery.deliver(requestOf());
    assert.equal(client.calls.length, 0);
    assert.equal(rowsOf(db).length, 0);

    // Agent inexistente → resolver devuelve null → mismo no-op.
    const noAgent = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: async () => null,
    });
    await noAgent.deliver(requestOf());
    assert.equal(client.calls.length, 0);
    assert.equal(rowsOf(db).length, 0);
  });

  it("Gobernado con primary válido: envía una vez y la fila pasa pending → message_id", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const deliveries = new HumanRequestDeliveriesRepository(db);
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });

    seedFor(db, requestOf());
    await delivery.deliver(requestOf());

    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.tokensSent, [tokenOf("alice")]);
    const row = rowOf(db, "req-leak-test");
    assert.ok(row, "debe existir la fila de delivery");
    assert.equal(row.external_chat_id, "424242");
    assert.match(row.external_message_id, /^100[0-9]+$/, "placeholder sustituido por message_id real");
    assert.notEqual(row.external_message_id, "pending:req-leak-test");
  });

  it("exito + INSERT: la reserva pending queda not_delivered y se sustituye tras el send", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const deliveries = new HumanRequestDeliveriesRepository(db);
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
      now: () => 1234,
    });

    seedFor(db, requestOf({ requestId: "req-1", initiativeId: "ini-1" }));
    await delivery.deliver(requestOf({ requestId: "req-1", initiativeId: "ini-1" }));

    const before = db
      .prepare("SELECT COUNT(*) AS n FROM human_request_deliveries WHERE external_message_id = 'pending:req-1'")
      .get() as { n: number };
    assert.equal(before.n, 0, "tras el éxito no debe quedar ninguna fila pending");
    const row = rowOf(db, "req-1");
    assert.equal(row?.external_chat_id, "424242");
    assert.equal(row?.external_message_id, "1000");
    const createdAt = db
      .prepare("SELECT created_at FROM human_request_deliveries WHERE human_request_id = 'req-1'")
      .get() as { created_at: number };
    assert.equal(createdAt.created_at, 1234);
  });

  for (const [status, reason] of [
    [401, "401"],
    [429, "429"],
    [500, "500"],
  ] as const) {
    it(`fallo HTTP ${status}: log HUMAN_REQUEST_DELIVERY_FAILED reason=${reason}, nunca lanza`, async () => {
      const db = openMemoryDb();
      const client = new FakeTelegramClient();
      const logs: string[] = [];
      const deliveries = new HumanRequestDeliveriesRepository(db);
      client.failure = { status };
      const delivery = new HumanRequestDelivery({
        client,
        deliveries,
        primaryChatId: 424242,
        agentConfigFor: resolverFor({ alice: configOf("alice") }),
        log: (line) => logs.push(line),
      });

      seedFor(db, requestOf({ requestId: `req-${status}` }));
      await delivery.deliver(requestOf({ requestId: `req-${status}` }));

      assert.equal(client.calls.length, 1);
      assert.ok(logs.some((line) => line === `HUMAN_REQUEST_DELIVERY_FAILED reason=${reason} agent=alice`));
      const row = rowOf(db, `req-${status}`);
      assert.equal(row?.external_message_id, `pending:req-${status}`, "sin send confirmado la fila sigue pending");
    });
  }

  it("throw de red: reason=network y la fila queda pending", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const logs: string[] = [];
    client.failure = new TypeError("fetch failed");
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
      log: (line) => logs.push(line),
    });

    seedFor(db, requestOf({ requestId: "req-net" }));
    await delivery.deliver(requestOf({ requestId: "req-net" }));

    assert.ok(logs.includes("HUMAN_REQUEST_DELIVERY_FAILED reason=network agent=alice"));
    assert.equal(rowOf(db, "req-net")?.external_message_id, "pending:req-net");
  });

  it("JSON inválido: reason=json y la fila queda pending", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const logs: string[] = [];
    client.failure = new SyntaxError("Unexpected token < in JSON");
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
      log: (line) => logs.push(line),
    });

    seedFor(db, requestOf({ requestId: "req-json" }));
    await delivery.deliver(requestOf({ requestId: "req-json" }));

    assert.ok(logs.includes("HUMAN_REQUEST_DELIVERY_FAILED reason=json agent=alice"));
    assert.equal(rowOf(db, "req-json")?.external_message_id, "pending:req-json");
  });

  it("exito Telegram + fallo SQLite: reason=sqlite, fila queda pending (at-least-once)", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const logs: string[] = [];
    // markDelivered falla (disco lleno) aunque sendMessage haya ido bien.
    const failing = {
      recordDelivery: (row: Parameters<HumanRequestDeliveriesRepository["recordDelivery"]>[0]) =>
        new HumanRequestDeliveriesRepository(db).recordDelivery(row),
      lookupDelivery: (...args: Parameters<HumanRequestDeliveriesRepository["lookupDelivery"]>) =>
        new HumanRequestDeliveriesRepository(db).lookupDelivery(...args),
      markDelivered: () => {
        throw new Error("SQLITE_FULL");
      },
      listPendingDeliveries: (...args: Parameters<HumanRequestDeliveriesRepository["listPendingDeliveries"]>) =>
        new HumanRequestDeliveriesRepository(db).listPendingDeliveries(...args),
    };
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: failing,
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
      log: (line) => logs.push(line),
    });

    seedFor(db, requestOf({ requestId: "req-sqlite" }));
    await delivery.deliver(requestOf({ requestId: "req-sqlite" }));

    assert.equal(client.calls.length, 1, "Telegram envió la tarjeta");
    assert.ok(logs.includes("HUMAN_REQUEST_DELIVERY_FAILED reason=sqlite agent=alice"));
    assert.equal(
      rowOf(db, "req-sqlite")?.external_message_id,
      "pending:req-sqlite",
      "sin sustitución la fila queda pending para un retry",
    );
  });

  it("duplicado de fila ya delivered: no reenvía (UNIQUE human_request_id+channel)", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const logs: string[] = [];
    const deliveries = new HumanRequestDeliveriesRepository(db);
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
      log: (line) => logs.push(line),
    });
    const req = requestOf({ requestId: "req-dup" });
    seedFor(db, req);

    await delivery.deliver(req); // primera entrega: éxito
    assert.equal(client.calls.length, 1);
    assert.equal(rowOf(db, "req-dup")?.external_message_id, "1000");

    await delivery.deliver(req); // segunda: el INSERT choca con UNIQUE → no reenvía

    assert.equal(client.calls.length, 1, "la fila ya entregada no reenvía la tarjeta");
    assert.ok(logs.some((line) => line.includes("reason=sqlite")));
    assert.equal(rowOf(db, "req-dup")?.external_message_id, "1000");
  });

  it("fila pending: retry sí la reintenta y sustituye; la ya delivered no", async () => {
    const db = openMemoryDb();
    seedRunning(db, { id: "ini-p", requestId: "req-p", question: "¿Q?", summary: "S" });
    seedDelivery(db, { humanRequestId: "req-p", initiativeId: "ini-p" });
    const client = new FakeTelegramClient();
    const deliveries = new HumanRequestDeliveriesRepository(db);
    const delivery = new HumanRequestDelivery({
      client,
      deliveries,
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });

    // pending → el retry envía y sustituye.
    await delivery.retryPendingDeliveries("alice");
    assert.equal(client.calls.length, 1);
    assert.equal(rowOf(db, "req-p")?.external_message_id, "1000");

    // ya delivered → segundo retry no reenvía nada.
    await delivery.retryPendingDeliveries("alice");
    assert.equal(client.calls.length, 1, "fila ya delivered: no reenvía");
  });

  it("retry reconstruye question, summary y deadline desde initiatives", async () => {
    const db = openMemoryDb();
    const expiresAt = 1_760_000_000_000;
    seedRunning(db, {
      id: "ini-re",
      requestId: "req-re",
      question: "¿Cuál es la prioridad?",
      summary: "el cliente espera",
      expiresAt,
    });
    seedDelivery(db, { humanRequestId: "req-re", initiativeId: "ini-re" });
    const client = new FakeTelegramClient();
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });

    await delivery.retryPendingDeliveries("alice");

    assert.equal(client.calls.length, 1);
    const text = client.textsSent[0] ?? "";
    assert.ok(text.includes("¿Cuál es la prioridad?"), "reconstruye la question");
    assert.ok(text.includes("el cliente espera"), "reconstruye el summary");
    assert.ok(text.includes(new Date(expiresAt).toISOString()), "reconstruye el deadline");
    assert.equal(rowOf(db, "req-re")?.external_message_id, "1000");
  });

  it("pending de un request viejo no se reconstruye con el contenido de la pregunta nueva", async () => {
    const db = openMemoryDb();
    seedRunning(db, {
      id: "ini-v",
      requestId: "req-nueva", // la Initiative ya fue preguntada de nuevo
      question: "Pregunta NUEVA",
      summary: "resumen nuevo",
    });
    seedDelivery(db, { humanRequestId: "req-vieja", initiativeId: "ini-v", messageId: "pending:req-vieja" });
    const client = new FakeTelegramClient();
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });

    await delivery.retryPendingDeliveries("alice");

    assert.equal(client.calls.length, 0, "el pending de un request viejo no se reintenta con contenido ajeno");
    assert.equal(rowOf(db, "req-vieja")?.external_message_id, "pending:req-vieja");
  });

  it("normalización: chat id y message id se guardan como TEXT y lookup exige coords exactas", async () => {
    const db = openMemoryDb();
    seedRunning(db, { id: "ini-1", requestId: "req-n" });
    const deliveries = new HumanRequestDeliveriesRepository(db);
    deliveries.recordDelivery({
      humanRequestId: "req-n",
      agentName: "alice",
      initiativeId: "ini-1",
      channel: "telegram",
      externalChatId: "424242",
      externalMessageId: "1000",
      createdAt: 1,
    });

    const types = db
      .prepare(
        `SELECT typeof(external_chat_id) AS chat, typeof(external_message_id) AS msg
           FROM human_request_deliveries WHERE human_request_id = 'req-n'`,
      )
      .get() as { chat: string; msg: string };
    assert.equal(types.chat, "text");
    assert.equal(types.msg, "text");

    const found = deliveries.lookupDelivery("alice", "telegram", "424242", "1000");
    assert.ok(found);
    assert.equal(found?.humanRequestId, "req-n");
    assert.equal(found?.externalChatId, "424242");
    assert.equal(found?.externalMessageId, "1000");
    // "424243" no es la misma coordenada TEXT → null, sin coerción numérica.
    assert.equal(deliveries.lookupDelivery("alice", "telegram", "424243", "1000"), null);
    assert.equal(deliveries.lookupDelivery("alice", "telegram", "424242", "999"), null);
  });

  it("lookupDelivery scope A/B: null fuera del Agent autorizado", async () => {
    const db = openMemoryDb();
    seedRunning(db, { id: "ini-a", agentName: "alice", requestId: "req-a" });
    seedRunning(db, { id: "ini-b", agentName: "bob", requestId: "req-b" });
    const deliveries = new HumanRequestDeliveriesRepository(db);
    deliveries.recordDelivery({
      humanRequestId: "req-a",
      agentName: "alice",
      initiativeId: "ini-a",
      channel: "telegram",
      externalChatId: "111",
      externalMessageId: "m1",
      createdAt: 1,
    });
    deliveries.recordDelivery({
      humanRequestId: "req-b",
      agentName: "bob",
      initiativeId: "ini-b",
      channel: "telegram",
      externalChatId: "222",
      externalMessageId: "m2",
      createdAt: 2,
    });

    assert.equal(deliveries.lookupDelivery("alice", "telegram", "111", "m1")?.humanRequestId, "req-a");
    assert.equal(deliveries.lookupDelivery("bob", "telegram", "222", "m2")?.humanRequestId, "req-b");
    // Mismas coordenadas pero agent distinto → null (scope A/B, no filtro JS).
    assert.equal(deliveries.lookupDelivery("bob", "telegram", "111", "m1"), null);
    assert.equal(deliveries.lookupDelivery("alice", "telegram", "222", "m2"), null);
    // Fuera de cualquier Agent → null.
    assert.equal(deliveries.lookupDelivery("carol", "telegram", "111", "m1"), null);
  });

  it("la tarjeta visible no filtra request ID, IDs de Initiative ni secretos", async () => {
    const db = openMemoryDb();
    const client = new FakeTelegramClient();
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });
    const req = requestOf({ requestId: "req-leak-test", initiativeId: "ini-leak-test" });
    seedFor(db, req);

    await delivery.deliver(req);

    const text = client.textsSent[0] ?? "";
    assert.ok(text.includes(req.question));
    assert.ok(text.includes(req.summary));
    assert.ok(text.includes(new Date(req.expiresAt).toISOString()));
    for (const leaked of [req.requestId, req.initiativeId, req.turnId, req.toolCallId, "pending:", tokenOf("alice")]) {
      assert.ok(!text.includes(leaked), `la tarjeta no debe contener ${JSON.stringify(leaked)}`);
    }
    assert.equal(deliveryCardText(req.question, req.summary, req.expiresAt), text, "texto de tarjeta determinista");
  });

  it("Telegram failure keeps waiting_human and releases the Loop slot", async () => {
    const db = openMemoryDb();
    seedRunning(db, { id: "ini-wait", turnId: "turn-wait" });
    const repo = new HumanRequestRepository(db);
    const paused = repo.pauseRunningForHuman({
      agentName: "alice",
      initiativeId: "ini-wait",
      turnId: "turn-wait",
      requestId: "req-wait",
      toolCallId: "tool-1",
      question: "¿Sigo?",
      summary: "resumen",
      now: 2000,
      expiryMs: 60_000,
    });

    const client = new FakeTelegramClient();
    client.failure = { status: 500 };
    const delivery = new HumanRequestDelivery({
      client,
      deliveries: new HumanRequestDeliveriesRepository(db),
      primaryChatId: 424242,
      agentConfigFor: resolverFor({ alice: configOf("alice") }),
    });

    // La entrega falla (500) pero deliver NUNCA rechaza: la pausa durable
    // sigue en waiting_human y el slot del Loop queda libre (await resuelve).
    await delivery.deliver(paused);

    const initiative = db
      .prepare("SELECT state FROM initiatives WHERE id = 'ini-wait'")
      .get() as { state: string };
    assert.equal(initiative.state, "waiting_human", "el fallo de Telegram no revierte la espera");
    const turn = db
      .prepare("SELECT final_state FROM turns WHERE agent_name = 'alice' AND turn_id = 'turn-wait'")
      .get() as { final_state: string | null };
    assert.equal(turn.final_state, "paused_for_human");
    assert.equal(client.calls.length, 1);
    assert.equal(
      rowOf(db, "req-wait")?.external_message_id,
      "pending:req-wait",
      "sin send confirmado la fila queda pending",
    );
  });
});
