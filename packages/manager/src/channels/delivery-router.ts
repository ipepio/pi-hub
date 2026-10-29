import { CHANNEL_KINDS, type ChannelKind } from "@pihub/channels";
import type { CompletedTurn } from "../agenda/turn-execution.ts";
import { PairingMachine } from "./pairing.ts";
import type { ChannelExchangeLog } from "./exchange-log.ts";
import { readChannelRecords } from "./store.ts";

/**
 * Delivery-by-origin (design §1.4, tasks c-I5) — the single place that answers
 * «does this message leave pihub, and where?».
 *
 * The table, as the spec freezes it:
 *
 * | origin                | outbox push             | mirror (`channel_exchanges`) |
 * |-----------------------|-------------------------|------------------------------|
 * | `human` (web)         | NEVER                   | NEVER — D owns the transcript |
 * | `channel` (telegram)  | always → bound chat     | mirrored                     |
 * | `initiative`          | only if a channel bound | mirrored with the delivery   |
 *
 * Two rules this module owns and no other does:
 *
 * 1. **The destination is the BINDING, never the message.** A channel turn
 *    carries the chat it came from, but the address we deliver to is the one the
 *    owner bound. If they diverge (a chat was unbound and rebound mid-turn), the
 *    binding wins: the reply lands where the owner pointed the channel, and a
 *    message that is no longer bound lands nowhere.
 * 2. **Every channel delivery is an outbox row.** Nothing here calls a transport,
 *    so retry/backoff/idempotency keeps one owner (`channels/outbox.ts`) and a
 *    teardown can mark rows `dead` without this router noticing.
 * 3. **The attribution is the turn's, not the current selection's** (T5b/2). The
 *    mirrored row carries `turn.sessionKey` — the key the turn actually ran
 *    in — and `null` when a delivery has no turn behind it. Re-reading the
 *    Agent's selected session here would attribute the past with today's
 *    pointer, which is exactly the mistake the feed must not allow.
 *
 * `initiative` without a bound channel is deliberately NOT mirrored: the mirror
 * exists so the Dashboard can show exchanges that happened *on a channel*. An
 * agenda turn that never reached one is already visible through the existing
 * autonomy/transcript surfaces, and inventing a mirror row for it would claim a
 * surface that does not exist.
 */

export interface EnqueueOutboxInput {
  agentName: string;
  kind: ChannelKind;
  /** External chat id of the BOUND chat. */
  target: string;
  /** Serialized envelope — the outbox contract (`payload.text`). */
  payload: string;
}

export type EnqueueOutboxFn = (input: EnqueueOutboxInput) => void | Promise<void>;

export interface DeliveryRouterDeps {
  dataDir: string;
  pairing: PairingMachine;
  /** The outbox: this is the only enqueue door a channel reply uses. */
  enqueue: EnqueueOutboxFn;
  exchanges: ChannelExchangeLog;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ProactiveEnqueueInput {
  agentName: string;
  text: string;
  /**
   * Cursor anchor for the mirror. Callers that have a real turn pass its id, so
   * a replayed delivery cannot append a second row (`turn_id` is UNIQUE); the
   * id is generated only when the message has no turn behind it.
   */
  turnId?: string;
  /** Kind to use when the Agent has several bound channels. Default: first bound. */
  kind?: ChannelKind;
}

export class ChannelDeliveryRouter {
  private readonly dataDir: string;
  private readonly pairing: PairingMachine;
  private readonly enqueue: EnqueueOutboxFn;
  private readonly exchanges: ChannelExchangeLog;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(deps: DeliveryRouterDeps) {
    // Constructor parameter properties are avoided on purpose: `node --test`
    // strips types without transpiling, and they are unsupported there.
    this.dataDir = deps.dataDir;
    this.pairing = deps.pairing;
    this.enqueue = deps.enqueue;
    this.exchanges = deps.exchanges;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(`[channels] ${line}`));
  }

  /**
   * `TurnExecution.onTurnCompleted` face: fire-and-forget and silent about its
   * own failures — a broken delivery path must never turn a finished Agent
   * turn into a failed one.
   */
  handle(turn: CompletedTurn): void {
    void this.onTurnCompletedAsync(turn).catch((error) => {
      this.log(`delivery failed for turn ${turn.turnId}: ${String(error)}`);
    });
  }

  /** Same path, awaited: the seam the tests and any caller that wants backpressure use. */
  async onTurnCompletedAsync(turn: CompletedTurn): Promise<void> {
    // Un turno web ya está en el transcript autoritativo del Dashboard: ni se
    // re-entrega por canal (sería la segunda copia del mismo hecho) ni se
    // refleja. Es la fila `human` de la tabla de design §1.4.
    if (turn.origin.kind === "human") return;
    if (turn.finalEvent !== "turn-complete") return;
    const text = turn.replyText.trim();
    if (!text) return;

    if (turn.origin.kind === "channel") {
      const target = await this.boundChatOf(turn.agentName, turn.origin.channelKind);
      if (!target) {
        this.log(
          `channel reply dropped: agent "${turn.agentName}" has no bound "${turn.origin.channelKind}" chat (turn ${turn.turnId})`,
        );
        return;
      }
      await this.deliver({
        agentName: turn.agentName,
        kind: turn.origin.channelKind,
        target,
        text: turn.replyText,
        mirror: {
          origin: "telegram",
          turnId: turn.turnId,
          sessionKey: turn.sessionKey ?? null,
          userText: turn.userText,
          replyText: turn.replyText,
        },
      });
      return;
    }

    // `initiative`: proactive. Only delivered when a channel is actually bound.
    const bound = await this.firstBoundKind(turn.agentName, turn.origin.initiativeId);
    if (!bound) return;
    await this.deliver({
      agentName: turn.agentName,
      kind: bound.kind,
      target: bound.chatId,
      text: turn.replyText,
      mirror: {
        origin: "proactive",
        turnId: turn.turnId,
        sessionKey: turn.sessionKey ?? null,
        userText: turn.userText,
        replyText: turn.replyText,
      },
    });
  }

  /**
   * Internal proactive door (tasks item 6): an agenda/autonomy message that the
   * Dashboard did not ask for reaches the bound chat through the SAME outbox,
   * and is mirrored so the web transcript shows what the Agent said on its own.
   * Returns `false` when there is no bound channel — the caller keeps its own
   * web-side delivery and nothing is invented here.
   */
  async enqueueProactive(input: ProactiveEnqueueInput): Promise<boolean> {
    const text = input.text.trim();
    if (!text) return false;
    const kind = input.kind ?? (await this.firstBoundKind(input.agentName))?.kind;
    if (!kind) return false;
    const target = await this.boundChatOf(input.agentName, kind);
    if (!target) return false;

    await this.deliver({
      agentName: input.agentName,
      kind,
      target,
      text,
      mirror: {
        origin: "proactive",
        // El cursor del mirror es el turno; sin uno real se usa el id de la
        // entrega, que es estable para esta llamada. Sin turno tampoco hay
        // sesión que atribuir: `null`, nunca una adivinada.
        turnId: input.turnId ?? `proactive:${input.agentName}:${kind}:${target}`,
        sessionKey: null,
        userText: "",
        replyText: text,
      },
    });
    return true;
  }

  // --- internals ---------------------------------------------------------------

  private async deliver(input: {
    agentName: string;
    kind: ChannelKind;
        target: string;
        text: string;
        mirror: {
          origin: "telegram" | "proactive";
          turnId: string;
          /**
           * `sessionKey` del turno REAL que produjo el intercambio, o `null`
           * cuando la entrega no viene de un turno (aviso HITL, proactive
           * interno): ahí no hay identidad que atribuir y el espejo no la inventa.
           */
          sessionKey: string | null;
          userText: string;
          replyText: string;
        };
      }): Promise<void> {
    // El espejo se escribe ANTES de encolar: si el enqueue falla, el intercambio
    // no ocurrió (y el outbox es el único que reintenta). La fila es idempotente
    // por `turn_id`, así que un reenvío del mismo turno no duplica nada.
    this.exchanges.append({
      agentName: input.agentName,
      turnId: input.mirror.turnId,
      origin: input.mirror.origin,
      chatId: input.target,
      sessionKey: input.mirror.sessionKey,
      userText: input.mirror.userText,
      replyText: input.mirror.replyText,
      now: this.now(),
    });
    await this.enqueue({
      agentName: input.agentName,
      kind: input.kind,
      target: input.target,
      payload: JSON.stringify({ text: input.text }),
    });
    this.log(
      `queued ${input.mirror.origin} delivery for agent "${input.agentName}" → ${input.kind}:${input.target}`,
    );
  }

      /**
       * The chat the owner bound for this channel — the only valid destination.
       *
       * Public because HITL delivery (`primary-channel/human-request-delivery.ts`,
       * fix H3) has to answer «is there anywhere to send this?» before it writes
       * its durable reservation, and the answer must come from the same binding
       * rule every other delivery uses — never from an `agent.json` field.
       * Active pairing state AND a projected record: a channel the Dashboard
       * revoked is not a destination even if a stale binding file survived it.
       */
      async boundChatOf(agentName: string, kind: ChannelKind): Promise<string | null> {
    const state = await this.pairing.stateOf(agentName, kind);
    if (!state || state.state !== "active" || !state.externalChatId) return null;
    const records = await readChannelRecords(this.dataDir, agentName);
    if (!records.some((record) => record.kind === kind)) return null;
    return state.externalChatId;
  }

  /** First bound channel of the Agent, in the closed kind list's order. */
  private async firstBoundKind(
    agentName: string,
    hint?: string,
  ): Promise<{ kind: ChannelKind; chatId: string } | undefined> {
    void hint;
    for (const kind of CHANNEL_KINDS) {
      const chatId = await this.boundChatOf(agentName, kind);
      if (chatId) return { kind, chatId };
    }
    return undefined;
  }
}
