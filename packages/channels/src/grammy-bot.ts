import { Bot } from "grammy";
import type {
  TelegramBotLike,
  TelegramCallbackContext,
  TelegramInboundContext,
  TelegramSendOptions,
} from "./telegram.js";
    
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
    on(
      event: "message:text" | "callback_query:data",
      handler:
        | ((context: TelegramInboundContext) => unknown)
        | ((context: TelegramCallbackContext) => unknown),
    ) {
      if (event === "callback_query:data") {
        bot.on("callback_query:data", (ctx) => {
          const query = ctx.callbackQuery;
          // `message` is absent when the pressed message was deleted while the
          // bot was offline; there is no chat to reply into, so drop it here
          // rather than hand the adapter a context it can only refuse.
          const message = query.message;
          const chatId = message?.chat?.id;
          if (chatId === undefined || !message || typeof query.data !== "string") {
            return;
          }
          const context: TelegramCallbackContext = {
            chatId: String(chatId),
            messageId: String(message.message_id),
            id: String(query.id),
            data: query.data,
          };
          const senderName = query.from?.first_name ?? query.from?.username;
          if (senderName !== undefined) context.senderName = senderName;
          (handler as (context: TelegramCallbackContext) => unknown)(context);
        });
        return;
      }
      // `on` is filter-typed upstream; this adapter consumes exactly two filters.
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
        (handler as (context: TelegramInboundContext) => unknown)(context);
      });
    },
    api: {
      getMe: async () => await bot.api.getMe(),
      sendMessage: async (
        chatId: string,
        text: string,
        options?: TelegramSendOptions,
      ) => {
        // Two call shapes on purpose: with no keyboard the transport keeps
        // receiving exactly the two arguments it always received, so "no
        // markup" is the absence of an argument and never an empty object.
        const sent =
          options === undefined
            ? await bot.api.sendMessage(chatId, text)
            : await bot.api.sendMessage(chatId, text, options);
        return { messageId: String(sent.message_id) };
      },
      // No `chat_id`: the query id alone identifies the press. grammy wants the
      // whole options object omitted (not `{text: undefined}`) when there is no
      // toast, so the two cases stay visibly separate.
      answerCallbackQuery: async (id: string, text?: string) => {
        await bot.api.answerCallbackQuery(id, text ? { text } : undefined);
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
