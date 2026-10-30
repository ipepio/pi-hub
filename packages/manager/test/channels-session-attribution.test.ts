import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChannelAdapter, InboundMessage } from "@pihub/channels";
import {
  openManagerStore,
  openTestDb,
  type ManagerStore,
  type SqliteDb,
} from "../src/storage/sqlite.ts";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from "../src/storage/migrations.ts";
import { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
import { ChannelRuntimeRegistry } from "../src/channels/registry.ts";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import {
  composeChannels,
  type ChannelComposition,
  type ChannelCompositionDeps,
} from "../src/channels/composition.ts";
import {
  TurnExecution,
  type StartTurnCommand,
  type TurnHandle,
} from "../src/agenda/turn-execution.ts";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";

// T5b/2 (ODD `agent-session-workspace`, S3 + S5 + S7) — RUNTIME ATTRIBUTION.
//
// The Dashboard can already read a full transcript from the exchange feed, but a
// row carried no session identity, so attributing an exchange to ONE of an Agent's
// sessions was impossible without inventing the link (D `docs/agent-session-
// integration.md` §6). This file pins the P-side prerequisite:
//
//   1. the identity is the REAL dispatch key (`StartTurnCommand.sessionKey`),
//      carried by `CompletedTurn` from the turn that actually ran — never a lookup
//      of the CURRENT selection at delivery time;
//   2. an inbound Telegram message captures the selected Telegram session when the
//      message is ACCEPTED (before it waits in the queue), so switching the
//      selection while a turn is in flight cannot rewrite the past;
//   3. the mirror stores it in a nullable additive column (schema v7): legacy rows
//      are `null` (unknown, never guessed as `main`) and a retry never rewrites;
//   4. the catalogue is read through its narrow `getSelectedSession`, per Agent, and
//      a broken selection fails CLOSED (no silent `main` fallback) while a
//      composition without the catalogue keeps the historical `main` for tests.
//
// Seams: real SQLite (`openManagerStore`/`openTestDb`), the real pairing machine,
// the real `composeChannels` wiring, a real `TurnExecution` talking to a real
// WebSocket runner and the real `/api/v1` router. No fake selection owner: the
// selection always belongs to `store.sessions`.

const NOW = 1_761_100_800_000;
const SERVICE_TOKEN = "service-token";
const CHAT_ID = "12345";
const LONG_USER_TEXT = "Mensaje largo del humano por Telegram. ".repeat(40).padEnd(1_700, ".");
const LONG_REPLY = "Respuesta completa del Agent sobre el turno. ".repeat(60).padEnd(2_400, ".");

const dirs: string[] = [];
const stores: ManagerStore[] = [];
const dbs: SqliteDb[] = [];
const compositions: ChannelComposition[] = [];
const runners: RunnerHarness[] = [];
const transports: ReturnType<typeof fakeTransport>[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.worker.stop({ graceMs: 0 });
  for (const runner of runners.splice(0)) await runner.close();
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
  transports.splice(0);
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function dataDirOf(agentNames: string[] = ["alice"]): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-attribution-"));
  dirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  for (const agentName of agentNames) {
    await scaffoldAgentDirs(dataDir, agentName);
    await writeAgent(dataDir, {
      name: agentName,
      port: 4100,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  }
  return dataDir;
}

async function until(
  condition: () => boolean,
  message = "condition never became true",
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function memoryDbAt(version: number): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= version), version);
  dbs.push(db as unknown as SqliteDb);
  return db as unknown as SqliteDb;
}

function record(pairingWindowEndsAt: string | null): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "a".repeat(64),
    pairingWindowEndsAt,
    observedStatus: "active",
    lastSeenAt: 1_761_100_800_000,
    updatedAt: 1_761_100_800_000,
  };
}

/** Fake transport: the only thing faked here is the Telegram network. */
function fakeTransport() {
  const pollers: Array<(message: InboundMessage) => void> = [];
  const sends: Array<{ chatId: string; text: string }> = [];
  const adapterFactory = (): ChannelAdapter => ({
    kind: "telegram",
    async start({ onInbound }): Promise<void> {
      pollers.push(onInbound);
    },
    async send({ chatId, text }) {
      sends.push({ chatId, text });
      return { messageId: `msg-${sends.length}` };
    },
    async stop(): Promise<void> {},
  });
  return { pollers, sends, adapterFactory };
}

interface RunnerTurn {
  readonly sessionKey: string;
  readonly socket: WebSocket;
  prompted: boolean;
}

interface RunnerHarness {
  readonly port: number;
  readonly turns: RunnerTurn[];
  sessionKeys(): string[];
  waitForTurn(count: number): Promise<void>;
  complete(index: number, reply?: string): void;
  close(): Promise<void>;
}

/**
 * A real WebSocket runner on an ephemeral port (pattern of
 * `agenda-turn-execution.test.ts`). It announces `ready` with `ask_human_v1`,
 * records the `sessionKey` the Manager opened the socket with and holds every turn
 * open until the test closes it, which is what makes "in flight" observable.
 */
async function startRunner(): Promise<RunnerHarness> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const turns: RunnerTurn[] = [];
  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/ws", "ws://runner");
    const turn: RunnerTurn = {
      sessionKey: url.searchParams.get("sessionKey") ?? "",
      socket,
      prompted: false,
    };
    turns.push(turn);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type === "prompt") turn.prompted = true;
    });
    // The handshake runs AFTER the client attached its handlers (P3.1).
    setTimeout(() => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "ready",
          agent: "fake-runner",
          capabilities: ["ask_human_v1"],
        }),
      );
    }, 5);
  });

  const harness: RunnerHarness = {
    port,
    turns,
    sessionKeys: () => turns.map((turn) => turn.sessionKey),
    async waitForTurn(count: number): Promise<void> {
      await until(
        () => turns.length >= count && (turns[count - 1] as RunnerTurn).prompted,
        `the runner never received turn ${count}`,
      );
    },
    complete(index: number, reply = "respuesta del Agent"): void {
      const turn = turns[index];
      if (!turn) throw new Error(`no turn ${index} to complete`);
      turn.socket.send(JSON.stringify({ type: "text_delta", delta: reply }));
      turn.socket.send(JSON.stringify({ type: "agent_end" }));
    },
    async close(): Promise<void> {
      for (const turn of turns) {
        try {
          turn.socket.terminate();
        } catch {
          // Already closed.
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return harness;
}

interface Harness {
  readonly dataDir: string;
  readonly store: ManagerStore;
  readonly composition: ChannelComposition;
  readonly turns: TurnExecution;
  readonly runner: RunnerHarness;
  readonly pairing: PairingMachine;
  readonly transport: ReturnType<typeof fakeTransport>;
  readonly logs: string[];
  /** Drives the adapter inbound callback of `agentName` (fire-and-forget, like Telegram). */
  inbound(agentName: string, message: InboundMessage): void;
  /**
   * La MISMA entrada del handler, esperada: `handle` es fire-and-forget por contrato
   * del adapter, así que un test que necesita observar el descarte de un mensaje
   * (fail-closed) usa el camino `await` que el propio handler expone.
   */
  inboundAsync(agentName: string, message: InboundMessage): Promise<void>;
  /** Starts ONE real turn through `TurnExecution` with a channel origin. */
  startChannelTurn(overrides?: Partial<StartTurnCommand>): TurnHandle;
  startTurn(overrides?: Partial<StartTurnCommand>): TurnHandle;
}

interface HarnessOptions {
  agents?: string[];
  /** `null` = compose WITHOUT the catalogue (the historical test dependency). */
  sessions?: ChannelCompositionDeps["sessions"] | null;
}

/** The production wiring of `index.ts`, with the network faked and SQLite real. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const agents = options.agents ?? ["alice"];
  const dataDir = await dataDirOf(agents);
  const store = await openManagerStore(dataDir);
  stores.push(store);
  const pairing = new PairingMachine({ dataDir });
  const transport = fakeTransport();
  transports.push(transport);
  const registry = new ChannelRuntimeRegistry({ adapterFactory: transport.adapterFactory });
  const runner = await startRunner();
  runners.push(runner);
  const logs: string[] = [];
  const pollersByAgent = new Map<string, (message: InboundMessage) => void>();

  let delivery: ChannelComposition["onTurnCompleted"] | undefined;
  const turns = new TurnExecution({
    apiToken: SERVICE_TOKEN,
    now: () => NOW,
    onTurnCompleted: (turn) => delivery?.(turn),
  });

  const composition = composeChannels({
    dataDir,
    persistence: store.channels,
    registry,
    pairing,
    turns,
    ...(options.sessions === null ? {} : { sessions: options.sessions ?? store.sessions }),
    resolveRunner: async () => ({ port: runner.port }),
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  compositions.push(composition);
  delivery = composition.onTurnCompleted;

  for (const agentName of agents) {
    await writeChannelRecords(dataDir, agentName, [record("2099-01-01T00:00:00.000Z")]);
    // One live adapter per Agent: its `onInbound` is the real adapter callback.
    await registry.replaceAll(agentName, [
      {
        kind: "telegram",
        token: "771234:AA-token",
        pairingWindowEndsAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    const poller = transport.pollers[transport.pollers.length - 1];
    if (poller) pollersByAgent.set(agentName, poller);
    // Bind through the REAL pairing machine: the destination is the binding.
    await pairing.requestPairing(agentName, "telegram", CHAT_ID);
  }

  const startTurn = (overrides: Partial<StartTurnCommand> = {}): TurnHandle =>
    turns.startTurn({
      agentName: "alice",
      turnId: "turn-1",
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
      sessionKey: "agent:alice:main",
      message: "hola",
      runnerPort: runner.port,
      eventProfile: "basic",
      origin: { kind: "channel", channelKind: "telegram", chatId: CHAT_ID },
      ...overrides,
    } as StartTurnCommand);

  return {
    dataDir,
    store,
    composition,
    turns,
    runner,
    pairing,
    transport,
    logs,
    inbound(agentName: string, message: InboundMessage): void {
      const poller = pollersByAgent.get(agentName);
      if (!poller) throw new Error(`no adapter for agent "${agentName}"`);
      poller(message);
    },
    inboundAsync(agentName: string, message: InboundMessage): Promise<void> {
      return composition.inbound.handleAsync(agentName, "telegram", message);
    },
    startChannelTurn: startTurn,
    startTurn,
  };
}

function apiRouter(dataDir: string, deps: Record<string, unknown> = {}) {
  return createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN },
    {
      state: () => ({ state: "running", pid: 42 }),
      statusOf: async () => ({ state: "running", port: 4100, pid: 42 }),
    } as unknown as Supervisor,
    undefined as unknown as OAuthService,
    undefined,
    {
      hasLiveTurnForAgent: () => false,
      hasAnyLiveTurn: () => false,
    } as unknown as TurnExecution,
    undefined,
    deps,
  );
}

async function getFeed(dataDir: string, exchanges: ChannelExchangeLog, agent = "alice") {
  const app = apiRouter(dataDir, { exchanges });
  const response = await app.request(`http://pihub.test/agents/${agent}/channel-exchanges`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    exchanges: Array<Record<string, unknown>>;
    latestSeq: number;
  };
}

describe("T5b/2 — la identidad de sesión viaja del turno al espejo", () => {
  it("un turno de canal escribe en el espejo la sessionKey REAL del comando y el feed la publica", async () => {
    const h = await harness();
    const handle = h.startChannelTurn({
      turnId: "turn-real",
      sessionKey: "agent:alice:session:real",
    });
    await h.runner.waitForTurn(1);
    h.runner.complete(0, "la respuesta");
    assert.equal((await handle.completion).event, "turn-complete");

    await until(() => h.composition.exchanges.listAfter("alice", 0).length === 1);
    const [row] = h.composition.exchanges.listAfter("alice", 0);
    assert.deepEqual(h.runner.sessionKeys(), ["agent:alice:session:real"]);
    assert.equal(row?.sessionKey, "agent:alice:session:real");

    const feed = await getFeed(h.dataDir, h.composition.exchanges);
    assert.equal(feed.exchanges.length, 1);
    assert.equal(feed.exchanges[0]?.sessionKey, "agent:alice:session:real");
  });

  it("una fila anterior a v7 publica sessionKey null: no se adivina la main", async () => {
    const dataDir = await dataDirOf();
    const db = await openTestDb(dataDir);
    dbs.push(db);
    // A row written before v7 carried no identity at all: the column is absent.
    db.prepare(
      `INSERT INTO channel_exchanges
         (agent_name, turn_id, origin, chat_id, user_text, reply_text, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run("alice", "turn-legacy", "telegram", CHAT_ID, "hola legacy", "respuesta legacy", NOW);

    const feed = await getFeed(dataDir, new ChannelExchangeLog(db));
    assert.equal(feed.exchanges.length, 1);
    assert.equal(feed.exchanges[0]?.sessionKey, null);
    assert.equal(feed.exchanges[0]?.hasFull, false, "una fila legacy sigue siendo preview-only");
  });

  it("la migración v7 es aditiva: la fila v6 sobrevive y su identidad es NULL", async () => {
    const db = memoryDbAt(6);
    db.prepare(
      `INSERT INTO channel_exchanges
         (agent_name, turn_id, origin, chat_id, user_text, reply_text,
          user_full_text, reply_full_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("alice", "turn-v6", "telegram", CHAT_ID, "hola", "respuesta", "hola", "respuesta", NOW);

    runMigrations(db);

    assert.equal(SCHEMA_VERSION, 8);
    assert.equal(MIGRATIONS.at(-1)?.version, 8, "v8 es el último peldaño");
    assert.ok(
      MIGRATIONS.some((migration) => migration.version === 6),
      "el peldaño histórico v5→v6 sigue explícito",
    );
    const [row] = new ChannelExchangeLog(db).listAfter("alice", 0);
    assert.equal(row?.sessionKey, null, "sin backfill: la identidad anterior es desconocida");
    assert.equal(row?.userFullText, "hola", "la v7 no toca las mitades durables de la v6");
    assert.equal(row?.hasFull, true);
  });

  it("un replay del mismo turno no duplica ni reescribe la atribución", async () => {
    const dataDir = await dataDirOf();
    const db = await openTestDb(dataDir);
    dbs.push(db);
    const log = new ChannelExchangeLog(db);

    const first = log.append({
      agentName: "alice",
      turnId: "turn-1",
      origin: "telegram",
      chatId: CHAT_ID,
      userText: "hola",
      replyText: "respuesta",
      sessionKey: "agent:alice:session:a",
      now: NOW,
    });
    const replay = log.append({
      agentName: "alice",
      turnId: "turn-1",
      origin: "telegram",
      chatId: CHAT_ID,
      userText: "otra cosa",
      replyText: "otra respuesta",
      sessionKey: "agent:alice:session:b",
      now: NOW,
    });

    assert.equal(first.sessionKey, "agent:alice:session:a");
    assert.equal(replay.sessionKey, "agent:alice:session:a", "la fila original manda");
    assert.equal(log.listAfter("alice", 0).length, 1);
  });

  it("un turno de Initiative conserva su key real aunque no esté en el catálogo", async () => {
    const h = await harness();
    const initiativeKey = "agent:alice:initiative:ini-1";
    h.startTurn({
      turnId: "turn-ini",
      sessionKey: initiativeKey,
      origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
    });
    await h.runner.waitForTurn(1);
    h.runner.complete(0, "te aviso de algo");

    await until(() => h.composition.exchanges.listAfter("alice", 0).length === 1);
    const [row] = h.composition.exchanges.listAfter("alice", 0);
    assert.equal(row?.origin, "proactive");
    assert.equal(row?.sessionKey, initiativeKey, "la key del turno viaja verbatim");

    const catalogueKeys = h.store.sessions
      .list("alice", NOW)
      .sessions.map((session) => session.key);
    assert.equal(
      catalogueKeys.includes(initiativeKey),
      false,
      "mostrar la key no inventa una adopción en el catálogo",
    );
  });

  it("la transcripción completa y la sessionKey sobreviven a reabrir el store", async () => {
    const dataDir = await dataDirOf();
    const first = await openManagerStore(dataDir);
    first.channels.exchanges.append({
      agentName: "alice",
      turnId: "turn-durable",
      origin: "telegram",
      chatId: CHAT_ID,
      userText: LONG_USER_TEXT,
      replyText: LONG_REPLY,
      sessionKey: "agent:alice:session:durable",
      now: NOW,
    });
    first.close();

    const second = await openManagerStore(dataDir);
    stores.push(second);
    const [row] = second.channels.exchanges.listAfter("alice", 0);
    assert.equal(row?.sessionKey, "agent:alice:session:durable");
    assert.equal(row?.userFullText, LONG_USER_TEXT);
    assert.equal(row?.replyFullText, LONG_REPLY);
    assert.equal(row?.hasFull, true);
  });

  describe("T5b/2 — la sesión de un mensaje entrante se captura al ACEPTARLO", () => {
    /** Crea una sesión de Telegram y la selecciona en esa superficie. */
    function selectTelegramSession(h: Harness, agentName: string, name: string): string {
      const session = h.store.sessions.create({
        agentName,
        channel: "telegram",
        name,
        now: NOW,
      });
      h.store.sessions.select({
        agentName,
        channel: "telegram",
        sessionId: session.id,
        now: NOW,
      });
      return session.key;
    }

    it("un cambio de selección con el turno anterior en vuelo no reatribuye el pasado", async () => {
      const h = await harness();
      const keyA = selectTelegramSession(h, "alice", "A");

      // 1) El primer mensaje se despacha con A.
      h.inbound("alice", { externalChatId: CHAT_ID, text: "uno", messageId: "m-1" });
      await h.runner.waitForTurn(1);

      // 2) El segundo mensaje se ACEPTA (entra en la cola) mientras el turno 1 sigue
      //    vivo: su captura ocurre ahora, con A todavía seleccionada.
      h.inbound("alice", { externalChatId: CHAT_ID, text: "dos", messageId: "m-2" });
      await until(() => h.composition.inbound.queueDepth("alice", "telegram") === 1);

      // 3) El humano cambia la selección de Telegram a B ANTES de que el turno 1
      //    termine. El turno 1 ya ocurrió en A y el mensaje 2 ya capturó A.
      const keyB = selectTelegramSession(h, "alice", "B");
      assert.notEqual(keyB, keyA);

      h.runner.complete(0, "respuesta uno");
      await h.runner.waitForTurn(2);
      h.runner.complete(1, "respuesta dos");
      await until(() => h.composition.exchanges.listAfter("alice", 0).length === 2);

      // 4) Un tercer mensaje, ya con B seleccionada, usa B.
      h.inbound("alice", { externalChatId: CHAT_ID, text: "tres", messageId: "m-3" });
      await h.runner.waitForTurn(3);
      h.runner.complete(2, "respuesta tres");
      await until(() => h.composition.exchanges.listAfter("alice", 0).length === 3);
      await h.composition.inbound.idle();

      assert.deepEqual(
        h.runner.sessionKeys(),
        [keyA, keyA, keyB],
        "el Runner abre el contexto de la sesión capturada, no de la selección actual",
      );
      assert.deepEqual(
        h.composition.exchanges.listAfter("alice", 0).map((row) => row.sessionKey),
        [keyA, keyA, keyB],
        "el espejo atribuye cada intercambio a la sesión en la que corrió",
      );
    });

    it("la selección de un Agent no influye en la de otro", async () => {
      const h = await harness({ agents: ["alice", "bob"] });
      const aliceKey = selectTelegramSession(h, "alice", "de alice");
      const bobKey = selectTelegramSession(h, "bob", "de bob");
      assert.notEqual(aliceKey, bobKey);

      h.inbound("alice", { externalChatId: CHAT_ID, text: "hola alice", messageId: "a-1" });
      h.inbound("bob", { externalChatId: CHAT_ID, text: "hola bob", messageId: "b-1" });
      await h.runner.waitForTurn(2);
      h.runner.complete(0, "respuesta alice");
      h.runner.complete(1, "respuesta bob");
      await until(
        () =>
          h.composition.exchanges.listAfter("alice", 0).length === 1 &&
          h.composition.exchanges.listAfter("bob", 0).length === 1,
      );

      assert.deepEqual(h.runner.sessionKeys().sort(), [aliceKey, bobKey].sort());
      assert.equal(h.composition.exchanges.listAfter("alice", 0)[0]?.sessionKey, aliceKey);
      assert.equal(h.composition.exchanges.listAfter("bob", 0)[0]?.sessionKey, bobKey);
    });

    it("sin selección explícita el mensaje corre en la main adoptada (legacy)", async () => {
      const h = await harness();
      h.inbound("alice", { externalChatId: CHAT_ID, text: "primera vez", messageId: "m-1" });
      await h.runner.waitForTurn(1);
      h.runner.complete(0, "respuesta");
      await until(() => h.composition.exchanges.listAfter("alice", 0).length === 1);

      const mainKey = "agent:alice:main";
      assert.deepEqual(h.runner.sessionKeys(), [mainKey]);
      assert.equal(h.composition.exchanges.listAfter("alice", 0)[0]?.sessionKey, mainKey);
      const snapshot = h.store.sessions.list("alice", NOW);
      assert.equal(snapshot.selection.telegram, "main");
      assert.equal(snapshot.sessions.find((session) => session.id === "main")?.legacy, true);
    });

    it("una selección rota falla CERRADO: no se despacha con la main", async () => {
      const h = await harness({
        sessions: {
          getSelectedSession(): never {
            throw new Error("catálogo corrupto");
          },
        },
      });
      await h.inboundAsync("alice", { externalChatId: CHAT_ID, text: "hola", messageId: "m-1" });
      await h.composition.inbound.idle();

      assert.deepEqual(h.runner.sessionKeys(), [], "ningún turno abrió contexto");      assert.deepEqual(h.composition.exchanges.listAfter("alice", 0), []);
      assert.ok(h.logs.length > 0, "el descarte es observable, nunca silencioso");
    });

    it("una composición sin catálogo conserva la main de siempre (dependencia de test)", async () => {
      const h = await harness({ sessions: null });
      h.inbound("alice", { externalChatId: CHAT_ID, text: "hola", messageId: "m-1" });
      await h.runner.waitForTurn(1);

      assert.deepEqual(h.runner.sessionKeys(), ["agent:alice:main"]);
    });
  });
});
