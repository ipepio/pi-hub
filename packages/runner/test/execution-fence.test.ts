// T4c — el Runner es la defensa autoritativa contra la superposición (S2).
//
// El Manager puede perder su mapa de turnos vivos (reinicio) o caerse la conexión
// que le avisaría del terminal; por eso la regla «una sola ejecución» no puede
// vivir solo en el Manager. Aquí se prueba en el borde REAL del Runner: el
// servidor HTTP+WS de `startServer`, sus hubs (default y keyed) y su gate única.
// Solo se falsifica el SDK (`AgentSession.prompt` se asienta cuando el test
// decide, en el orden observado en el SDK instalado: `agent_end` a los listeners
// y después la promesa del prompt), nunca la gate ni el socket.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { ChatHub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";

/** Cota por test: un socket o una promesa colgada falla, no cuelga la suite. */
const TEST_TIMEOUT_MS = 20_000;
const MODEL = "proveedor/modelo";

/** Resuelve en el siguiente turno del bucle de eventos. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Espera activa corta: los eventos del socket llegan en el bucle de eventos. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timeout esperando ${label}`);
}

/**
 * AgentSession del SDK falsificada (0.80.3). `prompt()` se asienta a mano:
 * - `finish()` reproduce un run completo: emite `agent_end` a los listeners y
 *   después resuelve la promesa (`_runAgentPrompt` → `agent.finishRun`).
 * - `fail()` reproduce un rechazo de PREFLIGHT (sin modelo o sin credenciales):
 *   el SDK rechaza antes de arrancar el run, así que no hay `agent_end` alguno.
 */
class FakeSdkSession {
  isStreaming = false;
  aborts = 0;
  disposed = false;
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  readonly key: string;
  private listeners = new Set<(event: { type: string }) => void>();
  private settleRun?: () => void;
  private failRun?: (error: Error) => void;

  constructor(key: string) {
    this.key = key;
  }

  subscribe(listener: (event: { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  prompt(text: string): Promise<void> {
    this.isStreaming = true;
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => {
      this.settleRun = () => {
        this.settleRun = undefined;
        this.isStreaming = false;
        for (const listener of this.listeners) listener({ type: "agent_end" });
        resolve();
      };
      this.failRun = (error: Error) => {
        this.failRun = undefined;
        this.isStreaming = false;
        reject(error);
      };
    });
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async setModel(model: { provider: string; id: string }): Promise<void> {
    this.models.push(`${model.provider}/${model.id}`);
  }

  dispose(): void {
    this.disposed = true;
  }

  finish(): void {
    this.settleRun?.();
  }

  fail(message: string): void {
    this.failRun?.(new Error(message));
  }
}

interface RuntimeOptions {
  /** La creación de la sesión queda pendiente hasta que el test la libere. */
  deferredCreation?: boolean;
  /** Cuántas creaciones fallan antes de funcionar (fallo de admisión). */
  failingCreations?: number;
}

/**
 * Factory completa del Runner: el hub por defecto usa `create()` directamente y
 * los hubs keyed usan `forSession(key).create()`, así que la capacidad tiene que
 * estar en los dos niveles (fixture incompleto = TypeError, no comportamiento).
 */
function fakeRuntime(options: RuntimeOptions = {}) {
  const sessions: FakeSdkSession[] = [];
  const creations: Array<() => void> = [];
  let pendingFailures = options.failingCreations ?? 0;

  const provider = (sessionKey: string) => ({
    config: { model: MODEL },
    sessionType: "human" as const,
    async create(): Promise<FakeSdkSession> {
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw new Error("No hay credenciales configuradas para el proveedor");
      }
      if (options.deferredCreation) {
        await new Promise<void>((resolve) => creations.push(resolve));
      }
      const session = new FakeSdkSession(sessionKey);
      sessions.push(session);
      return session;
    },
    useFreshCreation(): void {},
    async resolveModel(): Promise<undefined> {
      return undefined;
    },
  });

  const factory = {
    config: { model: MODEL },
    sessionType: "human" as const,
    create: () => provider("default").create(),
    useFreshCreation(): void {},
    forSession(sessionKey: string) {
      return provider(sessionKey);
    },
    async resolveModel(): Promise<undefined> {
      return undefined;
    },
  };

  return { factory, sessions, creations };
}

interface RunnerMessage {
  type?: string;
  message?: string;
}

/** Cliente WS mínimo del Runner: recoge lo que llega y espera un mensaje. */
class Client {
  readonly messages: RunnerMessage[] = [];
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      try {
        this.messages.push(JSON.parse(String(raw)) as RunnerMessage);
      } catch {
        // El Runner solo habla JSON; un marco ilegible no es parte del caso.
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  errors(): RunnerMessage[] {
    return this.byType("error");
  }

  byType(type: string): RunnerMessage[] {
    return this.messages.filter((message) => message.type === type);
  }

  async waitFor(
    predicate: (message: RunnerMessage) => boolean,
    label: string,
  ): Promise<RunnerMessage> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await settle();
    }
    throw new Error(`timeout esperando ${label}`);
  }

  /** Termina el socket y espera su cierre: `server.close()` no espera por nadie. */
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.terminate();
    });
  }
}

interface Runner {
  port: number;
  runtime: ReturnType<typeof fakeRuntime>;
  connect(sessionKey?: string): Promise<Client>;
}

/**
 * Arranca un Runner real y GARANTIZA la limpieza aunque una aserción falle:
 * cierra los clientes antes del servidor y, como red de seguridad, destruye las
 * conexiones que queden para que `close()` nunca quede colgado.
 */
async function withRunner(
  run: (runner: Runner) => Promise<void>,
  options: RuntimeOptions = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pihub-runner-fence-"));
  const runtime = fakeRuntime(options);
  const clients: Client[] = [];
  /** Promesas rechazadas sin consumidor: tumbarían el proceso del Runner. */
  const escaped: unknown[] = [];
  const onEscaped = (reason: unknown) => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onEscaped);
  let server: Server | undefined;

  try {
    const env = {
      dataDir,
      apiToken: "",
      managerPort: 1,
      uploadsRetentionHours: 1,
      channelKinds: [],
      memoryEnabled: false,
    };
    const config = { name: "agent", port: 0, enabled: true, createdAt: "2026-08-01T00:00:00.000Z" };
    const hub = new ChatHub(runtime.factory as never);
    server = startServer(env as never, config as never, hub, runtime.factory as never);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const connect = async (sessionKey?: string): Promise<Client> => {
      const query = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : "";
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
      const client = new Client(socket);
      clients.push(client);
      await client.waitFor((message) => message.type === "ready", "ready del Runner");
      return client;
    };

    await run({ port, runtime, connect });

    for (let attempt = 0; attempt < 3; attempt += 1) await settle();
    assert.equal(
      escaped.length,
      0,
      `una promesa rechazada quedó sin consumidor en el borde WS: ${escaped.map(String).join("; ")}`,
    );
  } finally {
    process.off("unhandledRejection", onEscaped);
    for (const client of clients) await client.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

test(
  "un solo prompt a la vez: el rechazo va solo al socket que lo pidió y el turno activo no ve un terminal falso",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRunner(async ({ runtime, connect }) => {
      // Hub por defecto (sin sessionKey) y hub keyed: la gate es la MISMA del Runner.
      const active = await connect();
      const other = await connect("telegram");

      active.send({ type: "prompt", text: "hola" });
      await until(() => runtime.sessions.length === 1, "el primer prompt llegue al SDK");
      const running = runtime.sessions[0];

      // Un abort pedido es una intención: no libera la admisión.
      active.send({ type: "abort" });
      await until(() => running.aborts === 1, "el abort llegue al SDK");
      assert.equal(running.disposed, false, "un abort pedido no descarta la sesión");

      other.send({ type: "prompt", text: "otra cosa" });
      const rejected = await other.waitFor(
        (message) => message.type === "error",
        "el rechazo del ocupado",
      );
      assert.match(String(rejected.message), /ejecución en curso/);

      assert.deepEqual(
        runtime.sessions.map((session) => session.key),
        ["default"],
        "el prompt rechazado no crea una segunda AgentSession",
      );
      assert.equal(running.prompts.length, 1, "el prompt rechazado nunca llega al SDK");
      assert.deepEqual(active.errors(), [], "el rechazo no se difunde al hub del turno activo");
      assert.deepEqual(active.byType("agent_end"), [], "el rechazo no puede falsificar un terminal");

      // Misma sessionKey que el turno activo: también se rechaza, y en su socket.
      const sameKey = await connect();
      sameKey.send({ type: "prompt", text: "misma clave" });
      const sameRejected = await sameKey.waitFor(
        (message) => message.type === "error",
        "el rechazo en la misma clave",
      );
      assert.match(String(sameRejected.message), /ejecución en curso/);
      assert.deepEqual(active.errors(), []);
      assert.deepEqual(active.byType("agent_end"), []);

      // Solo el asentamiento real del SDK (terminal → promesa) libera la ejecución.
      running.finish();
      await until(() => active.byType("agent_end").length === 1, "el terminal del turno real");

      other.send({ type: "prompt", text: "ahora sí" });
      await until(
        () => runtime.sessions.length === 2,
        "el segundo prompt se acepta al liberarse la admisión",
      );
      assert.equal(runtime.sessions[1].key, "telegram");

      runtime.sessions[1].finish();
      await until(() => other.byType("agent_end").length === 1, "el terminal del segundo turno");
      assert.equal(
        active.byType("agent_end").length,
        1,
        "el turno ya asentado conserva un único terminal",
      );
    });
  },
);

test(
  "new_session y set_model con un turno en curso fallan solo en su socket y no descartan la generación activa",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRunner(async ({ runtime, connect }) => {
      const active = await connect();
      const other = await connect("telegram");

      active.send({ type: "prompt", text: "hola" });
      await until(() => runtime.sessions.length === 1, "el primer prompt llegue al SDK");
      const running = runtime.sessions[0];

      active.send({ type: "new_session" });
      const rejectedNew = await active.waitFor(
        (message) => message.type === "error",
        "el rechazo de la sesión nueva",
      );
      assert.match(String(rejectedNew.message), /en curso/);
      assert.equal(runtime.sessions.length, 1, "no se crea una sesión nueva durante el turno");
      assert.equal(running.disposed, false, "la generación activa no se descarta");
      assert.deepEqual(active.byType("session_new"), [], "un rechazo no anuncia una sesión nueva");

      active.send({ type: "set_model", model: "proveedor/otro" });
      const rejectedModel = await active.waitFor(
        (message) => message.type === "error" && /modelo/.test(String(message.message)),
        "el rechazo del cambio de modelo",
      );
      assert.match(String(rejectedModel.message), /en curso/);
      assert.deepEqual(
        running.models,
        [],
        "el SDK no recibe un cambio de modelo a mitad del turno",
      );
      assert.deepEqual(active.byType("model_changed"), []);
      assert.deepEqual(active.byType("agent_end"), [], "un rechazo no puede falsificar el terminal");

      // La admisión sigue en manos del turno: otro hub no puede colarse.
      other.send({ type: "prompt", text: "otra" });
      const busy = await other.waitFor(
        (message) => message.type === "error",
        "el rechazo del ocupado",
      );
      assert.match(String(busy.message), /ejecución en curso/);

      running.finish();
      await until(() => active.byType("agent_end").length === 1, "el terminal del turno real");
      other.send({ type: "prompt", text: "ahora sí" });
      await until(() => runtime.sessions.length === 2, "el turno siguiente se acepta");
      runtime.sessions[1].finish();
      await until(() => other.byType("agent_end").length === 1, "el terminal del turno siguiente");
    });
  },
);

test(
  "un prompt que falla antes del run libera la admisión y solo avisa al que lo pidió",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRunner(
      async ({ runtime, connect }) => {
        const failed = await connect();
        const other = await connect("telegram");

        failed.send({ type: "prompt", text: "hola" });
        const failure = await failed.waitFor(
          (message) => message.type === "error",
          "el error del prompt que no arrancó",
        );
        assert.match(String(failure.message), /credenciales/);
        assert.equal(runtime.sessions.length, 0, "el fallo de admisión no deja AgentSession");
        assert.deepEqual(
          failed.byType("agent_end"),
          [],
          "un fallo sin run no emite un terminal que no ocurrió",
        );
        assert.deepEqual(other.errors(), [], "el fallo no se difunde a otro hub");

        // La admisión quedó libre: el siguiente prompt se acepta de verdad.
        other.send({ type: "prompt", text: "ahora sí" });
        await until(() => runtime.sessions.length === 1, "el reintento llegue al SDK");
        assert.equal(runtime.sessions[0].key, "telegram");
        runtime.sessions[0].finish();
        await until(() => other.byType("agent_end").length === 1, "el terminal del reintento");
      },
      { failingCreations: 1 },
    );
  },
);
