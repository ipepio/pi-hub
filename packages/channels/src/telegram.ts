import {
  ChannelAdapterError,
  type ChannelAdapter,
  type ChannelAdapterFactory,
  type ChannelKind,
  type InboundMessage,
} from "./adapter.js";
import { createGrammyBot } from "./grammy-bot.js";

/** Telegram hard limit for a text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Transport shape the adapter needs; grammy is hidden behind exactly this. */
export interface TelegramInboundContext {
  chatId: string;
  messageId: string;
  text: string;
  senderName?: string;
}

export interface TelegramBotLike {
  on(
    event: "message:text",
    handler: (context: TelegramInboundContext) => unknown,
  ): void;
  api: {
    getMe(): Promise<unknown>;
    sendMessage(chatId: string, text: string): Promise<{ messageId: string }>;
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

    async send({ chatId, text }) {
      if (!bot) {
        throw new ChannelAdapterError({
          code: "unavailable",
          message: "the telegram adapter is not started",
        });
      }
      const active = bot;
      let firstMessageId = "";
      for (const chunk of chunkText(text, textLimit)) {
        try {
          const sent = await active.api.sendMessage(chatId, chunk);
          if (!firstMessageId) firstMessageId = sent.messageId;
        } catch (error) {
          // A failure after the first chunk means partial delivery: the outbox
          // owns that decision, the adapter only reports what happened.
          throw classifyTelegramSendError(error);
        }
      }
      return { messageId: firstMessageId };
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
