import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Context, Filter } from "grammy";
import {
  CALLBACK_TIMEOUT_MS,
  createTelegramHumanReplyMiddleware,
} from "../dist/telegram.js";

const CALLBACK_TOKEN_ENV = "PIHUB_RUNNER_CALLBACK_TOKEN";
const ERROR_MESSAGE = "No pude entregar la respuesta. Reinténtalo o usa el panel.";

type TextContext = Filter<Context, "message:text">;

function fakeContext(options: {
  text?: string;
  updateId?: number;
  chatId?: number;
  replyToMessageId?: number;
} = {}): TextContext {
  const chat = { id: options.chatId ?? -100_987_654, type: "private" as const };
  const message = {
    message_id: 51,
    date: 1_735_689_600,
    chat,
    from: { id: 777, is_bot: false, first_name: "Ada" },
    text: options.text ?? "sí, adelante",
    ...(options.replyToMessageId === undefined
      ? {}
      : {
          reply_to_message: {
            message_id: options.replyToMessageId,
            date: 1_735_689_500,
            chat,
            text: "¿Continúo?",
          },
        }),
  };

  return {
    update: { update_id: options.updateId ?? 42, message },
    message,
    chat,
  } as unknown as TextContext;
}

async function withCallbackToken<T>(token: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[CALLBACK_TOKEN_ENV];
  if (token === undefined) delete process.env[CALLBACK_TOKEN_ENV];
  else process.env[CALLBACK_TOKEN_ENV] = token;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[CALLBACK_TOKEN_ENV];
    else process.env[CALLBACK_TOKEN_ENV] = previous;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function invoke(options: {
  ctx?: TextContext;
  fetch: typeof globalThis.fetch;
  token?: string;
}) {
  const responses: string[] = [];
  let downstreamCalls = 0;
  const middleware = createTelegramHumanReplyMiddleware(
    { managerPort: 45_678 },
    {
      fetch: options.fetch,
      respondTo: async (_ctx, text) => {
        responses.push(text);
      },
    },
  );

  await withCallbackToken(options.token ?? "runner-callback-token", () =>
    middleware(options.ctx ?? fakeContext({ replyToMessageId: 314 }), async () => {
      downstreamCalls += 1;
    }),
  );

  return { responses, downstreamCalls };
}

test("forwards the exact closed Telegram reply request to the Manager", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return jsonResponse({ status: "accepted" });
  }) as typeof globalThis.fetch;

  const result = await invoke({
    ctx: fakeContext({
      chatId: -100_123_456,
      replyToMessageId: 901,
      text: "hazlo",
      updateId: 7_654,
    }),
    fetch: fetchFake,
  });

  assert.equal(
    capturedUrl,
    "http://127.0.0.1:45678/internal/runner/telegram-reply",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(Object.fromEntries(new Headers(capturedInit?.headers).entries()), {
    "content-type": "application/json",
    "x-pihub-runner-callback-token": "runner-callback-token",
  });
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    chatId: -100_123_456,
    replyToMessageId: 901,
    text: "hazlo",
    idempotencyKey: "telegram:update:7654",
  });
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  assert.equal(CALLBACK_TIMEOUT_MS, 5_000);
  assert.deepEqual(result, { responses: ["Respuesta recibida."], downstreamCalls: 0 });
});

test("maps every handled Manager status to its fixed Telegram response and consumes the update", async () => {
  const cases = [
    ["accepted", "Respuesta recibida."],
    ["replayed", "Respuesta ya recibida."],
    ["already_handled", "Esta solicitud ya fue respondida."],
    ["expired", "Esta solicitud ha caducado; usa el panel."],
  ] as const;

  for (const [status, expected] of cases) {
    const result = await invoke({
      fetch: (async () => jsonResponse({ status })) as typeof globalThis.fetch,
    });
    assert.deepEqual(result, { responses: [expected], downstreamCalls: 0 }, status);
  }
});

test("a non-reply and an unknown card continue to the existing command or chat flow", async () => {
  let fetchCalls = 0;
  const noReply = await invoke({
    ctx: fakeContext(),
    token: undefined,
    fetch: (async () => {
      fetchCalls += 1;
      return jsonResponse({ status: "accepted" });
    }) as typeof globalThis.fetch,
  });
  assert.deepEqual(noReply, { responses: [], downstreamCalls: 1 });
  assert.equal(fetchCalls, 0, "un mensaje sin reply no toca el Manager");

  const unknown = await invoke({
    fetch: (async () => jsonResponse({ status: "unknown" })) as typeof globalThis.fetch,
  });
  assert.deepEqual(unknown, { responses: [], downstreamCalls: 1 });
});

test("a command-shaped reply cannot bypass the human-reply ingress", async () => {
  const result = await invoke({
    ctx: fakeContext({ text: "/new", replyToMessageId: 314 }),
    fetch: (async () => jsonResponse({ status: "accepted" })) as typeof globalThis.fetch,
  });
  assert.deepEqual(
    result,
    { responses: ["Respuesta recibida."], downstreamCalls: 0 },
    "el callback consume /new y no deja ejecutar el comando ni el chat normal",
  );

  const source = await readFile(new URL("../src/telegram.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function startTelegram");
  const allowlist = source.indexOf("bot.use(", start);
  const replyIngress = source.indexOf("createTelegramHumanReplyMiddleware(env", start);
  const firstCommand = source.indexOf("bot.command(", start);
  const normalChat = source.indexOf('bot.on("message:text", async (ctx) =>', start);
  assert.ok(start >= 0 && allowlist >= 0 && replyIngress >= 0 && firstCommand >= 0 && normalChat >= 0);
  assert.ok(
    allowlist < replyIngress && replyIngress < firstCommand && firstCommand < normalChat,
    "allowlist → reply ingress → comandos → chat normal es un orden contractual",
  );
});

test("transport and protocol failures show the fixed warning and never open a session", async () => {
  const failures: Array<[string, string | undefined, typeof globalThis.fetch]> = [
    [
      "token ausente",
      undefined,
      (async () => {
        assert.fail("sin token no debe hacerse fetch");
      }) as typeof globalThis.fetch,
    ],
    [
      "manager caído",
      "runner-callback-token",
      (async () => {
        throw new Error("connection refused");
      }) as typeof globalThis.fetch,
    ],
    [
      "timeout",
      "runner-callback-token",
      (async (_input, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        throw new DOMException("timed out", "TimeoutError");
      }) as typeof globalThis.fetch,
    ],
    [
      "HTTP no 200",
      "runner-callback-token",
      (async () => jsonResponse({ status: "accepted" }, 503)) as typeof globalThis.fetch,
    ],
    [
      "JSON inválido",
      "runner-callback-token",
      (async () => new Response("{", { status: 200 })) as typeof globalThis.fetch,
    ],
    [
      "status inválido",
      "runner-callback-token",
      (async () => jsonResponse({ status: "surprise" })) as typeof globalThis.fetch,
    ],
  ];

  for (const [name, token, fetchFake] of failures) {
    const responses: string[] = [];
    let sessionsOpened = 0;
    let fetchCalls = 0;
    const countedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      return fetchFake(input, init);
    }) as typeof globalThis.fetch;
    const middleware = createTelegramHumanReplyMiddleware(
      { managerPort: 45_678 },
      {
        fetch: countedFetch,
        respondTo: async (_ctx, text) => {
          responses.push(text);
        },
      },
    );

    await withCallbackToken(token, () =>
      middleware(fakeContext({ replyToMessageId: 314 }), async () => {
        sessionsOpened += 1;
      }),
    );

    assert.deepEqual(responses, [ERROR_MESSAGE], name);
    assert.equal(sessionsOpened, 0, `${name}: no cae al handler normal`);
    assert.equal(fetchCalls, token === undefined ? 0 : 1, name);
  }
});
