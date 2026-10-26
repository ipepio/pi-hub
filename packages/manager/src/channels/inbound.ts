import { randomUUID } from "node:crypto";
import type { ChannelKind, InboundMessage } from "@pihub/channels";
import type { TurnExecution } from "../agenda/turn-execution.ts";
import { PairingError, type PairingMachine } from "./pairing.ts";
import { readChannelRecords } from "./store.ts";

/**
 * Inbound handler (design §1.4, tasks c-I6) — the consumer of the `onInbound`
 * seam the registry has carried since part 1.
 *
 * It is the place where the pairing machine stops being a library and becomes
 * the state machine the spec describes: an inbound message on an UNBOUND channel
 * is consumed here (open window ⇒ auto-pair with zero clicks and the message is
 * then processed; closed window ⇒ a pairing code goes back through the transport
 * and the message is NOT processed — §2.1 `pending --> pending`), and an inbound
 * message on a BOUND channel becomes an Agent turn.
 *
 * Three ownership decisions this file makes, each with one owner:
 * - **Delivery is not decided here.** The turn carries
 *   `origin: { kind: "channel", channelKind, chatId }`, and the completion hook
 *   (`channels/delivery-router.ts`) is what routes the reply to the outbox. The
 *   inbound path never calls the transport for an Agent reply, so a reply can
 *   only be sent through the outbox (retry policy has one owner).
 * - **The pairing code reply is a system message, not a turn.** It goes straight
 *   to `enqueue` and never reaches `TurnExecution`, so a stranger cannot spend
 *   the Agent's model or its single live-turn slot.
 * - **Never steal a binding.** A channel bound to chat A answers nothing to chat
 *   B: no turn, no code, no rebinding. Rebinding is `unbind` (the owner's click).
 *
 * Session model: the projected D→P channel contract deliberately carries no
 * `sessionKey` (slice (c) decision, `api-v1/schemas.ts`), so the Manager maps
 * the chat to the Agent's MAIN session — one conversation, two surfaces. This
 * is the unified-session reading of design §1.2 and it wins over ADR 0099's
 * per-channel session: a key that contained the chat id would split the Agent's
 * context per transport.
 *
 * Queueing: one bounded FIFO per `(agent, kind)` of depth 10, drained
 * sequentially (the Runner serves one live turn per Agent, and the
 * `TURN_IN_PROGRESS` discipline would refuse a second anyway). Overflow drops
 * the newest message with a log line — the same documented ephemerality as the
 * in-memory turn-idempotency map (`api-v1/turns.ts`): a restart loses it too.
 */

/** Messages waiting behind a live turn, per `(agent, kind)`. */
export const INBOUND_QUEUE_DEPTH = 10;

/** Outbound delivery of a transport-level message (pairing code): the outbox. */
export interface InboundEnqueueInput {
  agentName: string;
  kind: ChannelKind;
  chatId: string;
  text: string;
}

export type EnqueueFn = (input: InboundEnqueueInput) => void | Promise<void>;

/**
 * The Agent's main session key. Stable across restarts and across surfaces:
 * the Dashboard's web turns and the channel turns must land in one context.
 */
export function mainSessionKeyOf(agentName: string): string {
  return `agent:${agentName}:main`;
}

/**
 * Reply to a sender the channel is not bound to. Copy is a design non-decision
 * (§6.1); what is pinned is that the code travels and the message is not an
 * Agent answer.
 */
export function pairingCodeReplyText(code: string): string {
  return (
    `Este canal aún no está emparejado. Pide al propietario del agente que ` +
    `introduzca este código de emparejamiento: ${code}\n` +
    `Caduca en 1 hora y solo funciona desde este chat.`
  );
}

export interface ChannelInboundDeps {
  dataDir: string;
  pairing: PairingMachine;
  turns: Pick<TurnExecution, "startTurn">;
  /**
   * Runner resolver: `undefined` means "not running" and the message is dropped.
   * The port never leaves the Manager (`supervisor.statusOf`), and an inbound
   * message must never restart a Runner — that would let a stranger control the
   * process lifecycle.
   */
  resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  /** The outbox face: system replies (pairing code) go through it, never direct. */
  enqueue: EnqueueFn;
  /** Injectable for tests / a future projected session key. */
  sessionKeyFor?: (agentName: string, kind: ChannelKind, chatId: string) => string;
  newTurnId?: () => string;
  log?: (line: string) => void;
}

interface QueuedInbound {
  message: InboundMessage;
  /** Captured when the message was accepted, so a slow drain cannot re-pair. */
  sessionKey: string;
}

export class ChannelInboundHandler {
  private readonly dataDir: string;
  private readonly pairing: PairingMachine;
  private readonly turns: Pick<TurnExecution, "startTurn">;
  private readonly resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  private readonly enqueue: EnqueueFn;
  private readonly sessionKeyFor: (agentName: string, kind: ChannelKind, chatId: string) => string;
  private readonly newTurnId: () => string;
  private readonly log: (line: string) => void;
  private readonly queues = new Map<string, QueuedInbound[]>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(deps: ChannelInboundDeps) {
    this.dataDir = deps.dataDir;
    this.pairing = deps.pairing;
    this.turns = deps.turns;
    this.resolveRunner = deps.resolveRunner;
    this.enqueue = deps.enqueue;
    this.sessionKeyFor =
      deps.sessionKeyFor ?? ((agentName) => mainSessionKeyOf(agentName));
    this.newTurnId = deps.newTurnId ?? randomUUID;
    this.log = deps.log ?? ((line) => console.error(`[channels] ${line}`));
  }

  /**
   * Adapter-facing entry point: `ChannelAdapter.onInbound` is fire-and-forget by
   * contract (a slow turn must not stall long polling), so this swallows its
   * own errors and never returns a Promise to the transport.
   */
  handle(agentName: string, kind: ChannelKind, message: InboundMessage): void {
    void this.handleAsync(agentName, kind, message).catch((error) => {
      this.log(`inbound failed agent=${agentName} kind=${kind}: ${String(error)}`);
    });
  }

  /** Same path as `handle`, exposed awaited for deterministic tests. */
  async handleAsync(
    agentName: string,
    kind: ChannelKind,
    message: InboundMessage,
  ): Promise<void> {
    const chatId = String(message.externalChatId ?? "").trim();
    if (!chatId) return;

    const records = await readChannelRecords(this.dataDir, agentName);
    const record = records.find((entry) => entry.kind === kind);
    if (!record) {
      // No projection, or a projection with no credential: nothing is listening
      // for this Agent and inventing pairing state would lie about it.
      this.log(`inbound ignored: no channel "${kind}" for agent "${agentName}"`);
      return;
    }

    const state = await this.pairing.stateOf(agentName, kind);

    if (state?.externalChatId !== null && state?.externalChatId !== undefined) {
      if (state.externalChatId !== chatId) {
        // Never steal: the binding is the owner's fact, not the sender's.
        this.log(
          `inbound ignored: channel "${kind}" of agent "${agentName}" already bound to another chat`,
        );
        return;
      }
      this.queue(agentName, kind, chatId, message);
      return;
    }

    // Unbound: the pairing machine decides (auto-pair inside the projected
    // window, code outside it). Both outcomes are its answers, not ours.
    try {
      const result = await this.pairing.requestPairing(agentName, kind, chatId);
      if (result.autoPaired) {
        this.log(`auto-paired channel "${kind}" of agent "${agentName}" to chat ${chatId}`);
        this.queue(agentName, kind, chatId, message);
        return;
      }
      if (result.code) {
        await this.enqueue({
          agentName,
          kind,
          chatId,
          text: pairingCodeReplyText(result.code),
        });
        this.log(
          `pairing code issued for channel "${kind}" of agent "${agentName}" chat ${chatId}`,
        );
      }
    } catch (error) {
      if (error instanceof PairingError) {
        // Limit reached, channel removed mid-flight, or a binding that appeared
        // concurrently: an unknown sender is refused without a code (§2.1), and
        // the refusal is a log line, never an Agent turn.
        this.log(`pairing refused for chat ${chatId}: ${error.code}`);
        return;
      }
      throw error;
    }
  }

  /** Messages waiting behind a live turn for one `(agent, kind)`. */
  queueDepth(agentName: string, kind: ChannelKind): number {
    return this.queues.get(queueKey(agentName, kind))?.length ?? 0;
  }

  /** Resolves when every queue and drain has settled (test seam, no sleeps). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }

  // --- internals -------------------------------------------------------------

  private queue(
    agentName: string,
    kind: ChannelKind,
    chatId: string,
    message: InboundMessage,
  ): void {
    const key = queueKey(agentName, kind);
    const queue = this.queues.get(key) ?? [];
    if (queue.length >= INBOUND_QUEUE_DEPTH) {
      this.log(
        `inbound queue full agent=${agentName} kind=${kind}: dropping message ${message.messageId}`,
      );
      return;
    }
    queue.push({
      message,
      sessionKey: this.sessionKeyFor(agentName, kind, chatId),
    });
    this.queues.set(key, queue);
    this.drain(key, agentName, kind, chatId);
  }

  /** One drain per key, chained so turns for an Agent never overlap. */
  private drain(key: string, agentName: string, kind: ChannelKind, chatId: string): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        for (;;) {
          const queue = this.queues.get(key);
          if (!queue || queue.length === 0) return;
          const item = queue.shift() as QueuedInbound;
          await this.runTurn(agentName, kind, chatId, item);
        }
      });
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
  }

  private async runTurn(
    agentName: string,
    kind: ChannelKind,
    chatId: string,
    item: QueuedInbound,
  ): Promise<void> {
    const runner = await this.resolveRunner(agentName);
    if (!runner) {
      this.log(`inbound dropped: runner unavailable for agent "${agentName}"`);
      return;
    }

    const turnId = this.newTurnId();
    const handle = this.turns.startTurn({
      agentName,
      turnId,
      // El id de transporte del chat es la clave de idempotencia: un reenvío del
      // mismo mensaje (long polling at-least-once) no genera un segundo turno.
      idempotencyKey: `channel:${kind}:${chatId}:${item.message.messageId}`,
      correlationId: turnId,
      sessionKey: item.sessionKey,
      message: item.message.text,
      runnerPort: runner.port,
      eventProfile: "basic",
      // Este es el hecho que hace que la respuesta vuelva por el outbox.
      origin: { kind: "channel", channelKind: kind, chatId },
    });
    await handle.completion;
  }
}

function queueKey(agentName: string, kind: ChannelKind): string {
  return `${agentName}:${kind}`;
}
