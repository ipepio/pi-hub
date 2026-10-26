import type { ChannelKind, InboundMessage } from "@pihub/channels";
import type {
  CompletedTurn,
  TurnExecution,
} from "../agenda/turn-execution.ts";
import type { HumanRequestChannel } from "../primary-channel/human-request-delivery.ts";
import { ChannelDeliveryRouter } from "./delivery-router.ts";
import { ChannelInboundHandler } from "./inbound.ts";
import type { ChannelExchangeLog } from "./exchange-log.ts";
import type { ChannelOutbox, ChannelOutboxOptions } from "./outbox.ts";
import { ChannelOutboxWorker } from "./outbox-worker.ts";
import type { ChannelPersistence } from "./persistence.ts";
import type { PairingMachine } from "./pairing.ts";

/**
 * Slice (c) part 3a, items 4-5 — the single place the channel machinery is
 * bolted together.
 *
 * Parts 1 and 2 shipped each piece as a class with its own injectable seams, and
 * the result was a Manager that could not deliver anything: no code built the
 * outbox (the SQLite driver was hidden), nothing called `drain()`, no
 * `GET …/channel-exchanges` reader was wired, `onTurnCompleted` had no consumer
 * and `registry.attachInbound` was never called. This file is that wiring, and
 * only that: every decision (retry, backoff, lease, origin routing, pairing)
 * stays with the module that owned it before.
 *
 * ```
 *  inbound (adapter.onInbound) ─▶ pairing ─▶ turns.startTurn(origin: channel)
 *                                                     │ completion
 *                                                     ▼
 *                       router.onTurnCompleted ─▶ channel_exchanges  (mirror for D)
 *                                                     │
 *                                                     ▼
 *                                          channel_outbox ─▶ worker.drain ─▶ registry.send
 * ```
 *
 * Two facts about the shape of this function:
 * - **It has no I/O of its own.** It builds objects; it does not start the
 *   drain loop. The composition root (`startup.ts` + `index.ts`) decides when
 *   the heartbeat begins and when it stops, because that order is a shutdown
 *   contract, not a channel one.
 * - **The transport is the registry.** The outbox's `send` goes through
 *   `ChannelRuntimeRegistry.send`, i.e. through the LIVE adapter of that Agent +
 *   kind. No adapter is a retryable `unavailable` (the channel may come back),
 *   and this file never sees a token.
 */

/** Registry face the composition needs: the transport door and the inbound slot. */
export interface ChannelTransportLike {
  send(
    agentName: string,
    kind: ChannelKind,
    input: { chatId: string; text: string },
  ): Promise<{ messageId: string }>;
  attachInbound(
    handler: (agentName: string, kind: ChannelKind, message: InboundMessage) => void,
  ): void;
}

export interface ChannelCompositionDeps {
  /** Where `channels.json` lives: the binding check reads it. */
  dataDir: string;
  /** The v4 tables, through the narrow `ManagerStore` facade. */
  persistence: ChannelPersistence;
  registry: ChannelTransportLike;
  pairing: PairingMachine;
  /** The shared `TurnExecution`: a channel inbound becomes a real turn. */
  turns: Pick<TurnExecution, "startTurn">;
  /** Runner port resolver — never a restart, never a port in the wire. */
  resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  /** Outbox tuning (tests shorten the lease/backoff; production takes the defaults). */
  outbox?: Pick<
    ChannelOutboxOptions,
    "maxAttempts" | "leaseMs" | "backoffBaseMs" | "backoffCapMs" | "batch"
  >;
  /** Drain cadence of the worker the caller starts later. */
  drainIntervalMs?: number;
}

export interface ChannelComposition {
  outbox: ChannelOutbox;
  exchanges: ChannelExchangeLog;
  router: ChannelDeliveryRouter;
  inbound: ChannelInboundHandler;
  /**
   * HITL door (fix H3): the face `HumanRequestDelivery` takes. A waiting-human
   * card is an agent-originated message like any other, so it leaves through the
   * SAME router/outbox and is decided by the SAME binding — never by an
   * `agent.json.telegramToken`, which the cutover stopped writing and whose
   * silence was what made the card disappear.
   */
  hitl: HumanRequestChannel;
  /** Built, NOT started: the composition root owns start/stop. */
  worker: ChannelOutboxWorker;
  /**
   * The exact face `TurnExecution.onTurnCompleted` takes. Fire-and-forget and
   * silent about its own failures — a broken delivery path must never turn a
   * finished Agent turn into a failed one, and a Manager without channels
   * composed simply does not pass this hook at all.
   */
  onTurnCompleted: (turn: CompletedTurn) => void;
}

/** Builds the channel runtime for one Manager process. Pure object assembly. */
export function composeChannels(deps: ChannelCompositionDeps): ChannelComposition {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.error(`[channels] ${line}`));
  const exchanges = deps.persistence.exchanges;

  // The queue: its transport is the LIVE adapter, resolved per row. A row that
  // asks for a channel that is not running is a retryable failure, decided by
  // the outbox — this closure only reports what the registry said.
  const outbox = deps.persistence.createOutbox({
    ...deps.outbox,
    now,
    log,
    send: async (row) => {
      const { messageId } = await deps.registry.send(row.agentName, row.kind, {
        chatId: row.target,
        text: row.text,
      });
      return messageId;
    },
  });

  // Delivery-by-origin: the reply of a channel turn and the proactive message
  // both leave through the outbox, and both mirror into `channel_exchanges`.
  const router = new ChannelDeliveryRouter({
    dataDir: deps.dataDir,
    pairing: deps.pairing,
    exchanges,
    now,
    log,
    enqueue: async (input) => {
      await outbox.enqueue(input);
    },
  });

  const inbound = new ChannelInboundHandler({
    dataDir: deps.dataDir,
    pairing: deps.pairing,
    turns: deps.turns,
    resolveRunner: deps.resolveRunner,
    log,
    // System replies (a pairing code) are outbox rows too: the transport is
    // never touched directly, so one owner keeps the retry policy.
    enqueue: async (input) => {
      await outbox.enqueue({
        agentName: input.agentName,
        kind: input.kind,
        target: input.chatId,
        payload: JSON.stringify({ text: input.text }),
      });
    },
  });

  // The seam part 2b left dangling: the registry carries the inbound callback,
  // and this is the only call that makes a bot message reach a turn.
  deps.registry.attachInbound((agentName, kind, message) =>
    inbound.handle(agentName, kind, message),
  );

  const worker = new ChannelOutboxWorker({
    outbox,
    intervalMs: deps.drainIntervalMs,
    leaseMs: deps.outbox?.leaseMs,
    log,
  });

  /**
   * The HITL door, on the two seams that already exist: `router.boundChatOf` (is
   * there a destination?) and `router.enqueueProactive` (mirror + outbox row). No
   * token crosses this boundary in either direction, and the card gets the
   * queue's retry/backoff/idempotency for free.
   *
   * `turnId = hitl:<requestId>` is deliberate: `channel_exchanges.turn_id` is
   * UNIQUE, so replaying the same human request cannot append a second mirror
   * row, while a NEW question (new requestId) is a NEW exchange.
   */
  const hitl: HumanRequestChannel = {
    boundChatOf: (agentName) => router.boundChatOf(agentName, "telegram"),
    enqueue: async ({ agentName, text, requestId }) => {
      const queued = await router.enqueueProactive({
        agentName,
        text,
        kind: "telegram",
        turnId: `hitl:${requestId}`,
      });
      if (!queued) {
        throw new Error(
          `no bound "telegram" channel for agent "${agentName}": HITL card not queued`,
        );
      }
    },
  };

  return {
    outbox,
    exchanges,
    router,
    inbound,
    hitl,
    worker,
    onTurnCompleted: (turn) => router.handle(turn),
  };
}
