import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  HumanRequestChannel,
  HumanRequestChannelInput,
} from "../src/primary-channel/human-request-delivery.ts";
import { createLateBoundHitl } from "../src/channels/hitl-bridge.ts";

// B1 (verify round, blocker) — HITL proactive delivery was a production no-op.
//
// `composeChannels` builds the `hitl` seam (spec: a waiting-human card leaves
// through the SAME router/outbox as any other non-web message, decided by the
// BINDING), and `HumanRequestDelivery` accepts it as `options.channel`. The
// composition root never connected the two: the only door it passed was a legacy
// Bot API client reading `agent.json.telegramToken`, a field the cutover stopped
// writing — so a Telegram-origin card was silently dropped (spec `agent-channels`
// → "Unified session delivery-by-origin", case 3: proactive/HITL → both surfaces).
//
// The wiring cannot be a plain value: `TurnExecution` (and with it
// `HumanRequestDelivery`) is built at step 8 of `runStartup`, while
// `composeChannels` runs at step 13. This file pins the piece that closes that
// window — a stable door that is FAIL-CLOSED until the composition binds it:
//   * `boundChatOf` answers `null`, which the delivery turns into the documented
//     `HUMAN_REQUEST_DELIVERY_SKIPPED reason=no_bound_channel` (zero effects, zero
//     reversions — the same shape as "no primary chat");
//   * `enqueue` rejects, so nothing can ever pretend a card was queued.

interface Spy extends HumanRequestChannel {
  readonly calls: string[];
  readonly inputs: HumanRequestChannelInput[];
}

function spyChannel(boundChatId: string | null = "424242"): Spy {
  const calls: string[] = [];
  const inputs: HumanRequestChannelInput[] = [];
  return {
    calls,
    inputs,
    async boundChatOf(agentName: string): Promise<string | null> {
      calls.push(`boundChatOf:${agentName}`);
      return boundChatId;
    },
    async enqueue(input: HumanRequestChannelInput): Promise<void> {
      calls.push(`enqueue:${input.agentName}`);
      inputs.push(input);
    },
  };
}

describe("late-bound HITL door (composition root, fix B1)", () => {
  it("sin composición: boundChatOf es null y enqueue lanza — nunca una tarjeta fantasma", async () => {
    const door = createLateBoundHitl({ log: () => {} });

    assert.equal(await door.channel.boundChatOf("alice"), null);
    await assert.rejects(
      () => door.channel.enqueue({ agentName: "alice", text: "tarjeta", requestId: "req-1" }),
      /not bound|no está enlazada/i,
      "sin puerta no se encola nada",
    );
    assert.equal(door.bound, false);
  });

  it("tras bind: delega las dos llamadas en la costura REAL de la composición", async () => {
    const door = createLateBoundHitl({ log: () => {} });
    const inner = spyChannel("777");
    door.bind(inner);

    assert.equal(door.bound, true);
    assert.equal(await door.channel.boundChatOf("alice"), "777");
    await door.channel.enqueue({ agentName: "alice", text: "tarjeta", requestId: "req-2" });

    assert.deepEqual(inner.calls, ["boundChatOf:alice", "enqueue:alice"]);
    assert.deepEqual(inner.inputs, [
      { agentName: "alice", text: "tarjeta", requestId: "req-2" },
    ]);
  });

  it("un re-bind reemplaza la puerta: la anterior queda fuera de uso", async () => {
    const logs: string[] = [];
    const door = createLateBoundHitl({ log: (line) => logs.push(line) });
    const first = spyChannel("1");
    const second = spyChannel("2");
    door.bind(first);
    assert.equal(await door.channel.boundChatOf("alice"), "1", "mientras la primera está ligada");
    door.bind(second);

    assert.equal(await door.channel.boundChatOf("alice"), "2");
    assert.deepEqual(first.calls, ["boundChatOf:alice"], "la primera ya no recibe nada");
    assert.deepEqual(second.calls, ["boundChatOf:alice"]);
    assert.match(
      logs.join(" "),
      /REBOUND/,
      "un doble bind es visible en el log, nunca silencioso",
    );
  });
});
