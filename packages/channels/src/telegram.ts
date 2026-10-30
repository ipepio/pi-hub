import {
  ChannelAdapterError,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelKind,
  type InboundMessage,
  type InlineKeyboardButton,
} from "./adapter.js";
import { createGrammyBot } from "./grammy-bot.js";

/** Telegram hard limit for a text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Telegram hard limit for `callback_data`, in UTF-8 bytes (`1-64 bytes`). It is a
 * rejection, not a truncation: a longer value makes the WHOLE send fail, so it is
 * validated here before any network call. Deliberately bytes and not characters —
 * an emoji is four of them.
 */
export const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

/** Transport shape the adapter needs; grammy is hidden behind exactly this. */
export interface TelegramInboundContext {
  chatId: string;
  messageId: string;
  text: string;
  senderName?: string;
}

/**
 * A pressed inline-keyboard button, flattened to the transport-neutral fields the
 * seam needs. `chatId`/`messageId` identify the message the keyboard sat under
 * (that is the reply thread), `id` is the query to acknowledge, `data` is the
 * button's `callback_data` verbatim.
 */
export interface TelegramCallbackContext {
  chatId: string;
  messageId: string;
  id: string;
  data: string;
  senderName?: string;
}

/** The wire shape of an inline keyboard, i.e. `reply_markup` minus the wrapper. */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Third argument forwarded to `api.sendMessage`; only a keyboard for now. */
export interface TelegramSendOptions {
  reply_markup: TelegramInlineKeyboardMarkup;
}

export interface TelegramBotLike {
  on(
    event: "message:text",
    handler: (context: TelegramInboundContext) => unknown,
  ): void;
  /**
   * Button presses are a SECOND filter, not a replacement: an adapter that only
   * listened to text would leave every keyboard it sent permanently silent.
   */
  on(
    event: "callback_query:data",
    handler: (context: TelegramCallbackContext) => unknown,
  ): void;
  api: {
    getMe(): Promise<unknown>;
    sendMessage(
      chatId: string,
      text: string,
      options?: TelegramSendOptions,
    ): Promise<{ messageId: string }>;
    /**
     * Acknowledge a button press. Telegram takes no `chat_id` here — the query id
     * already identifies it — and the optional `text` is a short toast.
     */
    answerCallbackQuery(id: string, text?: string): Promise<void>;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Injected in tests so the whole seam runs with zero network. */
export type TelegramBotFactory = (token: string) => TelegramBotLike;

export interface TelegramChannelAdapterOptions {
  botFactory?: TelegramBotFactory;
  textLimit?: number;
  /**
   * Sink for what happens AFTER `start` resolved — i.e. the polling loop dying on
   * its own (409 conflict, a revoked token mid-flight). `start` can no longer
   * throw it at the caller because the loop is not awaited (see `start` below),
   * and a failure nobody reports is a channel that lies about being connected.
   * Default: one `console.error` line, token-redacted.
   */
  log?: (line: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function statusOf(error: unknown): number | undefined {
  const record = asRecord(error);
  const candidate = record.error_code ?? record.status;
  return typeof candidate === "number" ? candidate : undefined;
}

function descriptionOf(error: unknown): string {
  const record = asRecord(error);
  const description = typeof record.description === "string" ? record.description : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${message} ${description}`.trim();
}

function retryAfterMsOf(error: unknown): number | undefined {
  const parameters = asRecord(asRecord(error).parameters);
  const seconds = parameters.retry_after;
  return typeof seconds === "number" ? seconds * 1000 : undefined;
}

/**
 * Single place that turns a Telegram failure into the taxonomy the outbox
 * (slice (c) part 2) can act on: `invalid_chat` is terminal, `rate_limited`
 * and `unavailable` are retryable. Nothing here retries.
 */
export function classifyTelegramSendError(error: unknown): ChannelAdapterError {
  const status = statusOf(error);
  const description = descriptionOf(error);

  if (status === 429) {
    return new ChannelAdapterError({
      code: "rate_limited",
      message: `telegram rate limited: ${description}`,
      retryAfterMs: retryAfterMsOf(error),
    });
  }
  if (
    /chat.{0,24}(not found|was deleted|unauthorized)|chat_id_invalid|unauthorized.{0,24}chat/i.test(
      description,
    )
  ) {
    return new ChannelAdapterError({
      code: "invalid_chat",
      message: `telegram rejected the chat id: ${description}`,
    });
  }
  return new ChannelAdapterError({
    code: "unavailable",
    message: `telegram transport unavailable: ${description}`,
  });
}

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [""];
}

function invalidKeyboard(message: string): ChannelAdapterError {
  return new ChannelAdapterError({
    code: "invalid_keyboard",
    message: `invalid inline keyboard: ${message}`,
  });
}

/**
 * Turns the seam's rows-of-buttons into the wire `reply_markup`, and refuses
 * anything Telegram would reject.
 *
 * Everything here is a caller bug, detected before the first network call: a
 * keyboard with a 65-byte `callback_data` fails the whole send, so finding out
 * from Telegram would cost a round trip and still lose the message. Messages name
 * the offending position and the size, never the payload — button data is part of
 * the Agent's output and must not be echoed into logs or errors.
 */
function inlineKeyboardMarkup(
  keyboard: InlineKeyboardButton[][],
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: keyboard.map((row, rowIndex) => {
      if (!Array.isArray(row)) {
        throw invalidKeyboard(`row ${rowIndex} is not an array of buttons`);
      }
      return row.map((button, buttonIndex) => {
        const where = `row ${rowIndex} button ${buttonIndex}`;
        const candidate = button as { text?: unknown; data?: unknown } | null | undefined;
        if (typeof candidate?.text !== "string" || candidate.text.length === 0) {
          throw invalidKeyboard(`${where} has no label`);
        }
        if (typeof candidate.data !== "string" || candidate.data.length === 0) {
          throw invalidKeyboard(`${where} has no callback data`);
        }
        const bytes = Buffer.byteLength(candidate.data, "utf8");
        if (bytes > TELEGRAM_CALLBACK_DATA_LIMIT) {
          throw invalidKeyboard(
            `${where} carries ${bytes} bytes of callback data; telegram allows at most ${TELEGRAM_CALLBACK_DATA_LIMIT}`,
          );
        }
        return { text: candidate.text, callback_data: candidate.data };
      });
    }),
  };
}

/** Error text is logged and mirrored to the Dashboard: it must never carry the token. */
function redact(message: string, token: string): string {
  const scrubbed = token.length > 0 ? message.split(token).join("[redacted]") : message;
  return scrubbed.slice(0, 200);
}

export function createTelegramChannelAdapter(
  options: TelegramChannelAdapterOptions = {},
): ChannelAdapter {
  const botFactory = options.botFactory ?? createGrammyBot;
  const textLimit = options.textLimit ?? TELEGRAM_TEXT_LIMIT;
  const log = options.log ?? ((line: string) => console.error(`[telegram] ${line}`));

    let bot: TelegramBotLike | undefined;

    /**
     * The one delivery path both inbound shapes share: fire-and-forget, and a
     * consumer that throws or rejects must never surface as a transport failure.
     */
    function dispatch(
      onInbound: (message: InboundMessage) => void,
      message: InboundMessage,
    ): void {
      // Fire-and-forget on purpose: a slow agent turn must not stall polling, and
      // a throwing consumer must never surface as a transport failure.
      try {
        const result: unknown = onInbound(message);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          (result as PromiseLike<unknown>).then(
            () => {},
            () => {},
          );
        }
      } catch {
        // swallowed by design
      }
    }

    function deliver(
      onInbound: (message: InboundMessage) => void,
      context: TelegramInboundContext,
    ): void {
      const message: InboundMessage = {
        externalChatId: context.chatId,
        text: context.text,
        messageId: context.messageId,
      };
      if (context.senderName !== undefined) message.senderName = context.senderName;
      dispatch(onInbound, message);
    }

    /**
     * A button press becomes the same `InboundMessage` plus `callback`, so the
     * Manager routes a press through exactly the one inbound path it already has.
     *
     * Fail closed on an incomplete update: Telegram keeps delivering presses whose
     * message was deleted while the bot was offline, and there is no chat to answer
     * into. Dropping it loudly beats throwing inside the poller, which would take
     * the whole transport down over one stale button.
     */
    function deliverCallback(
      onInbound: (message: InboundMessage) => void,
      context: TelegramCallbackContext,
    ): void {
      if (
        typeof context.chatId !== "string" ||
        context.chatId.length === 0 ||
        typeof context.messageId !== "string" ||
        context.messageId.length === 0 ||
        typeof context.id !== "string" ||
        context.id.length === 0 ||
        typeof context.data !== "string"
      ) {
        log("callback_query dropped: the pressed message is gone");
        return;
      }
      const message: InboundMessage = {
        externalChatId: context.chatId,
        // A press carries no prose. Empty string, never a missing field: consumers
        // that only match `callback` should not have to guard `text`.
        text: "",
        messageId: context.messageId,
        callback: { id: context.id, data: context.data },
      };
      if (context.senderName !== undefined) message.senderName = context.senderName;
      dispatch(onInbound, message);
    }

  return {
    kind: "telegram",

    async start({ token, onInbound }) {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new ChannelAdapterError({
          code: "invalid_token",
          message: "a telegram bot token is required to start the adapter",
        });
      }
      if (bot) await this.stop();

      const next = botFactory(trimmed);
      try {
        // Verified before the polling loop starts, so a revoked token never
        // spawns a bot that silently retries against the API.
        await next.api.getMe();
      } catch (error) {
        throw new ChannelAdapterError({
          code: "invalid_token",
          message: redact(
            `telegram token rejected: ${error instanceof Error ? error.message : String(error)}`,
            trimmed,
          ),
        });
      }

      next.on("message:text", (context: TelegramInboundContext) =>
        deliver(onInbound, context),
      );
      next.on("callback_query:data", (context: TelegramCallbackContext) =>
        deliverCallback(onInbound, context),
      );

      // Plaintext token custody: referenced only while the bot is alive, in
      // memory, never written to disk.
      //
      // `bot` is assigned BEFORE the loop is fired, and the loop is NOT
      // awaited. grammy's `bot.start()` is the long-poll loop itself: its
      // promise resolves when `bot.stop()` is called, so `await next.start()`
      // hung the whole Manager for the life of the bot — `replaceAll` never
      // converged, `send` stayed `unavailable`, and `stop` could not reach a
      // bot that had not been assigned yet. "The handlers are registered and
      // the loop is running" is all a start can promise synchronously; what
      // happens afterwards is reported through `log`, and a loop that dies
      // takes the transport with it (the outbox retries).
      bot = next;
      void next.start().catch((error: unknown) => {
        const failure = new ChannelAdapterError({
          code: "unavailable",
          message: redact(
            `telegram polling stopped: ${
              error instanceof Error ? error.message : String(error)
            }`,
            trimmed,
          ),
        });
        // Only this bot's loop may retire this bot: a replacement already
        // started by a newer projection owns the transport from now on.
        if (bot === next) bot = undefined;
        log(`${failure.code}: ${failure.message}`);
      });
    },

    async send({ chatId, text, keyboard }) {
      // Caller bugs fail before any network call: a keyboard Telegram would
      // reject makes the whole message undeliverable, so paying a round trip
      // to learn it (and then retrying the same invalid payload) is waste.
      const keyboardMarkup =
        keyboard && keyboard.length > 0
          ? { reply_markup: inlineKeyboardMarkup(keyboard) }
          : undefined;
      if (!bot) {
        throw new ChannelAdapterError({
          code: "unavailable",
          message: "the telegram adapter is not started",
        });
      }
      const active = bot;
      let firstMessageId = "";
      let index = 0;
      for (const chunk of chunkText(text, textLimit)) {
        // Buttons ride on the message that asks the question, never on its
        // tail: a keyboard under a continuation chunk asks it twice.
        const options = index === 0 ? keyboardMarkup : undefined;
        index += 1;
        try {
          const sent =
            options === undefined
              ? await active.api.sendMessage(chatId, chunk)
              : await active.api.sendMessage(chatId, chunk, options);
          if (!firstMessageId) firstMessageId = sent.messageId;
        } catch (error) {
          // A failure after the first chunk means partial delivery: the outbox
          // owns that decision, the adapter only reports what happened.
          throw classifyTelegramSendError(error);
        }
      }
      return { messageId: firstMessageId };
    },

    async answerCallback(callbackQueryId, text) {
      if (!bot) {
        throw new ChannelAdapterError({
          code: "unavailable",
          message: "the telegram adapter is not started",
        });
      }
      const active = bot;
      try {
        await active.api.answerCallbackQuery(callbackQueryId, text);
      } catch (error) {
        // Best-effort by design: the press already happened, the turn is
        // already running, and a stale ack only costs a spinner. Report it
        // through the taxonomy, never throw it at the caller's inbound path.
        const failure = classifyTelegramSendError(error);
        log(`${failure.code}: callback answer failed: ${failure.message}`);
      }
    },

    async stop() {
      const active = bot;
      if (!active) return;
      bot = undefined;
      // Silent teardown: no goodbye message, and safe while a send is in flight.
      await active.stop();
    },
  };
}

/**
 * Adapter-per-kind map the Manager builds its registry from. A new kind is one
 * literal in `CHANNEL_KINDS` plus one line here.
 */
export function createDefaultChannelAdapterFactory(
  options: TelegramChannelAdapterOptions = {},
): ChannelAdapterFactory {
  return (kind: ChannelKind) =>
    kind === "telegram" ? createTelegramChannelAdapter(options) : undefined;
}
