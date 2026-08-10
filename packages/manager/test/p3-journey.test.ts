// A18 — Journey contractual in-process Manager↔Runner (P3.7).
//
// Segunda capa de A18 (la primera es contract-red.test.ts, black-box HTTP):
// un journey Manager↔Runner con WS fake contractual + Journey Runner SDK con
// tool fake/model harness, SIN Telegram real. Manager/Agenda/Runner ejercitan
// sus Interfaces reales; solo los seams que producción ya inyecta se
// sustituyen:
//
//   Manager: AgendaRepository (:memory: real), TurnExecution (puente WS real
//            contra un WebSocketServer fake que replica el enrutado por
//            `sessionKey` de server.ts), AgendaLoop (dispatch real),
//            AutonomyControl (el mismo que monta la ruta panel respond),
//            la ruta interna /telegram-reply (A14/A15) y HumanRequestDelivery
//            (A10) con un cliente Bot API fake.
//   Runner:  SessionFactory real (A16, `resumeLatest|fresh`) con el
//            runtimeProviders stubeado, ChatHub/SessionHubRegistry reales y
//            una sesión fake (model harness) que emite ask_human con
//            `terminate:true` o un run normal, según una cola de
//            comportamientos compartida.
//
// Cubre los 9 criterios end-to-end de /tmp/plan-p3.md §2.P3.7:
//   (1) solo una Initiative real recibe ask_human (el Manager rechaza el
//       origen human con turn_failed y nunca crea la pausa);
//   (2) Ask confirma turno paused_for_human + Initiative waiting_human en una
//       transacción y libera el dial;
//   (3) otra Initiative se despacha mientras la primera espera;
//   (4) el panel ve pregunta, deadline y delivery status sin internals;
//   (5) Telegram fallido deja el panel operativo; Telegram entregado
//       correlaciona la reply;
//   (6) la primera respuesta gana; respond solo reencola — el HTTP nunca
//       despacha;
//   (7) el Loop reclama y envía la answer, no el Intent, con la misma
//       sessionKey;
//   (8) el restart entre Ask y respond conserva inbox, correlación y contexto
//       de sesión;
//   (9) al alcanzar el deadline por fila la Initiative queda expired y no
//       acepta una respuesta nueva.
//
// Mutaciones exigidas por plan-p3 §2.P3.7 (tabla P3.7):
//   - volver a mandar `intent` después de respond
//       → "P3 journey resumes with the human answer, never the original Intent"
//   - generar otra sessionKey al reencolar
//       → "P3 journey keeps one sessionKey across Ask, restart and answer"
//   - despachar directamente desde endpoint panel/Telegram
//       → "respond only queues; the Loop is the sole dispatcher"
//   - revertir Telegram failure a failed/cancelled
//       → "Primary Channel failure leaves the canonical inbox waiting_human"
//
// NO toca admission/draining (P4) ni hace smoke real de Telegram.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ClientWsMessage, PihubEnv, ServerWsMessage } from "@pihub/shared";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../dist/agenda/index.js";
import { TurnExecution } from "../dist/agenda/turn-execution.js";
import { AgendaLoop } from "../dist/agenda/loop.js";
import { AutonomyControl } from "../dist/agenda/autonomy-control.js";
import { DomainError } from "../dist/agenda/errors.js";
import {
  HumanRequestDelivery,
  type TelegramBotClient,
  type TelegramSendMessageParams,
} from "../dist/primary-channel/human-request-delivery.js";
import { internalRouter } from "../dist/api-v1/internal.js";
import { presentSnapshot } from "../dist/api-v1/autonomy.js";
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
 * Reloj manual + scheduler: `now()` y `schedule`/`cancel` comparten el mismo
 * reloj; `advance(ms)` corre los callbacks cuyo plazo ya venció. El test nunca
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

/** Estado compartido por el journey (y entre vidas en el restart). */
interface SharedJourney {
  readonly dataDir: string;
  readonly db: SqliteDb;
  readonly behaviors: ReturnType<typeof behaviorQueue>;
  readonly nextRequestId: () => string;
  readonly telegram: FakeTelegramClient;
  readonly createdSessions: FakeSdkSession[];
  /** Prompts que el Runner recibe del Manager: contexto + texto. */
  readonly prompts: Array<{ key: string; text: string; context: { kind: "human" | "initiative" } | undefined }>;
  readonly agentConfig: AgentConfig;
}

/**
 * Sesión SDK fake que envuelve un SessionManager SDK REAL: el sessionId, el
 * transcript file y la reapertura son los reales de pi. El `prompt` emite la
 * secuencia de eventos que el modelo real produciría (ask_human con
 * `terminate:true`, o un run normal) y persiste el mensaje del usuario en el
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
      this.manager.appendMessage({
        role: "assistant",
        content: "The human has been notified and will respond shortly.",
      } as never);
    } else {
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
async function startFakeRunner(base: SessionFactory, shared: SharedJourney): Promise<FakeRunner> {
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
        shared.prompts.push({ key, text: message.text, context: message.context });
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
  readonly baseFactory: SessionFactory;
}

/**
 * Construye una vida del journey (Manager + Runner) sobre el estado durable
 * compartido. El restart = descartar esta vida y construir otra con el mismo
 * `shared` (solo sqlite + dataDir cruzan el reinicio).
 */
async function buildLifetime(
  shared: SharedJourney,
  clock: ManualClock,
  primaryChatId?: number,
): Promise<Lifetime> {
  const agenda = new AgendaRepository(shared.db);

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
  const runner = await startFakeRunner(baseFactory, shared);

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

  return { agenda, loop, turns, control, router, runner, clock, baseFactory };
}

/**
 * Siembra un Trigger schedule v1 vencido (`next_fire_at = now - 1`) para que
 * el primer tick del Loop lo dispare por el camino real (`fireTrigger` →
 * Initiative queued, origin trigger, trigger_id fijado).
 */
function seedTrigger(
  db: SqliteDb,
  overrides: { id?: string; intent?: string; mode?: "solo" | "ask" } = {},
): string {
  const id = overrides.id ?? "trig-1";
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at,
        last_fired_at, created_at, updated_at, create_idempotency_key,
        create_command_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, AGENT, "schedule", JSON.stringify({ version: 1, kind: "interval", intervalMs: 60_000 }),
    overrides.intent ?? "Haz X", overrides.mode ?? "ask", null, "owner", "owner", null, 1,
    -1, null, 0, 0, null, null,
  );
  return id;
}

/** Siembra una Initiative `queued` lista para el Loop (setup de fixture). */
function seedQueued(
  db: SqliteDb,
  overrides: { id?: string; sessionKey?: string; intent?: string; availableAt?: number; mode?: "solo" | "ask" } = {},
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
    id, AGENT, "queued", "human", null,
    overrides.intent ?? "Haz X", overrides.mode ?? "solo",
    overrides.sessionKey ?? "sk-1", overrides.availableAt ?? 0, null, null, 0, null,
    0, null, null, null, null, 0, 0, null, null,
  );
}

function initiativeRow(db: SqliteDb, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM initiatives WHERE id = ?").get(id) as Record<string, unknown>;
}

/** Espera a que una Initiative del Trigger aparezca y devuelve su id. */
async function initiativeFromTrigger(db: SqliteDb, triggerId: string): Promise<string> {
  for (let i = 0; i < 600; i += 1) {
    const row = db
      .prepare(
        "SELECT id FROM initiatives WHERE agent_name = ? AND trigger_id = ? AND origin = 'trigger'",
      )
      .get(AGENT, triggerId) as { id: string } | undefined;
    if (row) return row.id;
    await flush();
  }
  throw new Error(`timeout: el Trigger ${triggerId} no produjo una Initiative`);
}

/** Espera (flusheando microtareas, sin dormir) a que el turno humano termine. */
async function waitForCompletion(handle: { completion: Promise<unknown> }, tries = 1200): Promise<unknown> {
  let resolved: { done: boolean; value?: unknown } = { done: false };
  handle.completion
    .then((value) => {
      resolved = { done: true, value };
    })
    .catch(() => {
      resolved = { done: true };
    });
  for (let i = 0; i < tries; i += 1) {
    if (resolved.done) return resolved.value;
    await flush();
  }
  throw new Error("timeout: el turno no terminó");
}

function turnRows(db: SqliteDb, turnId: string): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM turns WHERE turn_id = ?").all(turnId) as Record<string, unknown>[];
}

/** Espera (flusheando microtareas, sin dormir) a que la Initiative llegue a `state`. */
async function waitForInitiative(db: SqliteDb, id: string, state: string, tries = 1200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const row = db.prepare("SELECT state FROM initiatives WHERE id = ?").get(id) as { state: string } | undefined;
    if (row?.state === state) return;
    await flush();
  }
  throw new Error(`timeout: initiative ${id} no llegó a ${state}`);
}

/** Espera a que el Runner haya recibido `n` prompts del Manager. */
async function waitForPromptCount(shared: SharedJourney, key: string, count: number, tries = 1200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (shared.prompts.filter((p) => p.key === key).length >= count) return;
    await flush();
  }
  throw new Error(`timeout: no llegaron ${count} prompts para ${key}`);
}

/** Espera a que exista la delivery row con las coordenadas exactas. */
async function waitForDelivery(
  db: SqliteDb,
  agent: string,
  chat: string,
  message: string,
  tries = 1200,
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-a18-journey-"));
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

/** Campos internos que ninguna respuesta pública puede contener (P3.7 §4). */
const INTERNAL_FIELDS = [
  "sessionKey",
  "turnId",
  "humanRequestId",
  "askCorrelation",
  "pendingHumanInput",
  "humanResponseIdempotencyKey",
  "humanResponseCommandHash",
  "boundModel",
  "result",
  "chatId",
  "messageId",
  "externalChatId",
  "externalMessageId",
];

describe("A18 — Journey contractual Manager↔Runner (P3.7)", () => {
  it("P3 journey from trigger to terminal: running → Ask → inbox → panel respond → same session", async () => {
    const shared = await newShared("ask", "complete");
    seedTrigger(shared.db, { id: "trig-j1", intent: "Haz X", mode: "ask" });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock, PRIMARY_CHAT);

    // (a) El Loop dispara el Trigger real (fireTrigger → Initiative queued con
    //     sessionKey aislada propia) y el Model Harness emite ask_human.
    world.loop.start();
    clock.advance(1000);
    const iniId = await initiativeFromTrigger(shared.db, "trig-j1");
    await waitForInitiative(shared.db, iniId, "waiting_human");
    const sessionKey = initiativeRow(shared.db, iniId).session_key as string;
    assert.ok(sessionKey, "la Initiative disparada tiene sessionKey propia");
    // El claim (T7+T2) fijó turn_id y lo marcó running antes de la pausa.
    const claimedTurn = turnRows(shared.db, initiativeRow(shared.db, iniId).turn_id as string);
    assert.equal(claimedTurn[0]?.claimed_at, 1000, "el turno se reclamó a los 1000ms");

    // (b) Criterio 2: la pausa confirmó turno paused_for_human + Initiative
    //     waiting_human en la MISMA transacción (dos filas durables).
    const ini = initiativeRow(shared.db, iniId);
    assert.equal(ini.state, "waiting_human");
    assert.equal(ini.human_request_id, "req-1");
    assert.equal(ini.human_question, ASK_QUESTION);
    assert.equal(ini.human_expires_at, clock.now() + 60_000, "deadline capturado por fila = now + expiryMs");
    const turnId = ini.turn_id as string;
    assert.ok(turnId);
    const turn = turnRows(shared.db, turnId);
    assert.ok(turn.length > 0, "el turno quedó reservado");
    assert.equal(turn[0].final_state, "paused_for_human", "la pausa durable marcó el turno");

    // (c) La delivery row quedó entregada (cliente fake) con las coordenadas.
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1000");

    // (d) Criterio 4: el panel ve pregunta, deadline y delivery status sin
    //     internals (misma proyección que monta la ruta panel).
    const snapshot = presentSnapshot(world.agenda.projection.snapshotForAgent(AGENT, clock.now()));
    const waiting = snapshot.inbox.find((ini) => ini.id === iniId);
    assert.ok(waiting, "la Initiative esperando debe estar en el inbox");
    assert.equal(waiting.question, ASK_QUESTION);
    assert.equal(waiting.expiresAt, clock.now() + 60_000);
    assert.equal(waiting.notificationStatus, "delivered");
    const raw = JSON.stringify(snapshot);
    for (const field of INTERNAL_FIELDS) {
      assert.ok(!raw.includes(field), `el snapshot público no debe contener "${field}"`);
    }

    // (e) Criterio 6: responder por panel reencola (queued), no despacha.
    const respond = world.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: iniId,
      answer: "Sí, continúa",
      idempotencyKey: "panel-1",
      now: clock.now(),
      expectedHumanRequestId: "req-1",
    });
    assert.equal(respond.replayed, false);
    assert.equal(respond.initiative.state, "queued");
    assert.equal(initiativeRow(shared.db, iniId).state, "queued", "tras respond la fila está queued, no running");
    assert.equal(
      shared.prompts.filter((p) => p.key === sessionKey).length,
      1,
      "el HTTP no despachó un segundo prompt",
    );

    // (f) Criterio 7: el Loop reclama y envía la answer (no el Intent) con la
    //     misma sessionKey → terminal.
    clock.advance(1000);
    await waitForPromptCount(shared, sessionKey, 2);
    await waitForInitiative(shared.db, iniId, "succeeded");
    const prompts = shared.prompts.filter((p) => p.key === sessionKey).map((p) => p.text);
    assert.deepEqual(prompts, ["Haz X", "Sí, continúa"], "intent primero, answer después, nunca intent otra vez");
    assert.equal(shared.prompts.filter((p) => p.key === sessionKey)[1]?.context?.kind, "initiative");
  });

  it("P3 journey resumes with the human answer, never the original Intent", async () => {
    const shared = await newShared("ask", "complete");
    seedTrigger(shared.db, { id: "trig-j2", intent: "Haz Y", mode: "ask" });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock);

    world.loop.start();
    clock.advance(1000);
    const iniId = await initiativeFromTrigger(shared.db, "trig-j2");
    await waitForInitiative(shared.db, iniId, "waiting_human");
    const sessionKey = initiativeRow(shared.db, iniId).session_key as string;

    world.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: iniId,
      answer: "Adelante",
      idempotencyKey: "panel-j2",
      now: clock.now(),
      expectedHumanRequestId: "req-1",
    });
    await waitForInitiative(shared.db, iniId, "queued");

    clock.advance(1000);
    await waitForPromptCount(shared, sessionKey, 2);
    await waitForInitiative(shared.db, iniId, "succeeded");

    const prompts = shared.prompts.filter((p) => p.key === sessionKey).map((p) => p.text);
    // Mutación exigida: volver a mandar `intent` después de respond → este
    // test se pone ROJO (el segundo prompt sería "Haz Y" y no "Adelante").
    assert.deepEqual(prompts, ["Haz Y", "Adelante"], "el Loop reenvía la answer, nunca el Intent");
  });

  it("respond only queues; the Loop is the sole dispatcher", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-q", sessionKey: "sk-q", intent: "Haz Q" });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock);

    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-q", "waiting_human");

    const respond = world.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-q",
      answer: "Sí",
      idempotencyKey: "panel-q",
      now: clock.now(),
      expectedHumanRequestId: "req-1",
    });
    assert.equal(respond.replayed, false);
    // Mutación exigida: despachar directamente desde el endpoint panel/Telegram
    // (en vez de solo reencolar) → la fila quedaría `running` y este test se
    // pone ROJO.
    assert.equal(
      initiativeRow(shared.db, "ini-q").state,
      "queued",
      "respond solo reencola; el HTTP nunca despacha",
    );
    assert.equal(shared.prompts.filter((p) => p.key === "sk-q").length, 1, "no hubo despacho HTTP");

    // Solo el Loop puede retomar: su tick reclama, envía la answer y termina.
    clock.advance(1000);
    await waitForPromptCount(shared, "sk-q", 2);
    await waitForInitiative(shared.db, "ini-q", "succeeded");
    const prompts = shared.prompts.filter((p) => p.key === "sk-q").map((p) => p.text);
    assert.deepEqual(prompts, ["Haz Q", "Sí"]);
  });

  it("Primary Channel failure leaves the canonical inbox waiting_human", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-f", sessionKey: "sk-f", intent: "Haz F" });
    shared.telegram.failure = { status: 500 };
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock, PRIMARY_CHAT);

    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-f", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "pending:req-1");

    // La Initiative SIGUE en waiting_human (inbox canónico) pese al fallo.
    const snapshot = presentSnapshot(world.agenda.projection.snapshotForAgent(AGENT, clock.now()));
    const waiting = snapshot.inbox.find((ini) => ini.id === "ini-f");
    assert.ok(waiting, "el fallo de entrega no saca la Initiative del inbox");
    assert.equal(waiting.notificationStatus, "not_delivered");
    assert.equal(waiting.question, ASK_QUESTION);

    // El panel sigue operativo: puede responder y el Loop termina.
    world.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-f",
      answer: "Sí, aun así",
      idempotencyKey: "panel-f",
      now: clock.now(),
      expectedHumanRequestId: "req-1",
    });
    await waitForInitiative(shared.db, "ini-f", "queued");
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-f", "succeeded");
    const prompts = shared.prompts.filter((p) => p.key === "sk-f").map((p) => p.text);
    assert.deepEqual(prompts, ["Haz F", "Sí, aun así"]);
  });

  it("a delivered Telegram card correlates the reply into the same session", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-t", sessionKey: "sk-t", intent: "Haz T" });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock, PRIMARY_CHAT);

    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-t", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1000");

    // Reply correlacionada por la delivery row (A14/A15): accepted → queued.
    const reply = await postReply(world.router, {
      chatId: PRIMARY_CHAT,
      replyToMessageId: 1000,
      text: "Sí, por Telegram",
      idempotencyKey: "telegram-1",
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json() as { status: string }).status, "accepted");
    await waitForInitiative(shared.db, "ini-t", "queued");

    clock.advance(1000);
    await waitForPromptCount(shared, "sk-t", 2);
    await waitForInitiative(shared.db, "ini-t", "succeeded");
    const prompts = shared.prompts.filter((p) => p.key === "sk-t").map((p) => p.text);
    assert.deepEqual(prompts, ["Haz T", "Sí, por Telegram"]);
  });

  it("another Initiative dispatches while the first one waits", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-a", sessionKey: "sk-a", intent: "Haz A", availableAt: 0 });
    seedQueued(shared.db, { id: "ini-b", sessionKey: "sk-b", intent: "Haz B", availableAt: 0 });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock);

    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-a", "waiting_human");

    // La pausa liberó el dial: con dispatchConcurrency=1, B se despacha
    // mientras A espera (criterio 3). El wakeup del Loop (tick a +0) recoloca
    // el despacho sin esperar al siguiente tick periódico.
    clock.advance(0);
    await waitForInitiative(shared.db, "ini-b", "succeeded");
    assert.equal(initiativeRow(shared.db, "ini-a").state, "waiting_human", "A sigue esperando");
    const bPrompts = shared.prompts.filter((p) => p.key === "sk-b").map((p) => p.text);
    assert.deepEqual(bPrompts, ["Haz B"]);
  });

  it("a real Initiative is the only origin that receives ask_human", async () => {
    const shared = await newShared("ask", "ask");
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock);
    const skHuman = "sk-human";

    // (a) Un turno HUMAN cuyo modelo emite ask_human es rechazado por el
    //     Manager (fail-closed): el SSE termina en turn-error y NO nace
    //     ninguna pausa durable (ni request, ni delivery, ni waiting_human).
    const turnId = "human-turn-1";
    const handle = world.turns.startTurn({
      agentName: AGENT,
      turnId,
      idempotencyKey: "human-ik-1",
      correlationId: "human-corr-1",
      sessionKey: skHuman,
      message: "hola humano",
      runnerPort: world.runner.port,
      eventProfile: "basic",
      origin: { kind: "human" },
    });
    const terminal = (await waitForCompletion(handle)) as { event?: string };
    assert.equal(terminal.event, "turn-error", "un origen human nunca pausa; el Manager lo rechaza");
    await flush();
    const asks = shared.db.prepare("SELECT COUNT(*) AS n FROM human_request_deliveries").get() as { n: number };
    assert.equal(asks.n, 0, "un origen human nunca crea delivery/request");
    const waitingRows = shared.db
      .prepare("SELECT COUNT(*) AS n FROM initiatives WHERE state = 'waiting_human'")
      .get() as { n: number };
    assert.equal(waitingRows.n, 0, "un origen human nunca pausa una Initiative");

    // (b) Una Initiative REAL (trigger) con el mismo harness sí recibe
    //     ask_human y pausa durablemente.
    seedQueued(shared.db, { id: "ini-c1", sessionKey: "sk-c1", intent: "Haz C" });
    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-c1", "waiting_human");
    const prompt = shared.prompts.find((p) => p.key === "sk-c1");
    assert.equal(prompt?.context?.kind, "initiative", "el dispatch de Initiative lleva contexto initiative");
    assert.equal(initiativeRow(shared.db, "ini-c1").human_request_id, "req-1");
  });

  it("P3 journey keeps one sessionKey across Ask, restart and answer", async () => {
    const shared = await newShared("ask", "complete");
    seedQueued(shared.db, { id: "ini-r", sessionKey: "sk-r", intent: "Haz R", availableAt: 0 });
    const clock1 = new ManualClock(0);
    const world1 = await buildLifetime(shared, clock1, PRIMARY_CHAT);
    world1.loop.start();
    clock1.advance(1000);
    await waitForInitiative(shared.db, "ini-r", "waiting_human");
    await waitForDelivery(shared.db, AGENT, String(PRIMARY_CHAT), "1000");

    const session1 = shared.createdSessions[0];
    assert.ok(session1, "la primera vida creó una sesión del Runner");
    const sessionId1 = session1.sessionId;
    const file1 = session1.sessionFile;
    assert.ok(file1, "el transcript se persistió en disco");

    // Restart: se descartan registry/factory/lifecycle; solo sqlite y dataDir
    // cruzan el reinicio.
    await world1.runner.close();
    const clock2 = new ManualClock(10_000);
    const world2 = await buildLifetime(shared, clock2, PRIMARY_CHAT);

    // Respond por panel tras el restart.
    const result = world2.control.respondToInitiative({
      agentName: AGENT,
      initiativeId: "ini-r",
      answer: "Sí, continúa",
      idempotencyKey: "panel-r",
      now: clock2.now(),
      expectedHumanRequestId: "req-1",
    });
    assert.equal(result.initiative.state, "queued");
    await waitForInitiative(shared.db, "ini-r", "queued");

    world2.loop.start();
    clock2.advance(1000);
    await waitForPromptCount(shared, "sk-r", 2);
    await waitForInitiative(shared.db, "ini-r", "succeeded");

    // El Hub reanudado reabre el MISMO session ID/transcript y la answer llega
    // a la MISMA sessionKey (mutación exigida: otra sessionKey al reencolar →
    // este test se pone ROJO).
    const resumed = world2.runner.registry.forKey("sk-r");
    assert.equal(resumed.sessionId, sessionId1, "el Hub reanudado reabre el mismo session ID");
    assert.equal(shared.createdSessions[1]?.sessionFile, file1, "reabre el mismo transcript file");
    const life2Prompts = shared.prompts.filter((p) => p.key === "sk-r").map((p) => p.text);
    assert.deepEqual(life2Prompts, ["Haz R", "Sí, continúa"]);
    const transcript = await fs.readFile(file1, "utf8");
    assert.ok(transcript.includes("Haz R"), "el transcript conserva la primera pregunta");
    assert.ok(transcript.includes("Sí, continúa"), "el transcript conserva la respuesta tras el restart");
  });

  it("an expired waiting row rejects a new answer at its own deadline", async () => {
    const shared = await newShared("ask");
    seedQueued(shared.db, { id: "ini-e", sessionKey: "sk-e", intent: "Haz E" });
    const clock = new ManualClock(0);
    const world = await buildLifetime(shared, clock);

    world.loop.start();
    clock.advance(1000);
    await waitForInitiative(shared.db, "ini-e", "waiting_human");
    const deadline = initiativeRow(shared.db, "ini-e").human_expires_at as number;
    assert.equal(deadline, clock.now() + 60_000, "deadline por fila = now + expiryMs en el momento de la pausa");

    // (a) En el límite exacto manda el deadline por fila: el respond se
    //     rechaza aunque el barrido no haya corrido (el comando lleva su
    //     propio `now`; el reloj no avanza, así que ningún tick barrió).
    assert.throws(
      () =>
        world.control.respondToInitiative({
          agentName: AGENT,
          initiativeId: "ini-e",
          answer: "tarde",
          idempotencyKey: "panel-e",
          now: deadline,
          expectedHumanRequestId: "req-1",
        }),
      (error: unknown) => error instanceof DomainError && error.code === "INITIATIVE_STATE_CONFLICT",
      "al deadline exacto el respond debe ser conflicto de estado",
    );
    assert.equal(initiativeRow(shared.db, "ini-e").state, "waiting_human", "aún no barrido, la fila sigue waiting");

    // (b) Avanzar el reloj más allá del deadline: el próximo tick del Loop
    //     barre por fila y la marca expired; una respuesta nueva tras expired
    //     también se rechaza.
    clock.advance(deadline - clock.now());
    await waitForInitiative(shared.db, "ini-e", "expired");
    assert.throws(
      () =>
        world.control.respondToInitiative({
          agentName: AGENT,
          initiativeId: "ini-e",
          answer: "demasiado tarde",
          idempotencyKey: "panel-e2",
          now: clock.now(),
        }),
      (error: unknown) => error instanceof DomainError && error.code === "INITIATIVE_STATE_CONFLICT",
    );
  });
});
