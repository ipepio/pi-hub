// A17 — Journey de restart: Ask persiste → restart → respond → misma sesión.
//
// El journey entero atraviesa el Manager y el Runner con sus componentes
// reales (no fakes de dominio), separados solo por los seams que producción ya
// inyecta:
//
//   Manager: AgendaRepository (:memory: real), TurnExecution (puente WS real),
//            AgendaLoop (dispatch real), AutonomyControl, la ruta interna
//            /telegram-reply (A14/A15) y HumanRequestDelivery (A10) con un
//            cliente Bot API fake.
//   Runner:  SessionFactory real (A16, `resumeLatest|fresh`) con el
//            runtimeProviders stubeado, ChatHub/SessionHubRegistry reales y
//            un WebSocketServer que replica el enrutado por `sessionKey` de
//            server.ts. La sesión fake envuelve un SessionManager SDK real:
//            sessionId, transcript file y reapertura son reales.
//
// Restart simulado: se descartan registry/factory/lifecycle del Manager y del
// Runner (lifetime 1) y se reconstruyen sobre el MISMO sqlite y el MISMO
// dataDir (lifetime 2). El estado durable (Initiative waiting_human, delivery
// row, transcript en disco) es lo único que cruza el reinicio.
//
// Cubre los 8 puntos de la spec:
// (1) primera Initiative crea transcript y Ask queda persistida;
// (2) registry/factory descartados como restart simulado;
// (3) respond vuelve la Initiative a `queued` con la answer como pending;
// (4) un nuevo Hub reabre el mismo session ID/history y recibe la `answer`
//     (no el `intent`);
// (5) `new_session` explícita da un ID nuevo, nunca la sesión reanudada;
// (6) la delivery row previa sigue correlacionando la reply de Telegram;
// (7) el panel responde aunque Telegram no se configuró o falló;
// (8) una segunda Ask tras restart genera request nuevo e INVALIDA la tarjeta
//     vieja (CAS de request, A03).
//
// Mutación exigida: borrar deliveries al arrancar (p.ej. `DELETE FROM
// human_request_deliveries` en el constructor del repositorio) → "Telegram
// correlation survives Manager and Runner restart" se pone ROJO porque el
// restart reconstruye el repositorio y la reply ya no encuentra su fila.
//
// NO toca agenda-recovery.test.ts ni agenda-claim.test.ts.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ClientWsMessage, PihubEnv, ServerWsMessage } from "@pihub/shared";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../dist/agenda/index.js";
import { TurnExecution } from "../dist/agenda/turn-execution.js";
import { AgendaLoop } from "../dist/agenda/loop.js";
import { AutonomyControl } from "../dist/agenda/autonomy-control.js";
import {
  HumanRequestDelivery,
  type TelegramBotClient,
  type TelegramSendMessageParams,
} from "../dist/primary-channel/human-request-delivery.js";
import { internalRouter } from "../dist/api-v1/internal.js";
import { SessionFactory } from "../../runner/src/session.ts";
import { SessionHubRegistry } from "../../runner/src/hub.ts";

const AGENT = "alpha";
const CALLBACK_TOKEN = "11".repeat(32);
const PRIMARY_CHAT = 424_242;
const ASK_QUESTION = "¿Procedo con el plan?";
const ASK_SUMMARY = "Necesito tu aprobación antes de continuar";

const openDbs: SqliteDb[] = [];
const openRunners: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const close of openRunners.splice(0)) await close();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Fixture de `:memory:` con el esquema aplicado (patrón `storage.test.ts:297`). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

/** Deja correr las microtareas pendientes (WS, promesas del puente). No duerme. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Handle opaco del scheduler manual (mismo contrato que `TurnExecutionOptions`). */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Reloj manual + scheduler (patrón de `agenda-loop.test.ts`): `now()` y
 * `schedule`/`cancel` comparten el mismo reloj; `advance(ms)` corre los
 * callbacks cuyo plazo ya venció (incluido el wakeup a `+0`). El test nunca
 * duerme.
 */
class ManualClock {
  private elapsed: number;
  private nextId = 0;
  private readonly pending = new Map<number, { callback: () => void; deadline: number }>();
  constructor(startAt = 0) {
    this.elapsed = startAt;
  }

  readonly now = (): number => this.elapsed;

  readonly schedule = (callback: () => void, ms: number): TimerHandle => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, deadline: this.elapsed + ms });
    return id as unknown as TimerHandle;
  };

  readonly cancel = (handle: TimerHandle): void => {
    this.pending.delete(Number(handle));
  };

  advance(ms: number): void {
    this.elapsed += ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, task]) => task.deadline <= this.elapsed)
        .sort((a, b) => a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, task] of due) {
        this.pending.delete(id);
        task.callback();
      }
    }
  }
}

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
}

/** Comportamiento de un prompt de la sesión fake: `ask` emite ask_human. */
type PromptBehavior = "ask" | "complete";

/** Cola compartida de comportamientos por prompt, en orden de despacho. */
function behaviorQueue() {
  const queue: PromptBehavior[] = [];
  return {
    push: (...behaviors: PromptBehavior[]) => queue.push(...behaviors),
    next: (): PromptBehavior => queue.shift() ?? "complete",
  };
}

/** Estado compartido por ambas vidas (restart) del journey. */
interface SharedJourney {
  readonly dataDir: string;
  readonly db: SqliteDb;
  readonly behaviors: ReturnType<typeof behaviorQueue>;
  readonly nextRequestId: () => string;
  readonly telegram: FakeTelegramClient;
  readonly createdSessions: FakeSdkSession[];
  /** Prompts que el Runner recibe del Manager, con la vida que los produjo. */
  readonly prompts: Array<{ lifetime: number; key: string; text: string }>;
  readonly agentConfig: AgentConfig;
}

/**
 * Sesión SDK fake que envuelve un SessionManager SDK REAL: el sessionId, el
 * transcript file y la reapertura son los reales de pi. El `prompt` emite la
 * secuencia de eventos que el modelo real produciría (ask_human con
 * `terminate:true`, o un run normal), y persiste el mensaje del usuario en el
 * transcript como hace el SDK.
 */
class FakeSdkSession {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  private readonly manager: SessionManager;
  private readonly shared: SharedJourney;

  constructor(manager: SessionManager, shared: SharedJourney) {
    this.manager = manager;
    this.shared = shared;
    this.sessionId = manager.getSessionId();
  }

  get isStreaming(): boolean {
    return false;
  }

  get model(): undefined {
    return undefined;
  }

  get sessionFile(): string | undefined {
    return this.manager.getSessionFile();
  }

  subscribe(fn: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: Record<string, unknown>): void {
    for (const fn of [...this.listeners]) fn(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    // El SDK persiste el mensaje del usuario en el transcript real.
    this.manager.appendMessage({ role: "user", content: text } as never);
    const behavior = this.shared.behaviors.next();
    this.emit({ type: "agent_start" });
    if (behavior === "ask") {
      this.emit({ type: "tool_execution_start", toolName: "ask_human" });
      this.emit({
        type: "tool_execution_end",
        toolName: "ask_human",
        isError: false,
        result: { details: { question: ASK_QUESTION, summary: ASK_SUMMARY } },
        toolCallId: `tool-${this.prompts.length}`,
      });
      this.manager.appendMessage({ role: "assistant", content: "The human has been notified and will respond shortly." } as never);
    } else {
      // La respuesta del SDK al completar el run: el transcript real solo se
      // materializa en disco cuando existe un mensaje assistant (el SDK difiere
      // el write hasta que llega el primer turno del modelo).
      this.manager.appendMessage({ role: "assistant", content: "Task complete." } as never);
    }
    this.emit({ type: "agent_end" });
  }

  async abort(): Promise<void> {}

  async setModel(): Promise<void> {}

  dispose(): void {}
}

interface FakeRunner {
  readonly registry: SessionHubRegistry;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Runner fake: un WebSocketServer real que replica el enrutado por
 * `sessionKey` de `server.ts` (SessionHubRegistry + ChatHub reales). Envía
 * `ready` con `ask_human_v1` al conectar (handshake P3.1) y reenvía los
 * broadcasts del Hub al Manager.
 */
async function startFakeRunner(base: SessionFactory, shared: SharedJourney, lifetime: number): Promise<FakeRunner> {
  const registry = new SessionHubRegistry(base);
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address !== "object") throw new Error("runner sin puerto");

  wss.on("connection", (ws, request) => {
    const url = new URL(request?.url ?? "/", "http://localhost");
    const key = url.searchParams.get("sessionKey") ?? "default";
    const hub = registry.forKey(key);
    const send = (message: ServerWsMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const unsubscribe = hub.subscribe(send);
    send({
      type: "ready",
      agent: AGENT,
      model: hub.modelId,
      sessionId: hub.sessionId ?? "",
      stt: false,
      tts: false,
      capabilities: ["prompt_context_v1", "ask_human_v1"],
    });
    ws.on("message", (raw) => {
      let message: ClientWsMessage;
      try {
        message = JSON.parse(String(raw)) as ClientWsMessage;
      } catch {
        return;
      }
      if (message.type === "prompt" && message.text?.trim()) {
        shared.prompts.push({ lifetime, key, text: message.text });
        void hub.prompt(message.text, message.context);
      } else if (message.type === "abort") {
        void hub.abort();
      } else if (message.type === "new_session") {
        void hub.newSession();
      }
    });
    ws.on("close", unsubscribe);
  });

  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      wss.close(() => resolve());
    });
  openRunners.push(close);
  return { registry, port: address.port, close };
}

interface Lifetime {
  readonly agenda: AgendaRepository;
  readonly loop: AgendaLoop;
  readonly turns: TurnExecution;
  readonly control: AutonomyControl;
  readonly router: ReturnType<typeof internalRouter>;
  readonly runner: FakeRunner;
  readonly clock: ManualClock;
}

/**
 * Construye una vida del journey (Manager + Runner) sobre el estado durable
 * compartido. El restart = descartar esta vida y construir otra con el mismo
 * `shared`.
 */
async function buildLifetime(
  shared: SharedJourney,
  clock: ManualClock,
  lifetime: number,
  primaryChatId?: number,
): Promise<Lifetime> {
  // Manager: repositorios reales sobre el MISMO sqlite que cruza el restart.
  const agenda = new AgendaRepository(shared.db);

  // Runner: SessionFactory real (A16) con runtimeProviders stubeado para que
  // las sesiones sean FakeSdkSession sobre SessionManager reales.
  const baseFactory = new SessionFactory(
    {
      dataDir: shared.dataDir,
      memoryEnabled: false,
      platformPromptEnabled: false,
    } as unknown as PihubEnv,
    shared.agentConfig,
    undefined,
    "initiative",
  );
  const originalForSession = baseFactory.forSession.bind(baseFactory);
  (baseFactory as unknown as { forSession(key: string): SessionFactory }).forSession = (key: string) => {
    const keyed = originalForSession(key);
    (keyed as unknown as { runtimeProviders: unknown }).runtimeProviders = {
      createSession: async (opts: { sessionManager: SessionManager }) => {
        const session = new FakeSdkSession(opts.sessionManager, shared);
        shared.createdSessions.push(session);
        return session;
      },
      registerExtensionProviders: async () => {},
      resolveModel: async () => null,
    };
    return keyed;
  };
  const runner = await startFakeRunner(baseFactory, shared, lifetime);

  const delivery = new HumanRequestDelivery({
    client: shared.telegram,
    agentConfigFor: async () => shared.agentConfig,
    deliveries: agenda.humanRequestDeliveries,
    ...(primaryChatId !== undefined ? { primaryChatId } : {}),
    now: clock.now,
    log: () => {},
  });

  const turns = new TurnExecution({
    apiToken: "service-token",
    repository: agenda.turns,
    humanRequests: agenda.humanRequests,
    now: clock.now,
    requestId: shared.nextRequestId,
    expiryMs: 60_000,
    onHumanRequest: (request) => {
      void delivery.deliver(request);
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const loop = new AgendaLoop(
    agenda,
    {
      state: () => ({ state: "running" as const, pid: 42 }),
      runnerPortOf: () => runner.port,
    },
    turns,
    { now: clock.now, schedule: clock.schedule, cancel: clock.cancel, tickIntervalMs: 1000 },
  );

  const control = new AutonomyControl({ agenda, turns, authority: "owner" });

  const router = internalRouter({
    supervisor: {
      verifyCallbackToken: (candidate: unknown) => (candidate === CALLBACK_TOKEN ? AGENT : undefined),
    },
    control,
    deliveries: agenda.humanRequestDeliveries,
    now: clock.now,
  });

  return { agenda, loop, turns, control, router, runner, clock };
}

/** Siembra una Initiative `queued` lista para el Loop (setup de fixture). */
function seedQueued(
  db: SqliteDb,
  overrides: { id?: string; sessionKey?: string; intent?: string; availableAt?: number } = {},
): void {
  const id = overrides.id ?? "ini-1";
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, AGENT, "queued", "human", null, overrides.intent ?? "Haz X", "solo",
    overrides.sessionKey ?? "sk-1", overrides.availableAt ?? 0, null, null, 0, null,
    0, null, null, null, null, 0, 0, null, null,
  );
}

function initiativeRow(db: SqliteDb, id: string): { state: string; human_request_id: string | null } {
  return db.prepare("SELECT state, human_request_id FROM initiatives WHERE id = ?").get(id) as {
    state: string;
    human_request_id: string | null;
  };
}

/** Espera (flusheando microtareas, sin dormir) a que la Initiative llegue a `state`. */
async function waitForInitiative(db: SqliteDb, id: string, state: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const row = db.prepare("SELECT state FROM initiatives WHERE id = ?").get(id) as { state: string } | undefined;
    if (row?.state === state) return;
    await flush();
  }
  throw new Error(`timeout: initiative ${id} no llegó a ${state}`);
}

/** Espera a que exista la delivery row con las coordenadas exactas. */
async function waitForDelivery(
  db: SqliteDb,
  agent: string,
  chat: string,
  message: string,
  tries = 600,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const row = db
      .prepare(
        `SELECT human_request_id FROM human_request_deliveries
          WHERE agent_name = ? AND channel = 'telegram' AND external_chat_id = ?
            AND external_message_id = ?`,
      )
      .get(agent, chat, message) as { human_request_id: string } | undefined;
    if (row) return;
    await flush();
  }
  throw new Error(`timeout: delivery (${agent}, telegram, ${chat}, ${message}) no apareció`);
}

function postReply(
  router: ReturnType<typeof internalRouter>,
  body: { chatId: number; replyToMessageId: number; text: string; idempotencyKey: string },
): Promise<Response> {
  return router.request("http://manager.test/telegram-reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pihub-runner-callback-token": CALLBACK_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

/** Crea el estado compartido del journey (dir temporal real + sqlite :memory:). */
async function newShared(...behaviors: PromptBehavior[]): Promise<SharedJourney> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-a17-"));
  tempDirs.push(dataDir);
  const queue = behaviorQueue();
  queue.push(...behaviors);
  let reqSeq = 0;
  return {
    dataDir,
    db: openMemoryDb(),
    behaviors: queue,
    nextRequestId: () => `req-${++reqSeq}`,
    telegram: new FakeTelegramClient(),
    createdSessions: [],
    prompts: [],
    agentConfig: {
      name: AGENT,
      port: 4100,
      model: "gpt-5",
      telegramToken: "bot-alpha-secret",
      enabled: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

describe("A17 — journey de restart: Ask persiste → restart → respond → misma sesión", () => {
  it("Telegram correlation survives Manager and Runner restart", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-1", sessionKey: "sk-journey", intent: "Haz X", availableAt: 0 });

    // (1) Primera vida: el Loop despacha, el Hub crea el transcript y el Ask
    // queda persistido (waiting_human + request + delivery row).
    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, 1, PRIMARY_CHAT);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1000");

    assert.equal(initiativeRow(shared.db, "ini-1").human_request_id, "req-1", "Ask persistido con request");
    const session1 = shared.createdSessions[0];
    assert.ok(session1, "la primera vida creó una sesión del Runner");
    const sessionId1 = session1.sessionId;
    const file1 = session1.sessionFile;
    assert.ok(file1, "el transcript se persistió en disco");
    const firstPrompt = shared.prompts.find((p) => p.lifetime === 1 && p.key === "sk-journey");
    assert.deepEqual(firstPrompt?.text, "Haz X", "la primera iniciativa se despacha con su intent");

    // (2) Restart simulado: se descartan registry/factory/lifecycle del
    // Manager y del Runner; solo el sqlite y el dataDir cruzan el reinicio.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, 2, PRIMARY_CHAT);

    // (6) La delivery row previa sigue correlacionando la reply de Telegram:
    // el reply del Manager nuevo reanuda la Initiative con la answer.
    const reply = await postReply(world2.router, {
      chatId: PRIMARY_CHAT,
      replyToMessageId: 1000,
      text: "Sí, continúa",
      idempotencyKey: "telegram-update-1",
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json() as { status: string }).status, "accepted");

    // (3) Respond vuelve la Initiative a `queued` con la answer como pending.
    await waitForInitiative(shared.db, "ini-1", "queued");
    assert.equal(initiativeRow(shared.db, "ini-1").state, "queued");

    // (4) Un nuevo Hub reabre el mismo session ID/history y recibe la answer,
    // no el intent.
    world2.loop.start();
    clock2.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "succeeded");

    const resumed = world2.runner.registry.forKey("sk-journey");
    assert.equal(resumed.sessionId, sessionId1, "el Hub reanudado reabre el mismo session ID");
    assert.equal(
      shared.createdSessions[1]?.sessionFile,
      file1,
      "el Hub reanudado reabre el mismo transcript file",
    );
    const life2Prompts = shared.prompts.filter((p) => p.lifetime === 2 && p.key === "sk-journey").map((p) => p.text);
    assert.deepEqual(life2Prompts, ["Sí, continúa"], "recibe la answer, no el intent");
    const transcript = await fs.readFile(file1, "utf8");
    assert.ok(transcript.includes("Haz X"), "el transcript conserva la primera pregunta");
    assert.ok(transcript.includes("Sí, continúa"), "el transcript conserva la respuesta tras el restart");

    // (6) La fila previa sigue correlacionando desde el repositorio nuevo.
    const lookedUp = world2.agenda.humanRequestDeliveries.lookupDelivery(
      AGENT,
      "telegram",
      String(PRIMARY_CHAT),
      "1000",
    );
    assert.ok(lookedUp, "la delivery row previa sigue existiendo tras el restart");
    assert.equal(lookedUp?.humanRequestId, "req-1");
  });

  it("the panel answers the same ask when Telegram is not configured", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-1", sessionKey: "sk-panel", intent: "Haz P", availableAt: 0 });

    // Sin primaryChatId: fail-closed, cero llamadas y cero filas (A10).
    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, 1);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");

    assert.equal(shared.telegram.calls.length, 0, "sin primary Telegram no se toca");
    const rows = shared.db.prepare("SELECT COUNT(*) AS n FROM human_request_deliveries").get() as { n: number };
    assert.equal(rows.n, 0, "sin primary no hay filas de delivery");

    // Restart.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, 2);

    // (7) El panel responde aunque Telegram no se configuró.
    const result = world2.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-1",
      answer: "Sí, adelante",
      idempotencyKey: "panel-1",
      now: clock2.now(),
      expectedHumanRequestId: "req-1",
    });
    assert.equal(result.replayed, false);
    assert.equal(result.initiative.state, "queued");

    // La respuesta fluye al mismo hilo pese a no existir Telegram.
    world2.loop.start();
    clock2.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "succeeded");
    const prompts = shared.prompts.filter((p) => p.lifetime === 2 && p.key === "sk-panel").map((p) => p.text);
    assert.deepEqual(prompts, ["Sí, adelante"]);
  });

  it("the panel answers the same ask when the Telegram delivery failed", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-1", sessionKey: "sk-tgfail", intent: "Haz T", availableAt: 0 });
    shared.telegram.failure = { status: 500 };

    // La entrega falla (500) pero la pausa durable queda y la fila queda
    // pending (A10: deliver nunca revierte la espera).
    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, 1, PRIMARY_CHAT);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "pending:req-1");
    assert.equal(shared.telegram.calls.length, 1, "Telegram sí fue llamado y falló");

    // Restart: el panel responde aunque la tarjeta nunca llegó.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, 2, PRIMARY_CHAT);
    const result = world2.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-1",
      answer: "Sí, aun así",
      idempotencyKey: "panel-2",
      now: clock2.now(),
      expectedHumanRequestId: "req-1",
    });
    assert.equal(result.initiative.state, "queued");

    world2.loop.start();
    clock2.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "succeeded");
    const pending = shared.db
      .prepare(
        `SELECT external_message_id FROM human_request_deliveries
          WHERE human_request_id = 'req-1'`,
      )
      .get() as { external_message_id: string } | undefined;
    assert.equal(pending?.external_message_id, "pending:req-1", "la fila sigue pending para un retry");
  });

  it("explicit new_session after restart gives a new session id, never the resumed one", async () => {
    const shared = await newShared("ask");
    seedQueued(shared.db, { id: "ini-1", sessionKey: "sk-ns", intent: "Haz NS", availableAt: 0 });

    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, 1, PRIMARY_CHAT);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");

    const sessionId1 = shared.createdSessions[0].sessionId;
    const file1 = shared.createdSessions[0].sessionFile;
    assert.ok(sessionId1);

    // Restart.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, 2);

    // (4/5) Un Hub nuevo para la misma sessionKey reabre la misma sesión...
    const hub = world2.runner.registry.forKey("sk-ns");
    await hub.ensureSession();
    assert.equal(hub.sessionId, sessionId1, "tras restart reabre el mismo session ID");
    assert.equal(shared.createdSessions[1]?.sessionFile, file1, "tras restart reabre el mismo transcript");

    // ...pero `new_session` explícita da un ID nuevo, nunca la reanudada.
    const newSessionId = await hub.newSession();
    assert.notEqual(newSessionId, sessionId1, "new_session da un session ID nuevo");
    assert.equal(hub.sessionId, newSessionId);
  });

  it("a second Ask after restart generates a new request and invalidates the previous card", async () => {
    const shared = await newShared("ask", "ask", "complete");
    seedQueued(shared.db, { id: "ini-1", sessionKey: "sk-2ask", intent: "Haz Y", availableAt: 0 });

    // Primera Ask (life 1): tarjeta A con request req-1.
    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, 1, PRIMARY_CHAT);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1000");
    assert.equal(initiativeRow(shared.db, "ini-1").human_request_id, "req-1");

    // Restart.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, 2, PRIMARY_CHAT);

    // Respond (panel) → queued → el Loop re-despacha y el Runner vuelve a
    // preguntar: segunda Ask con request NUEVO (req-2) y tarjeta B (1001).
    world2.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-1",
      answer: "Sí, segunda ronda",
      idempotencyKey: "panel-1",
      now: clock2.now(),
      expectedHumanRequestId: "req-1",
    });
    await waitForInitiative(shared.db, "ini-1", "queued");
    world2.loop.start();
    clock2.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1001");
    assert.equal(initiativeRow(shared.db, "ini-1").human_request_id, "req-2", "segunda Ask genera request nuevo");

    // (8) La tarjeta vieja (A, message 1000) ya no contesta: already_handled y
    // la Initiative queda intacta esperando a req-2.
    const oldCard = await postReply(world2.router, {
      chatId: PRIMARY_CHAT,
      replyToMessageId: 1000,
      text: "respuesta vieja",
      idempotencyKey: "telegram-old",
    });
    assert.equal(oldCard.status, 200);
    assert.equal((await oldCard.json() as { status: string }).status, "already_handled");
    assert.equal(initiativeRow(shared.db, "ini-1").human_request_id, "req-2");
    assert.equal(initiativeRow(shared.db, "ini-1").state, "waiting_human");

    // La tarjeta nueva (B, message 1001) sí contesta y reanuda el hilo.
    const freshCard = await postReply(world2.router, {
      chatId: PRIMARY_CHAT,
      replyToMessageId: 1001,
      text: "respuesta nueva",
      idempotencyKey: "telegram-new",
    });
    assert.equal(freshCard.status, 200);
    assert.equal((await freshCard.json() as { status: string }).status, "accepted");
    await waitForInitiative(shared.db, "ini-1", "queued");

    clock2.advance(1000);
    await waitForInitiative(shared.db, "ini-1", "succeeded");
    const life2Prompts = shared.prompts.filter((p) => p.lifetime === 2 && p.key === "sk-2ask").map((p) => p.text);
    assert.deepEqual(life2Prompts, ["Sí, segunda ronda", "respuesta nueva"]);
  });
});
