import test from "node:test";
import assert from "node:assert/strict";
import { SessionHubRegistry } from "../src/hub.ts";

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
