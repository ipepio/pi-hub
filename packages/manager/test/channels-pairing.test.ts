import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentPaths, scaffoldAgentDirs, scaffoldGlobalDirs } from "@pihub/shared";
import {
  MAX_PENDING_PAIRINGS,
  PairingError,
  type PairingErrorCode,
  PAIRING_CODE_TTL_MS,
  PairingMachine,
  type ChannelPairing,
} from "../src/channels/pairing.ts";
import { writeChannelRecords } from "../src/channels/store.ts";

// Slice (c) part 2a — the Manager-owned pairing machine (design §2.1, specs
// `agent-channels` "auto-pair-1h window" + "post-window approval flow").
//
// The four rules these tests pin:
//   1. auto-pair is allowed ONLY while the projected window is open AND the
//      channel has no binding yet — the Manager never invents a window;
//   2. no stealing: a bound channel never rebinds to another chat implicitly;
//   3. after the window, a pairing CODE is the only way in — hashed at rest,
//      single use, timing-safe verified, max 3 pending per channel, 1 h TTL;
//   4. a manual unbind does NOT re-arm auto-pair for that same window
//      (spec "Manual unbind does NOT re-arm auto-pair", resolution 2).
//
// Secrets: the plaintext code crosses the return value only. Nothing here may
// put it on disk, and no token-shaped field may ever be persisted.

const HOUR = 3_600_000;

function hashOf(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Fixed clock: the window and the TTL are both relative to `now`. */
function clock(start = 1_761_100_800_000) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
    iso: (offsetMs: number) => new Date(state.now + offsetMs).toISOString(),
  };
}

async function setup(agentName = "agent") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-pairing-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  return dataDir;
}

async function tearDown(dataDir: string): Promise<void> {
  await fs.rm(dataDir, { recursive: true, force: true });
}

/** Project the desired channel set the way `PUT /agents/:name/channels` does. */
async function project(
  dataDir: string,
  agentName: string,
  windowEndsAt: string | null | undefined,
): Promise<void> {
  await writeChannelRecords(dataDir, agentName, [
    {
      kind: "telegram",
      label: "personal",
      tokenDigest: "a".repeat(64),
      pairingWindowEndsAt: windowEndsAt ?? undefined,
      observedStatus: "active",
      updatedAt: 1,
    },
  ]);
}

async function pairingFile(dataDir: string, agentName = "agent"): Promise<string> {
  try {
    return await fs.readFile(
      path.join(agentPaths(dataDir, agentName).root, "channel-pairing.json"),
      "utf8",
    );
  } catch {
    return "";
  }
}

async function machineFor(
  dataDir: string,
  time: ReturnType<typeof clock>,
): Promise<PairingMachine> {
  return new PairingMachine({ dataDir, now: time.now });
}

async function expectPairingError(
  action: () => Promise<unknown>,
  code: PairingErrorCode,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof PairingError, `expected PairingError, got ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe("pairing — auto-pair window", () => {
  it("auto-pairs the first chat while the projected window is open", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", time.iso(HOUR));
      const machine = await machineFor(dataDir, time);

      const result = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(result.autoPaired, true);
      assert.equal(result.code, undefined, "auto-pair never mints a code");
      assert.equal(result.pairing.state, "active");
      assert.equal(result.pairing.externalChatId, "10001");
      assert.equal(result.pairing.pairedAt, time.now());
      assert.deepEqual(result.pairing.pending, []);
    } finally {
      await tearDown(dataDir);
    }
  });

  it("window null = CERRADA (tombstone H4): unknown chat gets a code, no binding", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);

      const result = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(result.autoPaired, false);
      assert.equal(typeof result.code, "string");
      assert.equal(result.pairing.state, "pending");
      assert.equal(result.pairing.externalChatId, null);
      assert.equal(result.pairing.pairedAt, null);
      assert.equal(result.pairing.pending.length, 1);
      assert.equal(result.pairing.pending[0].externalChatId, "10001");
      assert.equal(
        result.pairing.pending[0].expiresAt - result.pairing.pending[0].requestedAt,
        PAIRING_CODE_TTL_MS,
      );
    } finally {
      await tearDown(dataDir);
    }
  });

  it("window absent means closed too: the Manager never derives a window itself", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", undefined);
      const machine = await machineFor(dataDir, time);
      const result = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(result.autoPaired, false);
      assert.equal(result.pairing.state, "pending");
    } finally {
      await tearDown(dataDir);
    }
  });

  it("an expired window is closed: approval flow, not auto-pair", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", time.iso(-1));
      const machine = await machineFor(dataDir, time);
      const result = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(result.autoPaired, false);
      assert.equal(result.pairing.state, "pending");
    } finally {
      await tearDown(dataDir);
    }
  });

  it("a channel with no projected record cannot pair at all", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      const machine = await machineFor(dataDir, time);
      await expectPairingError(
        () => machine.requestPairing("agent", "telegram", "10001"),
        "CHANNEL_NOT_FOUND",
      );
    } finally {
      await tearDown(dataDir);
    }
  });
});

describe("pairing — codes at rest", () => {
  it("the code is 8 unambiguous chars and only its sha256 is persisted", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);

      const first = await machine.requestPairing("agent", "telegram", "10001");
      const second = await machine.requestPairing("agent", "telegram", "10002");
      const code = first.code as string;

      assert.match(code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
      assert.notEqual(code, second.code, "codes must not repeat");
      assert.equal(first.pairing.pending[0].codeHash, hashOf(code));

      const raw = await pairingFile(dataDir);
      assert.ok(raw.includes(hashOf(code)), "the hash is what rests on disk");
      assert.equal(raw.includes(code), false, "the plaintext code must never be written");
      assert.equal(raw.includes('"code"'), false);
      assert.equal(raw.includes('"token"'), false);
    } finally {
      await tearDown(dataDir);
    }
  });

  it("max 3 pending requests per channel: the 4th is rejected", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      for (let chat = 1; chat <= MAX_PENDING_PAIRINGS; chat += 1) {
        const result = await machine.requestPairing("agent", "telegram", `chat-${chat}`);
        assert.equal(typeof result.code, "string");
      }
      assert.equal(
        (await machine.stateOf("agent", "telegram"))?.pending.length,
        MAX_PENDING_PAIRINGS,
      );
      await expectPairingError(
        () => machine.requestPairing("agent", "telegram", "chat-4"),
        "CHANNEL_PAIRING_LIMIT",
      );
      assert.equal(
        (await machine.stateOf("agent", "telegram"))?.pending.length,
        MAX_PENDING_PAIRINGS,
        "the rejected request must not be queued",
      );
    } finally {
      await tearDown(dataDir);
    }
  });

  it("an expired pending request stops verifying and is swept out", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const issued = await machine.requestPairing("agent", "telegram", "10001");
      const code = issued.code as string;

      time.advance(PAIRING_CODE_TTL_MS + 1);
      await expectPairingError(
        () => machine.approve("agent", "telegram", { code, externalChatId: "10001" }),
        "CHANNEL_PAIRING_CODE_INVALID",
      );

      const again = await machine.requestPairing("agent", "telegram", "10002");
      assert.equal(again.pairing.pending.length, 1, "the stale row was swept");
      assert.equal(again.pairing.pending[0].externalChatId, "10002");
    } finally {
      await tearDown(dataDir);
    }
  });
});

describe("pairing — approval", () => {
  it("the right code binds the chat and the code is single use", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const issued = await machine.requestPairing("agent", "telegram", "10001");
      const code = issued.code as string;

      const approved = await machine.approve("agent", "telegram", {
        code,
        externalChatId: "10001",
      });
      assert.equal(approved.state, "active");
      assert.equal(approved.externalChatId, "10001");
      assert.equal(approved.pairedAt, time.now());
      assert.deepEqual(approved.pending, []);

      await expectPairingError(
        () => machine.approve("agent", "telegram", { code, externalChatId: "10001" }),
        "CHANNEL_PAIRING_CODE_INVALID",
      );
    } finally {
      await tearDown(dataDir);
    }
  });

  it("a wrong code is refused with a timing-safe comparison and binds nothing", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const issued = await machine.requestPairing("agent", "telegram", "10001");

      await expectPairingError(
        () =>
          machine.approve("agent", "telegram", {
            code: `${issued.code}X`,
            externalChatId: "10001",
          }),
        "CHANNEL_PAIRING_CODE_INVALID",
      );
      await expectPairingError(
        () =>
          machine.approve("agent", "telegram", {
            code: "ZZZZZZZZ",
            externalChatId: "10001",
          }),
        "CHANNEL_PAIRING_CODE_INVALID",
      );
      const state = await machine.stateOf("agent", "telegram");
      assert.equal(state?.state, "pending");
      assert.equal(state?.externalChatId, null);
    } finally {
      await tearDown(dataDir);
    }
  });

  it("a code only ever pairs the chat it was issued for", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const issued = await machine.requestPairing("agent", "telegram", "10001");
      await expectPairingError(
        () =>
          machine.approve("agent", "telegram", {
            code: issued.code as string,
            externalChatId: "99999",
          }),
        "CHANNEL_PAIRING_CODE_INVALID",
      );
      assert.equal((await machine.stateOf("agent", "telegram"))?.state, "pending");
    } finally {
      await tearDown(dataDir);
    }
  });

  it("approving on an unprojected channel is CHANNEL_NOT_FOUND", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      const machine = await machineFor(dataDir, time);
      await expectPairingError(
        () => machine.approve("agent", "telegram", { code: "ABCDEFGH", externalChatId: "1" }),
        "CHANNEL_NOT_FOUND",
      );
    } finally {
      await tearDown(dataDir);
    }
  });
});

describe("pairing — no stealing", () => {
  it("a bound channel refuses a different chat, inside or outside the window", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", time.iso(HOUR));
      const machine = await machineFor(dataDir, time);
      await machine.requestPairing("agent", "telegram", "10001");

      await expectPairingError(
        () => machine.requestPairing("agent", "telegram", "10002"),
        "CHANNEL_ALREADY_BOUND",
      );
      const state = await machine.stateOf("agent", "telegram");
      assert.equal(state?.externalChatId, "10001", "the binding did not move");
      assert.deepEqual(state?.pending, []);

      time.advance(HOUR * 2);
      await expectPairingError(
        () => machine.requestPairing("agent", "telegram", "10002"),
        "CHANNEL_ALREADY_BOUND",
      );
    } finally {
      await tearDown(dataDir);
    }
  });

  it("the bound chat re-requesting is idempotent: active, no code", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const issued = await machine.requestPairing("agent", "telegram", "10001");
      await machine.approve("agent", "telegram", {
        code: issued.code as string,
        externalChatId: "10001",
      });

      const again = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(again.pairing.state, "active");
      assert.equal(again.code, undefined);
      assert.equal(again.autoPaired, false, "already bound is not a fresh auto-pair");
    } finally {
      await tearDown(dataDir);
    }
  });
});

describe("pairing — unbind does not re-arm the window", () => {
  it("after unbind the same chat needs approval, until a NEW window is projected", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      const window = time.iso(HOUR);
      await project(dataDir, "agent", window);
      const machine = await machineFor(dataDir, time);
      await machine.requestPairing("agent", "telegram", "10001");

      const cleared = await machine.unbind("agent", "telegram");
      assert.equal(cleared.state, "unpaired");
      assert.equal(cleared.externalChatId, null);
      assert.equal(cleared.pairedAt, null);

      // Same window still open on disk: res.2 forbids re-arming auto-pair.
      const after = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(after.autoPaired, false);
      assert.equal(after.pairing.state, "pending");

      // A new token activation projects a new window: auto-pair is live again.
      await project(dataDir, "agent", time.iso(HOUR * 5));
      const rearmed = await machine.requestPairing("agent", "telegram", "10002");
      assert.equal(rearmed.autoPaired, true);
      assert.equal(rearmed.pairing.externalChatId, "10002");
    } finally {
      await tearDown(dataDir);
    }
  });

  it("unbind on an unbound channel is a no-op, not an error", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      const state = await machine.unbind("agent", "telegram");
      assert.equal(state.state, "unpaired");
      assert.equal(state.externalChatId, null);
    } finally {
      await tearDown(dataDir);
    }
  });

  it("reject drops only the request of that chat and settles the state", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      await machine.requestPairing("agent", "telegram", "10001");
      await machine.requestPairing("agent", "telegram", "10002");

      const rejected = await machine.reject("agent", "telegram", "10001");
      assert.equal(rejected.pending.length, 1);
      assert.equal(rejected.pending[0].externalChatId, "10002");
      assert.equal(rejected.state, "pending");

      const last = await machine.reject("agent", "telegram", "10002");
      assert.deepEqual(last.pending, []);
      assert.equal(last.state, "unpaired");

      const idempotent = await machine.reject("agent", "telegram", "10002");
      assert.deepEqual(idempotent.pending, []);
    } finally {
      await tearDown(dataDir);
    }
  });
});

describe("pairing — persistence and channel removal", () => {
  it("state reloads from disk in a fresh Manager process", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const issued = await (
        await machineFor(dataDir, time)
      ).requestPairing("agent", "telegram", "10001");
      const code = issued.code as string;

      const reloaded = await machineFor(dataDir, time);
      const approved = await reloaded.approve("agent", "telegram", {
        code,
        externalChatId: "10001",
      });
      assert.equal(approved.state, "active");
      assert.equal(approved.externalChatId, "10001");
    } finally {
      await tearDown(dataDir);
    }
  });

  it("remove deletes one channel; prune keeps only the projected kinds", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      const machine = await machineFor(dataDir, time);
      await machine.requestPairing("agent", "telegram", "10001");
      assert.ok(await machine.stateOf("agent", "telegram"));

      await machine.remove("agent", "telegram");
      assert.equal(await machine.stateOf("agent", "telegram"), undefined);

      await machine.requestPairing("agent", "telegram", "10002");
      await machine.prune("agent", []);
      assert.equal(await machine.stateOf("agent", "telegram"), undefined);

      const raw = await pairingFile(dataDir);
      assert.equal(raw.includes(hashOf("10002")), false);
    } finally {
      await tearDown(dataDir);
    }
  });

  it("a corrupt pairing file fails closed to unpaired instead of throwing", async () => {
    const time = clock();
    const dataDir = await setup();
    try {
      await project(dataDir, "agent", null);
      await fs.writeFile(
        path.join(agentPaths(dataDir, "agent").root, "channel-pairing.json"),
        "{no es json",
        "utf8",
      );
      const machine = await machineFor(dataDir, time);
      const state: ChannelPairing | undefined = await machine.stateOf("agent", "telegram");
      assert.equal(state, undefined);
      const result = await machine.requestPairing("agent", "telegram", "10001");
      assert.equal(typeof result.code, "string");
    } finally {
      await tearDown(dataDir);
    }
  });
});
