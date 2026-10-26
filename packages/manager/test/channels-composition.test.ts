import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { ChannelAdapter, InboundMessage } from "@pihub/channels";
import { openManagerStore, type ManagerStore } from "../src/storage/sqlite.ts";
import { ChannelRuntimeRegistry } from "../src/channels/registry.ts";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import {
  composeChannels,
  type ChannelComposition,
} from "../src/channels/composition.ts";
import type {
  CompletedTurn,
  StartTurnCommand,
  TurnExecution,
} from "../src/agenda/turn-execution.ts";

// Slice (c) part 3a, items 4-5 — the composition itself.
//
// Everything the channel machinery needs already existed as a class; what was
// missing is the ONE place that connects them: `store.channels` (the SQLite
// seam) → outbox + exchange log → delivery router → `TurnExecution`'s
// `onTurnCompleted`, and the registry's late-bound `attachInbound` → the inbound
// handler → `turns.startTurn` with a channel origin. This file is the end-to-end
// of that wiring with a fake transport and no network:
//
//   inbound ─▶ pairing ─▶ turn(origin=channel) ─▶ onTurnCompleted
//                                                     │
//                                  channel_exchanges ◀┴▶ channel_outbox ─▶ drain ─▶ adapter.send
//
// The decisions themselves are pinned in `channels-delivery.test.ts` and
// `channels-inbound.test.ts`; here the question is only whether the pieces are
// actually bolted together, so every assertion reads the REAL v4 tables.

const dirs: string[] = [];
const stores: ManagerStore[] = [];
const compositions: ChannelComposition[] = [];

async function setup(agentName = "agent"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-channels-composition-"));
  dirs.push(dir);
  await scaffoldGlobalDirs(dir);
  await scaffoldAgentDirs(dir, agentName);
  await writeAgent(dir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dir;
}

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.worker.stop({ graceMs: 0 });
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Fake transport: records sends and hands back the `onInbound` the registry gave it. */
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

function record(pairingWindowEndsAt: string | null): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "a".repeat(64),
    pairingWindowEndsAt,
    observedStatus: "active",
    updatedAt: 1_761_100_800_000,
  };
}

/** Turn bridge fake: records the commands and resolves every completion. */
function fakeTurns() {
  const commands: StartTurnCommand[] = [];
  const turns = {
    startTurn(command: StartTurnCommand) {
      commands.push(command);
      return {
        completion: Promise.resolve({ event: "turn-complete", data: { turnId: command.turnId } }),
        disconnect(): void {},
      };
    },
  } as unknown as Pick<TurnExecution, "startTurn">;
  return { turns, commands };
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function channelTurn(turnId = "turn-1"): CompletedTurn {
  return {
    agentName: "agent",
    turnId,
    origin: { kind: "channel", channelKind: "telegram", chatId: "12345" },
    userText: "hola",
    replyText: "respuestita",
    finalEvent: "turn-complete",
  };
}

describe("composeChannels — el cableado de slice (c) part 3a", () => {
  /** Store + registry + pairing + turns, all real, one temp dataDir. */
  async function harness(options: { window?: string | null } = {}) {
    const dataDir = await setup();
    const store = await openManagerStore(dataDir);
    stores.push(store);
    const transport = fakeTransport();
    const registry = new ChannelRuntimeRegistry({
      adapterFactory: transport.adapterFactory,
    });
    const pairing = new PairingMachine({ dataDir });
    const bridge = fakeTurns();
    await writeChannelRecords(dataDir, "agent", [
      record(options.window === undefined ? "2099-01-01T00:00:00.000Z" : options.window),
    ]);
    const composition = composeChannels({
      dataDir,
      persistence: store.channels,
      registry,
      pairing,
      turns: bridge.turns,
      resolveRunner: async () => ({ port: 4100 }),
      now: () => 1_761_100_800_000,
      drainIntervalMs: 5,
    });
    compositions.push(composition);
    return { dataDir, store, transport, registry, pairing, bridge, composition };
  }

  it("expone la cara exacta que `TurnExecution` pide para `onTurnCompleted`", async () => {
    const h = await harness();
    const hook: TurnExecution["onTurnCompleted"] | undefined = h.composition.onTurnCompleted;
    assert.equal(typeof hook, "function");
  });

  it("un turno de origen canal encola la respuesta Y refleja el intercambio", async () => {
    const h = await harness();
    // Bind through the real machine first: the destination is the binding.
    await h.pairing.requestPairing("agent", "telegram", "12345");

    await h.composition.router.onTurnCompletedAsync(channelTurn());

    const pending = await h.composition.outbox.pendingOf("agent", "telegram");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.target, "12345");
    assert.equal(pending[0]?.text, "respuestita");

    const rows = h.composition.exchanges.listAfter("agent", 0);
    assert.deepEqual(
      rows.map((row) => [row.turnId, row.origin, row.userText, row.replyText]),
      [["turn-1", "telegram", "hola", "respuestita"]],
    );
  });

  it("un turno web NO encola ni refleja: la fila `human` de la tabla", async () => {
    const h = await harness();
    await h.pairing.requestPairing("agent", "telegram", "12345");

    await h.composition.router.onTurnCompletedAsync({
      ...channelTurn("turn-web"),
      origin: { kind: "human" },
    });

    assert.equal((await h.composition.outbox.pendingOf("agent", "telegram")).length, 0);
    assert.deepEqual(h.composition.exchanges.listAfter("agent", 0), []);
  });

  it("un turno de Initiative con canal vinculado se entrega como proactivo", async () => {
    const h = await harness();
    await h.pairing.requestPairing("agent", "telegram", "12345");

    await h.composition.router.onTurnCompletedAsync({
      ...channelTurn("turn-pro"),
      origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
      userText: "",
    });

    const pending = await h.composition.outbox.pendingOf("agent", "telegram");
    assert.equal(pending.length, 1);
    assert.equal(h.composition.exchanges.listAfter("agent", 0)[0]?.origin, "proactive");
  });

  it("un turno de Initiative SIN canal vinculado no inventa ninguna entrega", async () => {
    const h = await harness();
    await h.composition.router.onTurnCompletedAsync({
      ...channelTurn("turn-pro-suelto"),
      origin: { kind: "initiative", initiativeId: "ini-1", cause: "trigger" },
    });
    assert.equal((await h.composition.outbox.pendingOf("agent", "telegram")).length, 0);
    assert.deepEqual(h.composition.exchanges.listAfter("agent", 0), []);
  });

  it("el drene del worker usa el ADAPTADOR VIVO del registry para entregar", async () => {
    const h = await harness();
    await h.pairing.requestPairing("agent", "telegram", "12345");
    await h.registry.replaceAll("agent", [
      { kind: "telegram", token: "771234:AA-token", pairingWindowEndsAt: "2099-01-01T00:00:00.000Z" },
    ]);
    await h.composition.router.onTurnCompletedAsync(channelTurn());

    h.composition.worker.start();
    await until(async () => (await h.composition.outbox.pendingOf("agent", "telegram")).length === 0);

    assert.deepEqual(h.transport.sends, [{ chatId: "12345", text: "respuestita" }]);
    assert.equal(h.transport.sends.length, 1, "at-least-once: una sola llamada al transporte");
  });

  it("attachInbound: un mensaje entrante por el adapter llega a `turns.startTurn` con origen canal", async () => {
    const h = await harness();
    await h.registry.replaceAll("agent", [
      { kind: "telegram", token: "771234:AA-token", pairingWindowEndsAt: "2099-01-01T00:00:00.000Z" },
    ]);
    assert.equal(h.transport.pollers.length, 1, "fixture: adapter arrancado con onInbound");

    h.transport.pollers[0]!({
      externalChatId: "12345",
      text: "¿hora en Madrid?",
      messageId: "msg-99",
    });
    await until(() => h.bridge.commands.length === 1);
    await h.composition.inbound.idle();

    assert.equal(h.bridge.commands.length, 1);
    const command = h.bridge.commands[0]!;
    assert.equal(command.origin.kind, "channel");
    assert.deepEqual(command.origin, { kind: "channel", channelKind: "telegram", chatId: "12345" });
    assert.equal(command.message, "¿hora en Madrid?");
    assert.equal(command.sessionKey, `agent:agent:main`);

    // El auto-pair también es efecto del cableado: la máquina real vinculó el chat.
    const bound = await h.pairing.stateOf("agent", "telegram");
    assert.equal(bound?.state, "active");
    assert.equal(bound?.externalChatId, "12345");
  });

  it("la respuesta de emparejamiento viaja por el OUTBOX, no por el transporte directo", async () => {
    const h = await harness({ window: null }); // ventana cerrada → código
    await h.registry.replaceAll("agent", [
      { kind: "telegram", token: "771234:AA-token", pairingWindowEndsAt: null },
    ]);

    h.transport.pollers[0]!({ externalChatId: "777", text: "hola", messageId: "msg-1" });
    await until(async () => (await h.composition.outbox.pendingOf("agent", "telegram")).length === 1);
    await h.composition.inbound.idle();

    assert.equal(h.bridge.commands.length, 0, "un desconocido no gasta un turno");
    const pending = await h.composition.outbox.pendingOf("agent", "telegram");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.target, "777");
    assert.match(pending[0]!.text, /código de emparejamiento/);
    assert.equal(h.transport.sends.length, 0);
  });

  it("la cola del outbox vive en la MISMA base que el espejo de intercambios", async () => {
    const h = await harness();
    await h.pairing.requestPairing("agent", "telegram", "12345");
    await h.composition.router.onTurnCompletedAsync(channelTurn("turn-shared"));

    assert.equal(h.composition.exchanges.listAfter("agent", 0).length, 1);
    const counts = await h.composition.outbox.counts();
    assert.equal(counts.pending, 1);
  });

  it(`el enqueue proactivo interno devuelve el canal a ` + `partir del VÍNCULO`, async () => {
    const h = await harness();
    await h.pairing.requestPairing("agent", "telegram", "12345");

    const delivered = await h.composition.router.enqueueProactive({
      agentName: "agent",
      text: "te aviso de algo",
      turnId: "turn-aviso",
    });
    assert.equal(delivered, true);
    assert.equal((await h.composition.outbox.pendingOf("agent", "telegram"))[0]?.target, "12345");

    const without = await h.composition.router.enqueueProactive({
      agentName: "sin-canal",
      text: "nada que entregar",
    });
    assert.equal(without, false);
  });
});
