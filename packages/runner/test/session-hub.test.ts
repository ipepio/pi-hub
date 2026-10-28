import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatHub, SessionHubRegistry } from "../src/hub.ts";
import { ExecutionBusyError } from "../src/execution-gate.ts";
import { SessionFactory, type ResolvedModel } from "../src/session.ts";
import {
  ASK_HUMAN_TOOL_NAME,
  SCHEDULE_TRIGGER_TOOL_NAME,
  REVOKE_TRIGGER_TOOL_NAME,
  type ServerWsMessage,
} from "@pihub/shared";
import { askHumanTool } from "../src/ask-human.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

function fakeFactory() {
  const prompts: Array<{ sessionKey: string; text: string }> = [];
  const factory = {
    forSession(sessionKey: string) {
      return {
        async create() {
          return {
            isStreaming: false,
            subscribe() {
              return () => {};
            },
            async prompt(text: string) {
              prompts.push({ sessionKey, text });
            },
            async abort() {},
            dispose() {},
          };
        },
      };
    },
  };
  return { factory, prompts };
}

test("cada sessionKey obtiene un ChatHub aislado y conserva el mismo hub al reabrirse", async () => {
  const { factory, prompts } = fakeFactory();
  const registry = new SessionHubRegistry(factory as never);

  const sessionA = registry.forKey("channel-a");
  const sessionB = registry.forKey("channel-b");
  assert.notStrictEqual(sessionA, sessionB);
  assert.strictEqual(registry.forKey("channel-a"), sessionA);

  await sessionA.prompt("mensaje A");
  await sessionB.prompt("mensaje B");

  assert.deepStrictEqual(prompts, [
    { sessionKey: "channel-a", text: "mensaje A" },
    { sessionKey: "channel-b", text: "mensaje B" },
  ]);
});

// ---------------------------------------------------------------------------
// P3.1: SessionFactory discrimina sesión humana vs. initiative
// ---------------------------------------------------------------------------

/** Crea un SessionFactory real con runtimeProviders falsificado que captura
 *  las sessionOptions y evita las dependencias de E/S. */
function fakeSessionFactory(sessionType: "human" | "initiative") {
  const captured: { options: Record<string, unknown> | null } = {
    options: null,
  };
  const factory = new SessionFactory(
    {
      dataDir: "/tmp",
      memoryEnabled: false,
      platformPromptEnabled: false,
    } as never,
    { name: "test", port: 0, enabled: true, createdAt: "2025-01-01" } as never,
    undefined,
    sessionType,
  );
  (factory as any).runtimeProviders = {
    createSession: async (opts: any) => {
      captured.options = opts;
      return {
        isStreaming: false,
        subscribe: () => () => {},
        async prompt() {},
        async abort() {},
        dispose() {},
      };
    },
    registerExtensionProviders: async () => {},
    resolveModel: async () => null,
  };
  return { factory, captured };
}

test("human prompts cannot see reserved ask_human even when an extension registers it", async () => {
  const { factory, captured } = fakeSessionFactory("human");
  await factory.create();
  assert.deepEqual(
    captured.options!.excludeTools,
    [ASK_HUMAN_TOOL_NAME],
    "human excluye ask_human aunque una extensión la registre",
  );
  assert.ok(
    !captured.options!.customTools,
    "human no inyecta la tool reservada",
  );
});

test("initiative sessions own the reserved ask_human, schedule_trigger and revoke_trigger tools", async () => {
  const { factory, captured } = fakeSessionFactory("initiative");
  await factory.create();
  const names = (captured.options!.customTools as Array<{ name: string }>).map(
    (t) => t.name,
  );
  assert.deepEqual(
    names,
    [ASK_HUMAN_TOOL_NAME, SCHEDULE_TRIGGER_TOOL_NAME, REVOKE_TRIGGER_TOOL_NAME],
    "initiative instala ask_human + schedule_trigger + revoke_trigger",
  );
  assert.ok(
    captured.options!.customTools.some(
      (t: { name: string }) => t.name === ASK_HUMAN_TOOL_NAME,
    ),
    "mantiene ask_human",
  );
  assert.ok(!captured.options!.excludeTools, "initiative no excluye ask_human");
  // askHumanTool (la instancia SDK) sigue siendo una de las tools inyectadas.
  assert.ok(
    (captured.options!.customTools as Array<{ name: string }>).some(
      (t) => t === askHumanTool,
    ),
    "la instancia reservada de ask_human está presente",
  );
});

test("isStreaming detecta un turno vivo en cualquier Channel Session", async () => {
  let streaming = false;
  const factory = {
    forSession() {
      return {
        async create() {
          return {
            get isStreaming() {
              return streaming;
            },
            subscribe() {
              return () => {};
            },
            async prompt() {},
            async abort() {},
            dispose() {},
          };
        },
      };
    },
  };
  const registry = new SessionHubRegistry(factory as never);
  const channel = registry.forKey("telegram");

  await channel.ensureSession();
  assert.equal(registry.isStreaming, false);
  streaming = true;
  assert.equal(registry.isStreaming, true);
  streaming = false;
  assert.equal(registry.isStreaming, false);
});

// ---------------------------------------------------------------------------
// P3.6: la factory keyed reanuda la última sesión del directorio tras restart;
//       new_session fuerza una sesión nueva (modo fresh) y nunca reabre la
//       conversación descartada.
// ---------------------------------------------------------------------------

/** Crea un SessionFactory real con runtimeProviders falsificado que captura el
 *  SessionManager de cada creación y devuelve una sesión fake con el sessionId
 *  real del manager (el manager persiste en ficheros reales en un dir temporal). */
async function keyedFactoryWithRealManager(
  dataDir: string,
  sessionType: "human" | "initiative",
) {
  const managers: SessionManager[] = [];
  const stub = {
    createSession: async (opts: any) => {
      const manager = opts.sessionManager as SessionManager;
      managers.push(manager);
      return {
        isStreaming: false,
        sessionId: manager.getSessionId(),
        subscribe: () => () => {},
        async prompt() {},
        async abort() {},
        dispose() {},
      };
    },
    registerExtensionProviders: async () => {},
    resolveModel: async () => null,
  };
  const factory = new SessionFactory(
    { dataDir, memoryEnabled: false, platformPromptEnabled: false } as never,
    { name: "test", port: 0, enabled: true, createdAt: "2025-01-01" } as never,
    undefined,
    sessionType,
  );
  // forSession crea una factory nueva: hay que stubbear su runtimeProviders,
  // no el de la factory base.
  return {
    keyed(sessionKey: string): SessionFactory {
      const keyed = factory.forSession(sessionKey);
      (keyed as any).runtimeProviders = stub;
      return keyed;
    },
    managers,
  };
}

/** Persiste una conversación real (usuario + asistente) en el SessionManager. */
function persistConversation(manager: SessionManager): void {
  manager.appendMessage({ role: "user", content: "hola" } as never);
  manager.appendMessage({ role: "assistant", content: "mundo" } as never);
  assert.ok(
    manager.getSessionFile(),
    "la conversación queda persistida en un fichero real",
  );
}

test("a recreated Initiative hub resumes the latest session for the same sessionKey", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pihub-a16-resume-"));

  // Primera vida: hub keyed initiative que crea y persiste una conversación.
  const first = await keyedFactoryWithRealManager(dataDir, "initiative");
  const hub1 = new ChatHub(first.keyed("channel-1"));
  await hub1.ensureSession();
  const firstManager = first.managers[0];
  assert.ok(firstManager, "la primera creación produce un SessionManager");
  persistConversation(firstManager);
  const originalSessionId = firstManager.getSessionId();
  const originalFile = firstManager.getSessionFile();

  // Restart simulado: un factory nuevo para la misma sessionKey.
  const second = await keyedFactoryWithRealManager(dataDir, "initiative");
  const hub2 = new ChatHub(second.keyed("channel-1"));
  await hub2.ensureSession();
  const resumedManager = second.managers[0];
  assert.strictEqual(
    resumedManager.getSessionId(),
    originalSessionId,
    "tras restart el hub reabre el mismo session ID/history de la misma sessionKey",
  );
  assert.strictEqual(
    resumedManager.getSessionFile(),
    originalFile,
    "tras restart reabre el mismo fichero de transcript",
  );
});

test("explicit new_session never resumes the discarded conversation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pihub-a16-fresh-"));
  const { keyed, managers } = await keyedFactoryWithRealManager(
    dataDir,
    "initiative",
  );
  const hub = new ChatHub(keyed("channel-2"));

  await hub.ensureSession();
  persistConversation(managers[0]);
  const originalSessionId = managers[0].getSessionId();
  assert.ok(originalSessionId);

    const newSessionId = await hub.newSession();
    assert.strictEqual(
      managers.length,
      2,
      "new_session crea un segundo SessionManager",
    );
    assert.notStrictEqual(
      managers[1].getSessionId(),
      originalSessionId,
      "new_session da un session ID nuevo: nunca reabre la conversación descartada",
    );
    assert.strictEqual(newSessionId, managers[1].getSessionId());
  });

// ---------------------------------------------------------------------------
// T4c — una sola ejecución por Runner (S2), aunque el Manager pierda su mapa
// de turnos o la conexión se caiga. El borde del SDK está falsificado; la gate
// de ejecución es la de producción.
// ---------------------------------------------------------------------------

/** Resuelve en el siguiente turno del bucle de eventos: deja asentar los `then`. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * AgentSession del SDK falsificada: `prompt()` devuelve una promesa que el
 * test resuelve a mano, que es lo único que el SDK real garantiza al asentarse
 * (`agent_end` → listeners → `finishRun()` → la promesa del prompt resuelve).
 */
class FakeSdkSession {
  isStreaming = false;
  disposed = false;
  aborts = 0;
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  readonly key: string;
  private settleRun?: () => void;
  private failRun?: (error: Error) => void;

  constructor(key: string) {
    this.key = key;
  }

  subscribe(): () => void {
    return () => {};
  }

  prompt(text: string): Promise<void> {
    this.isStreaming = true;
    this.prompts.push(text);
    return new Promise<void>((resolve, reject) => {
      this.settleRun = () => {
        this.isStreaming = false;
        this.settleRun = undefined;
        resolve();
      };
      // El SDK real rechaza el prompt ANTES del run (sin modelo o sin
      // credenciales): no emite ningún `agent_end`, solo rechaza.
      this.failRun = (error: Error) => {
        this.isStreaming = false;
        this.failRun = undefined;
        reject(error);
      };
    });
  }

  async setModel(model: ResolvedModel): Promise<void> {
    this.models.push(`${model.provider}/${model.id}`);
  }

  /** El abort del SDK espera a que el agente quede idle: NO resuelve el run
   *  por sí mismo. Aquí simula un run que sigue con tools en curso. */
  async abort(): Promise<void> {
    this.aborts += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Asienta el run en curso como lo haría el SDK al terminar de verdad. */
  finish(): void {
    this.settleRun?.();
  }

  /** Rechaza el prompt antes del run (preflight del SDK: sin credenciales). */
  fail(message: string): void {
    this.failRun?.(new Error(message));
  }
}

/** Factory keyed cuyo `create()` puede quedar pendiente a demanda. */
function fakeRuntime(
  options: { deferredCreation?: boolean; resolveModelTo?: ResolvedModel } = {},
) {
  const sessions: FakeSdkSession[] = [];
  const creations: Array<() => void> = [];
  const provider = (sessionKey: string) => ({
    config: { model: "proveedor/modelo" },
    sessionType: "human" as const,
    async create(): Promise<unknown> {
      if (options.deferredCreation) {
        await new Promise<void>((resolve) => creations.push(resolve));
      }
      const session = new FakeSdkSession(sessionKey);
      sessions.push(session);
      return session;
    },
    async resolveModel(): Promise<ResolvedModel | undefined> {
      return options.resolveModelTo;
    },
    // P3.6: la factory real la expone y newSession() la invoca tras reset().
    useFreshCreation(): void {},
  });
  const factory = {
    config: { model: "proveedor/modelo" },
    sessionType: "human",
    forSession: provider,
  };
  return { factory, sessions, creations };
}

test("una sola ejecución por Runner: otra sessionKey no puede ejecutar mientras la primera corre", async () => {
  const runtime = fakeRuntime();
  const registry = new SessionHubRegistry(runtime.factory as never);
  const sessionA = registry.forKey("channel-a");
  const sessionB = registry.forKey("channel-b");

  await sessionA.prompt("mensaje A");
  assert.equal(registry.isStreaming, true, "una ejecución en curso cuenta como trabajo pendiente");

  // Misma hub y hub distinta: la admisión es del RUNNER, no de la clave.
  await assert.rejects(sessionA.prompt("mensaje A2"), ExecutionBusyError);
  await assert.rejects(sessionB.prompt("mensaje B"), ExecutionBusyError);
  assert.deepEqual(
    runtime.sessions.map((session) => session.key),
    ["channel-a"],
    "un prompt rechazado no llega a crear la sesión de la otra clave",
  );

  runtime.sessions[0].finish();
  await settle();
  assert.equal(registry.isStreaming, false, "el asentamiento real del SDK libera la ejecución");

  await sessionB.prompt("mensaje B");
  assert.deepEqual(runtime.sessions.map((session) => session.key), ["channel-a", "channel-b"]);
  runtime.sessions[1].finish();
  await settle();
  assert.equal(registry.isStreaming, false);
});

test("que un suscriptor se desconecte no libera la ejecución en curso", async () => {
  const runtime = fakeRuntime();
  const registry = new SessionHubRegistry(runtime.factory as never);
  const hub = registry.forKey("channel-a");
  const unsubscribe = hub.subscribe(() => {});

  await hub.prompt("mensaje A");
  unsubscribe();

  assert.equal(registry.isStreaming, true, "el observador que se va no es el turno");
  await assert.rejects(registry.forKey("channel-b").prompt("mensaje B"), ExecutionBusyError);

  runtime.sessions[0].finish();
  await settle();
  assert.equal(registry.isStreaming, false);
});

test("un abort pedido no libera la ejecución: solo el asentamiento real del SDK lo hace", async () => {
  const runtime = fakeRuntime();
  const registry = new SessionHubRegistry(runtime.factory as never);
  const hub = registry.forKey("channel-a");

  await hub.prompt("mensaje A");
  await hub.abort();

  assert.equal(runtime.sessions[0].aborts, 1, "el abort llegó al SDK");
  assert.equal(
    registry.isStreaming,
    true,
    "el abort es una intención: el run (y sus tools) sigue en curso",
  );
  await assert.rejects(registry.forKey("channel-b").prompt("mensaje B"), ExecutionBusyError);

  runtime.sessions[0].finish();
  await settle();
  assert.equal(registry.isStreaming, false);
});

test("la admisión cubre la ventana de creación de la sesión", async () => {
  const runtime = fakeRuntime({ deferredCreation: true });
  const registry = new SessionHubRegistry(runtime.factory as never);
  const started = registry.forKey("channel-a").prompt("mensaje A");
  await settle();

  assert.equal(runtime.sessions.length, 0, "la creación sigue pendiente");
  assert.equal(
    registry.isStreaming,
    true,
    "una creación en curso ya es trabajo pendiente del Runner",
  );
  await assert.rejects(registry.forKey("channel-b").prompt("mensaje B"), ExecutionBusyError);

  runtime.creations[0]();
  await started;
  assert.equal(runtime.sessions.length, 1);

  runtime.sessions[0].finish();
  await settle();
  assert.equal(registry.isStreaming, false);
});

test("reset()/newSession() no pueden descartar una ejecución en curso", async () => {
  const runtime = fakeRuntime();
  const registry = new SessionHubRegistry(runtime.factory as never);
  const hub = registry.forKey("channel-a");

  await hub.prompt("mensaje A");
  const running = runtime.sessions[0];

  hub.reset();
  assert.equal(running.disposed, false, "reset no puede descartar la sesión que ejecuta");
  await assert.rejects(hub.newSession(), /ejecución/);
  await assert.rejects(registry.forKey("channel-b").prompt("mensaje B"), ExecutionBusyError);

  running.finish();
  await settle();

  // Ya libre: reset() vuelve a descartar y newSession() crea de verdad.
  hub.reset();
  assert.equal(running.disposed, true);
  await hub.newSession();
  assert.equal(runtime.sessions.length, 2, "newSession sin ejecución sigue creando una sesión");
});

test("un turno que falla libera la admisión y solo avisa a los suscriptores de ese turno", async () => {
  const runtime = fakeRuntime();
  const registry = new SessionHubRegistry(runtime.factory as never);
  const hub = registry.forKey("channel-a");
  const other = registry.forKey("channel-b");
  const hubMessages: ServerWsMessage[] = [];
  const otherMessages: ServerWsMessage[] = [];
  hub.subscribe((message) => hubMessages.push(message));
  other.subscribe((message) => otherMessages.push(message));

  await hub.prompt("mensaje A");
  const failure = "No hay credenciales configuradas para el proveedor";
  runtime.sessions[0].fail(failure);
  await settle();

  assert.deepEqual(
hubMessages,
[{ type: "error", message: failure }],
"el fallo del turno se avisa a los suscriptores de ESE turno, y solo como error",
  );
  assert.deepEqual(otherMessages, [], "el fallo no se difunde a otra hub");
  assert.equal(registry.isStreaming, false, "un turno fallido también libera la admisión");
  assert.equal(
runtime.sessions[0].disposed,
false,
"un fallo no descarta la sesión: la conversación sigue siendo reutilizable",
  );

  // La admisión quedó libre de verdad: el siguiente prompt se acepta.
  await other.prompt("mensaje B");
  assert.deepEqual(runtime.sessions.map((session) => session.key), [
"channel-a",
"channel-b",
  ]);
  runtime.sessions[1].finish();
  await settle();
  assert.equal(registry.isStreaming, false);
});

test("cambiar el modelo durante la admisión se rechaza y no descarta ni libera la ejecución", async () => {
  const target = { provider: "proveedor", id: "otro" } as unknown as ResolvedModel;
  const runtime = fakeRuntime({ deferredCreation: true, resolveModelTo: target });
  const registry = new SessionHubRegistry(runtime.factory as never);
  const hub = registry.forKey("channel-a");
  const started = hub.prompt("mensaje A");
  await settle();

  await assert.rejects(hub.setModel("proveedor/otro"), /en curso/);
  assert.equal(runtime.sessions.length, 0, "el cambio de modelo rechazado no crea una sesión");
  assert.equal(registry.isStreaming, true, "el cambio de modelo rechazado no libera la admisión");
  await assert.rejects(
registry.forKey("channel-b").prompt("mensaje B"),
ExecutionBusyError,
  );

  runtime.creations[0]();
  await started;
  assert.deepEqual(
runtime.sessions[0].models,
[],
"el SDK no recibe un cambio de modelo a mitad del turno",
  );

  runtime.sessions[0].finish();
  await settle();
  await hub.setModel("proveedor/otro");
  assert.deepEqual(
runtime.sessions[0].models,
["proveedor/otro"],
"sin turno en curso, el cambio de modelo sí se aplica sobre la misma sesión",
  );
  assert.equal(registry.isStreaming, false);
});
