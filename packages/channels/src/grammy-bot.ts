import { Bot } from "grammy";
import type { TelegramBotLike, TelegramInboundContext } from "./telegram.js";
    
/**
 * One-line, secret-free description of a grammy error.
 *
 * grammy's default `bot.catch` handler `console.error`s the whole `BotError`,
 * which carries the update it was processing and, for a failed API call, the
 * request payload — i.e. the reply text the Agent just wrote. That text must
 * never reach the Manager's stdout, and neither must the bot token, which
 * Telegram echoes back inside some "Invalid token" descriptions.
 */
export function redactTelegramError(error: unknown, token: string): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "unknown error");
  const withoutToken = token ? raw.split(token).join("[redacted]") : raw;
  // The transport never has more than a reason to report: no payload, no stack.
  return withoutToken.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * The only file in this package that imports grammy. It normalizes Telegram's
 * own shapes (numeric ids, `first_name`) into the transport-neutral context the
 * adapter seam consumes, so long polling, `ApiResponse` typing and any future
 * grammy version bump stay inside these ~50 lines.
 */
export function createGrammyBot(token: string): TelegramBotLike {
  const bot = new Bot(token);
    
  // Redacting error sink (see `redactTelegramError`): an unhandled handler or
  // API error is reported as one safe line. Delivery retry policy is not here —
  // it belongs to the Manager's outbox alone.
  bot.catch((error) => {
    console.error(`[telegram] ${redactTelegramError(error.error, token)}`);
  });

  return {
    on(event, handler) {
      // `on` is filter-typed upstream; this adapter consumes exactly one filter.
      bot.on(event, (ctx) => {
        const chatId = ctx.chat?.id;
        const message = ctx.message;
        if (chatId === undefined || !message || typeof message.text !== "string") {
          return;
        }
        const context: TelegramInboundContext = {
          chatId: String(chatId),
          messageId: String(message.message_id),
          text: message.text,
        };
        const senderName = ctx.from?.first_name ?? ctx.from?.username;
        if (senderName !== undefined) context.senderName = senderName;
        handler(context);
      });
    },
    api: {
      getMe: async () => await bot.api.getMe(),
      sendMessage: async (chatId, text) => {
        const sent = await bot.api.sendMessage(chatId, text);
        return { messageId: String(sent.message_id) };
      },
    },
    // THE SEMANTICS THE CALLER HAS TO RESPECT: grammy's `start()` IS the
    // long-poll loop — its promise settles only when `stop()` is called (or
    // when the loop dies). Nothing may `await` it and still answer; the adapter
    // fires it and reports what happens afterwards (`telegram.ts`).
    start: () => bot.start(),
    stop: () => bot.stop(),
  };
}
