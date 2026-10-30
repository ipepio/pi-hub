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

/**
 * One button of an inline keyboard: a label the human reads and an opaque
 * `data` the transport echoes back verbatim when it is pressed.
 *
 * `data` is transport payload, not prose: it travels in the transport's own
 * `callback_data` field, which Telegram caps at 64 UTF-8 bytes and rejects
 * (rather than truncates) past that. The cap is validated at the transport seam
 * — the shape here stays transport-neutral, the limit does not.
 */
export interface InlineKeyboardButton {
  text: string;
  data: string;
}

/**
 * One inbound message, already normalized out of the transport's own shape.
 *
 * A button press is the same shape as a text message plus `callback`: a press
 * carries no prose (`text` is `""`, never absent) and `callback.data` is exactly
 * what the sender keyboard's button was created with. Consumers that only care
 * about prose keep matching on `text`; consumers that only care about presses
 * match on `callback`. Existing producers that never set it stay valid.
 */
export interface InboundMessage {
  /** External chat id as a string: the wire contract never carries numbers. */
  externalChatId: string;
  text: string;
  messageId: string;
  senderName?: string;
  /** Present only when the inbound event was an inline-keyboard press. */
  callback?: { id: string; data: string };
}

/**
 * Transport failure in a form the Manager can decide on without parsing strings.
 *
 * `invalid_keyboard` is the one code that is NOT a transport failure: it means the
 * caller handed `send` a keyboard the transport can never accept (empty
 * `callback_data`, more than 64 bytes, a label-less button). It is detected
 * before any network call, so retrying it is pointless by construction — a
 * caller must treat it as terminal and fix its own payload.
 */
export type ChannelAdapterErrorCode =
  | "invalid_token"
  | "invalid_chat"
  | "invalid_keyboard"
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
  /**
   * Deliver one message. `keyboard` is additive: rows of buttons that ride on the
   * FIRST chunk of the text only (a keyboard under a continuation chunk would ask
   * the same question twice). Omitting it, or passing `[]`, must reach the
   * transport as a plain message — no empty markup is ever sent.
   */
  send(input: {
    chatId: string;
    text: string;
    keyboard?: InlineKeyboardButton[][];
  }): Promise<{ messageId: string }>;
  /**
   * Acknowledge a button press (`InboundMessage.callback.id`) so the sender's
   * client stops showing a spinner. Optional so adapters and fakes that were
   * written before keyboards existed stay source-compatible; `text` is the short
   * toast the transport may show instead of the message's own answer.
   */
  answerCallback?(callbackQueryId: string, text?: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * How the Manager obtains an adapter for a kind. `undefined` means "this
 * build has no transport for that kind" — the caller rejects it as a bad
 * request rather than pretending to be connected.
 */
export type ChannelAdapterFactory = (kind: ChannelKind) => ChannelAdapter | undefined;
