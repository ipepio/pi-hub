import test from "node:test";
import assert from "node:assert/strict";
import {
  ChannelAdapterError,
  classifyTelegramSendError,
  createTelegramChannelAdapter,
  isChannelKind,
} from "../dist/index.js";
import type {
  TelegramBotLike,
  TelegramInboundContext,
  TelegramCallbackContext,
} from "../dist/index.js";

// ChannelAdapter seam under a fake transport: every assertion here runs with
// zero network and zero grammy instances, which is what makes the pairing and
// outbox work of slice (c) part 2 testable in the same harness.
//
// THE FAKE MUST LIE AS LITTLE AS POSSIBLE (fix round A, C2): grammy's
// `bot.start()` does NOT resolve when polling begins — it resolves when the
// loop ends, i.e. after `bot.stop()`. A fake whose `start()` resolved
// immediately is exactly what let `await next.start()` ship: in production
// `replaceAll` hung forever, `send` was never available and the poller could
// not be stopped. So `start()` here returns a promise that settles ONLY through
// `stop()` (or with the injected `startError`), and `loopState` says which of
// the three the bot is in.

/**
 * One `api.sendMessage` call as the transport saw it. `argc` is the real argument
 * count, so "no options were passed" is asserted at the call site and not only
 * through `options === undefined` (a third explicit `undefined` is a difference
 * the transport can see).
 */
interface SentRecord {
  chatId: string;
  text: string;
  options?: unknown;
  argc: number;
}

interface FakeBot extends TelegramBotLike {
  events: string[];
  inboundHandlers: Array<(ctx: TelegramInboundContext) => unknown>;
  callbackHandlers: Array<(ctx: TelegramCallbackContext) => unknown>;
  sent: SentRecord[];
  answered: Array<{ id: string; text?: string }>;
  answerError: unknown;
  sendOutcomes: Array<{ ok: boolean; error?: unknown }>;
  calls: string[];
  getMeError: unknown;
  startError: unknown;
  stopCount: number;
  /** `polling` = the grammy loop is running and its promise is still pending. */
  loopState: "idle" | "polling" | "stopped" | "failed";
  emit(ctx: TelegramInboundContext): void;
  emitCallback(ctx: TelegramCallbackContext): void;
}

const TOKEN = "123456:AAAA-secret-token-value";

function fakeBot(options: {
  getMeError?: unknown;
  startError?: unknown;
  answerError?: unknown;
  sendOutcomes?: Array<{ ok: boolean; error?: unknown }>;
} = {}): FakeBot {
  const state = {
    calls: [] as string[],
    sent: [] as SentRecord[],
    answered: [] as Array<{ id: string; text?: string }>,
    sendOutcomes: [...(options.sendOutcomes ?? [])],
    stopCount: 0,
    loopState: "idle" as FakeBot["loopState"],
  };
  const handlers: Array<(ctx: TelegramInboundContext) => unknown> = [];
  const callbackHandlers: Array<(ctx: TelegramCallbackContext) => unknown> = [];
  /** Settles the pending loop the way grammy does: from the other side of `stop()`. */
  let settleLoop: ((error?: unknown) => void) | undefined;

  return {
    events: [],
    inboundHandlers: handlers,
    callbackHandlers,
    sent: state.sent,
    answered: state.answered,
    answerError: options.answerError,
    sendOutcomes: state.sendOutcomes,
    calls: state.calls,
    getMeError: options.getMeError,
    startError: options.startError,
    get stopCount() {
      return state.stopCount;
    },
    get loopState() {
      return state.loopState;
    },
    on(event, handler) {
      state.calls.push("on");
      this.events.push(event);
      if (event === "callback_query:data") {
        callbackHandlers.push(handler as (ctx: TelegramCallbackContext) => unknown);
        return;
      }
      handlers.push(handler as (ctx: TelegramInboundContext) => unknown);
    },
    api: {
      getMe: async () => {
        state.calls.push("getMe");
        if (options.getMeError) throw options.getMeError;
        return { id: 1, is_bot: true, username: "pihub_test_bot" };
      },
      // Rest args on purpose: `argc` records whether the adapter really passed
      // the optional third argument, which is what "no keyboard" means on wire.
      sendMessage: async (chatId: string, text: string, ...rest: unknown[]) => {
        state.calls.push("sendMessage");
        state.sent.push({ chatId, text, options: rest[0], argc: rest.length + 2 });
        const outcome = state.sendOutcomes.shift() ?? { ok: true };
        if (!outcome.ok) throw outcome.error;
        return { messageId: `${1000 + state.sent.length}` };
      },
      answerCallbackQuery: async (id: string, text?: string) => {
        state.calls.push("answerCallbackQuery");
        state.answered.push({ id, text });
        if (options.answerError) throw options.answerError;
      },
    },
    start: () => {
      state.calls.push("start");
      // Real grammy semantics: the returned promise stays pending for the
      // whole life of the poller. Nothing may `await` it and still answer.
      return new Promise<void>((resolve, reject) => {
        if (options.startError) {
          state.loopState = "failed";
          reject(options.startError);
          return;
        }
        state.loopState = "polling";
        settleLoop = (error) => {
          settleLoop = undefined;
          state.loopState = error ? "failed" : "stopped";
          if (error) reject(error);
          else resolve();
        };
      });
    },
    stop: async () => {
      state.calls.push("stop");
      state.stopCount += 1;
      // Stopping the bot is what lets `start()` resolve, never the reverse.
      settleLoop?.();
    },
    emit(ctx) {
      for (const handler of handlers) handler(ctx);
    },
    emitCallback(ctx) {
      for (const handler of callbackHandlers) handler(ctx);
    },
  };
}

function adapterWith(bot: FakeBot) {
  return createTelegramChannelAdapter({ botFactory: () => bot });
}

test("isChannelKind accepts the declared kinds only", () => {
  assert.equal(isChannelKind("telegram"), true);
  assert.equal(isChannelKind("discord"), false);
  assert.equal(isChannelKind(undefined), false);
});

test("start verifies the token before polling and registers the inbound handler", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  const seen: unknown[] = [];

  await adapter.start({ token: TOKEN, onInbound: (message) => seen.push(message) });

  assert.equal(adapter.kind, "telegram");
  // getMe first: an invalid token must never reach the long-poll loop.
  assert.deepEqual(bot.calls, ["getMe", "on", "on", "start"]);
  // Deliberate additive pin (T6b/1): the adapter now subscribes to the button
  // presses too, because an inline keyboard that nobody listens to is a dead end.
  assert.deepEqual(bot.events, ["message:text", "callback_query:data"]);
  assert.equal(seen.length, 0);
});

test("start with an empty token is a typed invalid_token error and never touches the transport", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);

  await assert.rejects(
    () => adapter.start({ token: "  ", onInbound: () => {} }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "invalid_token",
  );
  assert.deepEqual(bot.calls, []);
});

test("start surfaces a rejected getMe as typed invalid_token without starting polling", async () => {
  const bot = fakeBot({ getMeError: new Error("401: Unauthorized") });
  const adapter = adapterWith(bot);

  await assert.rejects(
    () => adapter.start({ token: TOKEN, onInbound: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof ChannelAdapterError);
      assert.equal(error.code, "invalid_token");
      // The token must never be echoed back in an error message.
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(bot.calls.includes("start"), false);
});

test("onInbound yields the normalized inbound message", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  const received: Array<Record<string, unknown>> = [];

  await adapter.start({
    token: TOKEN,
    onInbound: (message) => received.push({ ...message }),
  });
  bot.emit({
    chatId: "-100123",
    messageId: "42",
    text: "hola agente",
    senderName: "Pepe",
  });

  assert.deepEqual(received, [
    {
      externalChatId: "-100123",
      text: "hola agente",
      messageId: "42",
      senderName: "Pepe",
    },
  ]);
});

test("onInbound is fire-and-forget: a rejecting handler never reaches the transport", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);

  await adapter.start({
    token: TOKEN,
    onInbound: () => {
      throw new Error("handler blew up");
    },
  });

  assert.doesNotThrow(() =>
    bot.emit({ chatId: "1", messageId: "2", text: "x" }),
  );
});

test("send posts the text and returns the external message id", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

      const result = await adapter.send({ chatId: "55", text: "respuesta" });

      // PRESERVE: no keyboard means the transport is called with two arguments only.
      assert.deepEqual(bot.sent, [
        { chatId: "55", text: "respuesta", options: undefined, argc: 2 },
      ]);
      assert.equal(result.messageId, "1001");
});

test("send chunks a text longer than the transport limit and reports the first id", async () => {
  const bot = fakeBot();
  const adapter = createTelegramChannelAdapter({
    botFactory: () => bot,
    textLimit: 10,
  });
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  const result = await adapter.send({ chatId: "55", text: "A".repeat(25) });

  assert.equal(bot.sent.length, 3);
  assert.deepEqual(
    bot.sent.map((entry) => entry.text.length),
    [10, 10, 5],
  );
  assert.equal(result.messageId, "1001");
});

test("send before start is a typed unavailable error", async () => {
  const adapter = adapterWith(fakeBot());

  await assert.rejects(
    () => adapter.send({ chatId: "55", text: "hola" }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "unavailable",
  );
});

test("classifyTelegramSendError maps 429, invalid chat and anything else", () => {
  const rateLimited = Object.assign(new Error("429: Too Many Requests"), {
    error_code: 429,
    parameters: { retry_after: 3 },
  });
  const classified = classifyTelegramSendError(rateLimited);
  assert.equal(classified.code, "rate_limited");
  assert.equal(classified.retryAfterMs, 3000);

  assert.equal(
    classifyTelegramSendError(new Error("400: chat not found")).code,
    "invalid_chat",
  );
  assert.equal(
    classifyTelegramSendError(new Error("socket hang up")).code,
    "unavailable",
  );
});

test("send never retries by itself: one failing attempt surfaces one request", async () => {
  const bot = fakeBot({
    sendOutcomes: [
      { ok: false, error: Object.assign(new Error("500: boom"), { status: 500 }) },
    ],
  });
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await assert.rejects(
    () => adapter.send({ chatId: "55", text: "hola" }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "unavailable",
  );
  assert.equal(bot.sent.length, 1);
});

test("stop is idempotent, silent and safe while a send is in flight", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  const inFlight = adapter.send({ chatId: "55", text: "en vuelo" });
  await adapter.stop();
  await adapter.stop();
  await inFlight;

  assert.equal(bot.stopCount, 1);
  // Silent teardown: no farewell text is ever posted.
  assert.equal(
    bot.sent.some((entry) => /adiós|adieu|bye|farewell/i.test(entry.text)),
    false,
  );
});

// --- polling loop semantics (fix round A, C2) -------------------------------
//
// `bot.start()` is the long-poll loop itself: grammy resolves it when the bot
// stops. Awaiting it inside `adapter.start()` therefore never returned, so
// `registry.replaceAll` hung on the first projected channel, `send` stayed
// `unavailable`, and the poller could not be stopped from `stop()`. The fake
// above now reproduces that, so these two tests are the regression gate.

test("start es síncrona respecto al loop: el bot se entrega ANTES de que el poller termine", { timeout: 5000 }, async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  const received: unknown[] = [];

  await adapter.start({
    token: TOKEN,
    onInbound: (message) => received.push(message),
  });

  // Handlers registered and `bot` assigned before the loop is fired: the
  // transport is usable even though its promise is still pending.
  assert.equal(bot.loopState, "polling");
  bot.emit({ chatId: "-1001", messageId: "7", text: "¿hora en Madrid?" });
  assert.equal(received.length, 1, "inbound fluye con el loop aún abierto");

      const sent = await adapter.send({ chatId: "-1001", text: "las 10" });
      assert.equal(sent.messageId, "1001");
      assert.deepEqual(bot.sent, [
        { chatId: "-1001", text: "las 10", options: undefined, argc: 2 },
      ]);

  // `stop()` is what ends the loop, and it resolves: no unstoppable poller.
  await adapter.stop();
  assert.equal(bot.stopCount, 1);
  assert.equal(bot.loopState, "stopped");
});

test("un loop que revienta se mapea a un error tipado y el adapter deja de fingirse vivo", { timeout: 5000 }, async () => {
  const logs: string[] = [];
  const bot = fakeBot({
    startError: new Error(`409: Conflict: terminated by other getUpdates (${TOKEN})`),
  });
  const adapter = createTelegramChannelAdapter({
    botFactory: () => bot,
    log: (line) => logs.push(line),
  });

  // Never throws into the projection: a loop that dies later cannot make a
  // `replaceAll` fail after it already reported the channel as active.
  await adapter.start({ token: TOKEN, onInbound: () => {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bot.loopState, "failed");
  const report = logs.join("\n");
  assert.match(report, /unavailable/, "el fallo del loop usa la taxonomía del adapter");
  assert.equal(
    report.includes(TOKEN),
    false,
    "el log nunca devuelve el token que Telegram repite en la descripción",
  );

  // The dead transport is reported, not hidden: `send` is `unavailable` and
  // the outbox owns the retry decision.
  await assert.rejects(
    () => adapter.send({ chatId: "-1001", text: "respuesta" }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "unavailable",
  );
  // Stopping an adapter whose loop already died is a silent no-op.
  await adapter.stop();
  assert.equal(bot.stopCount, 0);
});

// --- error redaction (grammy-bot.ts) -----------------------------------------
//
// grammy's default error handler prints the whole `BotError`, which carries the
// offending update and the failed API call's payload — i.e. the Agent's reply
// text — and some failures echo the bot token back in their description. The
// adapter owns one redacting line instead.

test("redactTelegramError never echoes the token or a multi-line payload", async () => {
  const { redactTelegramError } = await import("../dist/grammy-bot.js");
  const secretReply = "el agente contesto esto";
  const payload = new Error(
    `BadRequest: 400: Bad Request: chat not found\ncontext: {"chat_id":"55","text":"${TOKEN} ${secretReply}"}`,
  );
  const line = redactTelegramError(payload, TOKEN);
  assert.equal(line.includes(TOKEN), false, "the token must not survive");
  assert.equal(line.includes("\n"), false, "one line only");
  assert.ok(line.length <= 200);
});

test("redactTelegramError tolerates a non-Error throwable", async () => {
  const { redactTelegramError } = await import("../dist/grammy-bot.js");
  assert.equal(redactTelegramError(undefined, TOKEN), "unknown error");
  assert.equal(redactTelegramError({ message: "x" }, TOKEN), "[object Object]");
});

// --- callback queries and inline keyboards (T6b/1) ---------------------------
//
// The seam grows two additive capabilities: an inbound button press arrives as an
// InboundMessage carrying `callback`, and an outbound message may carry an inline
// keyboard whose `callback_data` the transport echoes back. Nothing here is
// Telegram-specific on purpose: the Manager only ever sees `{id, data}` and rows of
// `{text, data}`.

test("un callback_query:data llega como InboundMessage con callback y sin texto", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  const received: Array<Record<string, unknown>> = [];

  await adapter.start({
    token: TOKEN,
    onInbound: (message) => received.push({ ...message }),
  });
  bot.emitCallback({
    chatId: "-100123",
    messageId: "42",
    id: "cb-1",
    data: "approve:turn-7",
    senderName: "Pepe",
  });

  // `text` is empty, not absent: a press carries no prose, and a consumer that
  // matches on `callback` never has to guard a missing field.
  assert.deepEqual(received, [
    {
      externalChatId: "-100123",
      text: "",
      messageId: "42",
      senderName: "Pepe",
      callback: { id: "cb-1", data: "approve:turn-7" },
    },
  ]);
});

test("un callback sin mensaje asociado se descarta en vez de reventar el poller", async () => {
  const logs: string[] = [];
  const bot = fakeBot();
  const adapter = createTelegramChannelAdapter({
    botFactory: () => bot,
    log: (line) => logs.push(line),
  });
  const received: unknown[] = [];

  await adapter.start({ token: TOKEN, onInbound: (message) => received.push(message) });
  // Telegram still delivers button presses whose message was deleted when the bot
  // was offline. Fail closed: drop it and say so, never throw out of the poller.
  assert.doesNotThrow(() =>
    bot.emitCallback({ chatId: "", messageId: "", id: "cb-2", data: "stale" }),
  );
  assert.deepEqual(received, []);
  assert.match(logs.join("\n"), /callback/);
  assert.equal(logs.join("\n").includes(TOKEN), false);
});

test("send con keyboard manda el reply_markup solo en el primer chunk", async () => {
  const bot = fakeBot();
  const adapter = createTelegramChannelAdapter({
    botFactory: () => bot,
    textLimit: 10,
  });
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await adapter.send({
    chatId: "55",
    text: "A".repeat(25),
    keyboard: [
      [{ text: "Sí", data: "approve:7" }, { text: "No", data: "reject:7" }],
      [{ text: "Luego", data: "later:7" }],
    ],
  });

  assert.equal(bot.sent.length, 3);
  // Buttons belong to the message that asks the question, never to its tail.
  assert.deepEqual(bot.sent[0].options, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Sí", callback_data: "approve:7" },
          { text: "No", callback_data: "reject:7" },
        ],
        [{ text: "Luego", callback_data: "later:7" }],
      ],
    },
  });
  assert.equal(bot.sent[0].argc, 3);
  assert.equal(bot.sent[1].options, undefined);
  assert.equal(bot.sent[1].argc, 2);
  assert.equal(bot.sent[2].options, undefined);
  assert.equal(bot.sent[2].argc, 2);
});

test("un keyboard vacío se comporta como no mandar keyboard", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await adapter.send({ chatId: "55", text: "hola", keyboard: [] });

  assert.deepEqual(bot.sent, [{ chatId: "55", text: "hola", options: undefined, argc: 2 }]);
});

test("un callback_data de más de 64 bytes falla antes de cualquier llamada de red", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await assert.rejects(
    () =>
      adapter.send({
        chatId: "55",
        text: "¿aprobar?",
        keyboard: [[{ text: "OK", data: "x".repeat(65) }]],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ChannelAdapterError);
      assert.equal(error.code, "invalid_keyboard");
      return true;
    },
  );
  // Fail fast: the transport is never asked to reject what we already know is bad.
  assert.deepEqual(bot.sent, []);
  assert.deepEqual(bot.calls, ["getMe", "on", "on", "start"]);
});

test("un callback_data vacío o no-string también es invalid_keyboard", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await assert.rejects(
    () => adapter.send({ chatId: "55", text: "x", keyboard: [[{ text: "OK", data: "" }]] }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "invalid_keyboard",
  );
  await assert.rejects(
    () =>
      adapter.send({
        chatId: "55",
        text: "x",
        keyboard: [[{ text: "OK", data: 42 as unknown as string }]],
      }),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "invalid_keyboard",
  );
  assert.deepEqual(bot.sent, []);
});

test("answerCallback acusa el callback con y sin texto de aviso", async () => {
  const bot = fakeBot();
  const adapter = adapterWith(bot);
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  await adapter.answerCallback?.("cb-1", "Turno aprobado");
  await adapter.answerCallback?.("cb-2");

  assert.deepEqual(bot.answered, [
    { id: "cb-1", text: "Turno aprobado" },
    { id: "cb-2", text: undefined },
  ]);
});

test("answerCallback es best-effort: un transporte que falla se registra y no escapa", async () => {
  const logs: string[] = [];
  const bot = fakeBot({ answerError: new Error("400: Bad Request: query is too old") });
  const adapter = createTelegramChannelAdapter({
    botFactory: () => bot,
    log: (line) => logs.push(line),
  });
  await adapter.start({ token: TOKEN, onInbound: () => {} });

  // A stale ack is harmless: the buttons are gone anyway. Throwing here would
  // break the inbound turn that merely tried to acknowledge a press.
  await assert.doesNotReject(() => adapter.answerCallback!("cb-3", "ok"));
  assert.match(logs.join("\n"), /unavailable/);
});

test("answerCallback antes de start es un unavailable tipado, no un TypeError", async () => {
  const adapter = adapterWith(fakeBot());

  await assert.rejects(
    () => adapter.answerCallback!("cb-1"),
    (error: unknown) =>
      error instanceof ChannelAdapterError && error.code === "unavailable",
  );
});
