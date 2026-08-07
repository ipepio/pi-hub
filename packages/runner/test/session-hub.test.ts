import test from "node:test";
import assert from "node:assert/strict";
import { SessionHubRegistry } from "../src/hub.ts";
import { SessionFactory } from "../src/session.ts";
import { ASK_HUMAN_TOOL_NAME } from "@pihub/shared";
import { askHumanTool } from "../src/ask-human.ts";

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
  const captured: { options: Record<string, unknown> | null } = { options: null };
  const factory = new SessionFactory(
    { dataDir: "/tmp", memoryEnabled: false, platformPromptEnabled: false } as never,
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
  assert.ok(!captured.options!.customTools, "human no inyecta la tool reservada");
});

test("initiative sessions own the reserved ask_human and an extension cannot override it", async () => {
  const { factory, captured } = fakeSessionFactory("initiative");
  await factory.create();
  assert.deepEqual(
    captured.options!.customTools,
    [askHumanTool],
    "initiative instala la tool SDK reservada",
  );
  assert.ok(!captured.options!.excludeTools, "initiative no excluye ask_human");
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
