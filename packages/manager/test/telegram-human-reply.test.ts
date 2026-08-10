import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PihubEnv } from "@pihub/shared";
import type { RuntimeProviders } from "@pihub/providers";
import { createApi } from "../dist/api.js";
import { internalRouter } from "../dist/api-v1/internal.js";
import type { Initiative } from "../src/agenda/initiatives.ts";
import type {
  RespondInitiativeCommand,
  RespondInitiativeResult,
  AutonomyControl,
} from "../src/agenda/autonomy-control.ts";
import { DomainError } from "../dist/agenda/errors.js";
import type {
  HumanRequestDeliveries,
  HumanRequestDeliveryRow,
} from "../src/agenda/human-requests.ts";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";

const CALLBACK_ALPHA = "11".repeat(32);
const CALLBACK_BETA = "22".repeat(32);
const SERVICE_TOKEN = "aa".repeat(32);
const NOW = 50_000;
const VALID_BODY = {
  chatId: 123,
  replyToMessageId: 456,
  text: "Sí, continúa",
  idempotencyKey: "telegram-update-789",
};

function delivery(overrides: Partial<HumanRequestDeliveryRow> = {}): HumanRequestDeliveryRow {
  return {
    humanRequestId: "request-1",
    agentName: "alpha",
    initiativeId: "initiative-1",
    channel: "telegram",
    externalChatId: "123",
    externalMessageId: "456",
    createdAt: 40_000,
    ...overrides,
  };
}

function currentInitiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: "initiative-1",
    agentName: "alpha",
    state: "waiting_human",
    origin: "trigger",
    triggerId: "trigger-1",
    intent: "Continuar el trabajo",
    mode: "ask",
    sessionKey: "session-1",
    availableAt: 1,
    boundModel: null,
    turnId: "turn-1",
    chainDepth: 0,
    chainDeadlineAt: null,
    visibleEffectsDeclared: false,
    summary: "Necesita confirmación",
    askCorrelation: "tool-1",
    failureReason: null,
    result: null,
    createdAt: 1,
    stateChangedAt: 40_000,
    startedAt: 2,
    finishedAt: null,
    humanQuestion: "¿Continúo?",
    humanExpiresAt: 60_000,
    humanRequestId: "request-1",
    ...overrides,
  };
}

type HarnessOptions = {
  found?: HumanRequestDeliveryRow | null;
  respondResult?: RespondInitiativeResult;
  respondError?: unknown;
  current?: Initiative;
  lookupError?: unknown;
};

function harness(options: HarnessOptions = {}) {
  const lookups: unknown[][] = [];
  const responds: RespondInitiativeCommand[] = [];
  const stateReads: unknown[][] = [];
  let nowCalls = 0;
  const found = options.found === undefined ? delivery() : options.found;
  const current = options.current ?? currentInitiative();

  const supervisor = {
    verifyCallbackToken(candidate: unknown): string | undefined {
      if (candidate === CALLBACK_ALPHA) return "alpha";
      if (candidate === CALLBACK_BETA) return "beta";
      return undefined;
    },
    state: () => ({ state: "stopped" as const }),
  } as unknown as Supervisor;
  const deliveries = {
    lookupDelivery(...args: unknown[]): HumanRequestDeliveryRow | null {
      lookups.push(args);
      if (options.lookupError !== undefined) throw options.lookupError;
      return found;
    },
  } as unknown as Pick<HumanRequestDeliveries, "lookupDelivery">;
  const control = {
    respondToInitiative(command: RespondInitiativeCommand): RespondInitiativeResult {
      responds.push(command);
      if (options.respondError !== undefined) throw options.respondError;
      return options.respondResult ?? { initiative: current, replayed: false };
    },
    initiativeForAgent(agentName: string, initiativeId: string): Initiative {
      stateReads.push([agentName, initiativeId]);
      return current;
    },
  } as unknown as AutonomyControl;
  const router = internalRouter({
    supervisor,
    deliveries,
    control,
    now: () => {
      nowCalls += 1;
      return NOW;
    },
  });

  return {
    router,
    supervisor,
    deliveries,
    control,
    lookups,
    responds,
    stateReads,
    nowCalls: () => nowCalls,
  };
}

function post(
  router: ReturnType<typeof internalRouter>,
  options: {
    token?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token === undefined
      ? { "x-pihub-runner-callback-token": CALLBACK_ALPHA }
      : options.token.length > 0
        ? { "x-pihub-runner-callback-token": options.token }
        : {}),
    ...options.headers,
  };
  return router.request("http://manager.test/telegram-reply", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? VALID_BODY),
  });
}

function fullApp(h: ReturnType<typeof harness>, withAutonomy = true) {
  return createApi(
    {
      dataDir: "/tmp/pihub-a14-test",
      apiToken: SERVICE_TOKEN,
      panelEnabled: true,
    } as PihubEnv,
    h.supervisor,
    {} as OAuthService,
    {} as RuntimeProviders,
    undefined,
    withAutonomy
      ? {
          projection: { snapshotForAgent: () => { throw new Error("not used"); } },
          control: h.control,
          deliveries: h.deliveries,
        }
      : undefined,
  );
}

async function assertStatus(response: Response, status: string): Promise<void> {
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `{"status":"${status}"}`);
}

describe("POST /internal/runner/telegram-reply", () => {
  it("is not mounted without the optional autonomy bundle", async () => {
    const h = harness();
    const response = await fullApp(h, false).request(
      "http://manager.test/internal/runner/telegram-reply",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pihub-runner-callback-token": CALLBACK_ALPHA,
        },
        body: JSON.stringify(VALID_BODY),
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.responds, []);
  });

  it("the child router declares only POST /telegram-reply", async () => {
    const h = harness();
    const response = await h.router.request("http://manager.test/telegram-reply", {
      method: "GET",
      headers: { "x-pihub-runner-callback-token": CALLBACK_ALPHA },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(h.lookups, []);
  });

  it("authenticates before JSON parsing and makes missing/invalid auth identical", async () => {
    const h = harness();
    const missing = await post(h.router, { token: "", rawBody: "{" });
    const invalid = await post(h.router, { token: "ff".repeat(32), rawBody: "{" });

    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.equal(await missing.text(), await invalid.text());
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.responds, []);
    assert.equal(h.nowCalls(), 0);
  });

  it("internal callback auth is exclusive: API_TOKEN, Bearer and cookies never authorize", async () => {
    const h = harness();
    const app = fullApp(h);
    const forbiddenHeaders = [
      { authorization: `Bearer ${SERVICE_TOKEN}` },
      { cookie: `pihub_token=${SERVICE_TOKEN}` },
      { authorization: `Bearer ${SERVICE_TOKEN}`, cookie: `pihub_token=${SERVICE_TOKEN}` },
      { "x-api-token": SERVICE_TOKEN },
      { authorization: `Bearer ${CALLBACK_ALPHA}` },
      { cookie: `pihub_token=${CALLBACK_ALPHA}` },
    ];

    for (const headers of forbiddenHeaders) {
      const response = await app.request("http://manager.test/internal/runner/telegram-reply", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "");
    }
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.responds, []);

    const accepted = await app.request("http://manager.test/internal/runner/telegram-reply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pihub-runner-callback-token": CALLBACK_ALPHA,
      },
      body: JSON.stringify(VALID_BODY),
    });
    await assertStatus(accepted, "accepted");
  });

  it("rejects malformed JSON and every extra body property", async () => {
    for (const body of [
      { ...VALID_BODY, humanRequestId: "attacker-request" },
      { ...VALID_BODY, agentName: "beta" },
      { ...VALID_BODY, extra: true },
    ]) {
      const h = harness();
      const response = await post(h.router, { body });
      assert.equal(response.status, 400);
      assert.deepEqual(h.lookups, []);
      assert.deepEqual(h.responds, []);
    }

    const malformed = harness();
    const response = await post(malformed.router, { rawBody: "{" });
    assert.equal(response.status, 400);
    assert.deepEqual(malformed.lookups, []);
  });

  it("returns unknown for an agent-scoped delivery miss without writing", async () => {
    const h = harness({ found: null });
    const response = await post(h.router, { token: CALLBACK_BETA });

    await assertStatus(response, "unknown");
    assert.deepEqual(h.lookups, [["beta", "telegram", "123", "456"]]);
    assert.deepEqual(h.responds, []);
    assert.deepEqual(h.stateReads, []);
  });

  it("passes the delivery request as the exact CAS expectation and returns accepted", async () => {
    const h = harness();
    const response = await post(h.router);

    await assertStatus(response, "accepted");
    assert.equal(h.nowCalls(), 1);
    assert.deepEqual(h.lookups, [["alpha", "telegram", "123", "456"]]);
    assert.deepEqual(h.responds, [{
      agentName: "alpha",
      initiativeId: "initiative-1",
      answer: "Sí, continúa",
      idempotencyKey: "telegram-update-789",
      now: NOW,
      expectedHumanRequestId: "request-1",
    }]);
    assert.deepEqual(h.stateReads, []);
  });

  it("preserves idempotent replay after the Initiative has left waiting_human", async () => {
    const replayed = currentInitiative({ state: "running" });
    const h = harness({ respondResult: { initiative: replayed, replayed: true } });
    await assertStatus(await post(h.router), "replayed");
    assert.deepEqual(h.stateReads, []);
  });

  it("returns already_handled for a second reply after the same request was queued", async () => {
    const h = harness({
      respondError: new DomainError("INITIATIVE_STATE_CONFLICT", "first reply already won"),
      current: currentInitiative({ state: "queued" }),
    });
    await assertStatus(await post(h.router), "already_handled");
    assert.deepEqual(h.stateReads, [["alpha", "initiative-1"]]);
  });

  it("a reply to an old Telegram card cannot answer a newer Ask", async () => {
    const h = harness({
      found: delivery({ humanRequestId: "request-old" }),
      respondError: new DomainError("INITIATIVE_STATE_CONFLICT", "CAS mismatch"),
      current: currentInitiative({ humanRequestId: "request-new" }),
    });
    await assertStatus(await post(h.router), "already_handled");
    assert.equal(h.responds[0]?.expectedHumanRequestId, "request-old");
    assert.deepEqual(h.stateReads, [["alpha", "initiative-1"]]);
  });

  it("returns expired at the exact human deadline even before a sweep, and for expired state", async () => {
    for (const current of [
      currentInitiative({ state: "waiting_human", humanExpiresAt: NOW }),
      currentInitiative({ state: "expired", humanExpiresAt: null }),
    ]) {
      const h = harness({
        respondError: new DomainError("INITIATIVE_STATE_CONFLICT", "deadline conflict"),
        current,
      });
      await assertStatus(await post(h.router), "expired");
    }
  });

  it("never classifies by DomainError.message and fails unexpected causes closed", async () => {
    const unexplained = harness({
      respondError: new DomainError(
        "INITIATIVE_STATE_CONFLICT",
        "expired already handled waiting_human text must not decide",
      ),
      current: currentInitiative({ humanExpiresAt: NOW + 1 }),
    });
    assert.equal((await post(unexplained.router)).status, 500);

    const wrongCode = harness({
      respondError: new DomainError("IDEMPOTENCY_CONFLICT", "already handled"),
    });
    assert.equal((await post(wrongCode.router)).status, 500);

    const lookupFailure = harness({ lookupError: new Error("storage unavailable") });
    assert.equal((await post(lookupFailure.router)).status, 500);
  });
});
