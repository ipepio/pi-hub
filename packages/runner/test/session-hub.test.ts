import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatHub, SessionHubRegistry } from "../src/hub.ts";
import { SessionFactory } from "../src/session.ts";
import {
  ASK_HUMAN_TOOL_NAME,
  SCHEDULE_TRIGGER_TOOL_NAME,
  REVOKE_TRIGGER_TOOL_NAME,
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
