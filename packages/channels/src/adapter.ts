/**
 * The ChannelAdapter seam (design §1.4 `pihub-manager-channels`).
 *
 * This is the whole contract between the Manager's channel machinery and a
 * transport. It exists so the Manager can own bot lifecycle — pairing, outbox,
 * restart policy — while knowing nothing about grammy, long polling or the
 * Telegram error taxonomy. Adding kind #2 is a new adapter file plus one
 * literal in `CHANNEL_KINDS`; no Manager logic changes.
 *
 * Facts a caller must rely on:
 * - `start` resolves only after the transport has verified the token; an
 *   invalid token is a typed `ChannelAdapterError` with `code: "invalid_token"`
 *   and never reaches the polling loop. It does NOT wait for the loop to end —
 *   a transport whose loop is running is already usable for `send`, and a loop
 *   that dies later is reported through the adapter's own error sink.
 * - `onInbound` is fire-and-forget: the adapter never awaits it, so a slow
 *   agent turn cannot stall the transport.
 * - `send` is at-least-once from the caller's point of view and never retries
 *   by itself — retry policy belongs to the outbox alone (one owner per
 *   decision).
 * - `stop` is idempotent, silent (no farewell message) and safe to call while
 *   a `send` is in flight.
 */
export type ChannelKind = "telegram";

/** Closed list of supported kinds; extensibility = add a literal + an adapter. */
export const CHANNEL_KINDS: readonly ChannelKind[] = ["telegram"];

export function isChannelKind(value: unknown): value is ChannelKind {
  return (
    typeof value === "string" &&
    CHANNEL_KINDS.includes(value as ChannelKind)
  );
}

/** One inbound message, already normalized out of the transport's own shape. */
export interface InboundMessage {
  /** External chat id as a string: the wire contract never carries numbers. */
  externalChatId: string;
  text: string;
  messageId: string;
  senderName?: string;
}

export type ChannelAdapterErrorCode =
  | "invalid_token"
  | "invalid_chat"
  | "rate_limited"
  | "unavailable";

/**
 * Transport failure in a form the Manager can decide on without parsing
 * strings. Messages are built by the adapters and MUST NOT contain the token
 * (secret discipline, mirrors `supervisor.statusOf` redacting `telegramToken`).
 */
export class ChannelAdapterError extends Error {
  readonly code: ChannelAdapterErrorCode;
  /** Only for `rate_limited`: how long the transport asked us to wait. */
  readonly retryAfterMs?: number;

  constructor(input: {
    code: ChannelAdapterErrorCode;
    message: string;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "ChannelAdapterError";
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(input: {
    token: string;
    onInbound: (message: InboundMessage) => void;
  }): Promise<void>;
  send(input: { chatId: string; text: string }): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}

/**
 * How the Manager obtains an adapter for a kind. `undefined` means "this
 * build has no transport for that kind" — the caller rejects it as a bad
 * request rather than pretending to be connected.
 */
export type ChannelAdapterFactory = (kind: ChannelKind) => ChannelAdapter | undefined;
