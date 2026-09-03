/**
 * Tests de las tools `schedule_trigger` y `revoke_trigger` (pihub step 2b).
 *
 * Se prueba:
 * - factory `createAgentTools` (devuelve las 3 tools para sesiones initiative).
 * - validación de parámetros del schedule (version/kind/timeZone/at inválidos).
 * - ruta + headers + body del POST de create (con fetch mockeado).
 * - parseo del Trigger 201 → texto legible con id y próxima ejecución.
 * - mapeo de errores 403/409 → texto code+message verbatim.
 * - passthrough de `idempotencyKey` (header, no body) y generación si ausente.
 * - revoke: ruta correcta, sin idempotency en body, texto de éxito/error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Check } from "typebox/value";
import {
  ASK_HUMAN_TOOL_NAME,
  SCHEDULE_TRIGGER_TOOL_NAME,
  REVOKE_TRIGGER_TOOL_NAME,
} from "@pihub/shared";
import { createAgentTools } from "../src/agent-tools.ts";
import { SessionFactory } from "../src/session.ts";

const ENV = {
  dataDir: "/data",
  managerPort: 4000,
  apiToken: "TEST_TOKEN",
} as never;

const SCHEDULE = {
  version: 2,
  kind: "daily",
  timeZone: "America/New_York",
  at: "09:30",
};

/** Captura la petición del fetch mockeado. */
function installMockFetch(
  respond: (url: string, init: RequestInit) => Response,
) {
  const calls: Array<{
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const entry = { url: String(url), init: init ?? {}, body };
    calls.push(entry);
    return respond(String(url), init ?? {}) as Response;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function callSchedule(
  tool: ReturnType<typeof createAgentTools>[1],
  params: Record<string, unknown>,
) {
  return tool.execute("call-1", params as never);
}

// ---------------------------------------------------------------------------
// 1. Factory: initiative recibe las 3 tools; sesión human no recibe ninguna custom
// ---------------------------------------------------------------------------

test("createAgentTools devuelve las 3 tools del agente (ask_human + schedule_trigger + revoke_trigger)", () => {
  const tools = createAgentTools(ENV, "writer");
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((t) => t.name),
    [ASK_HUMAN_TOOL_NAME, SCHEDULE_TRIGGER_TOOL_NAME, REVOKE_TRIGGER_TOOL_NAME],
  );
});

test("las tools de scheduling son sequential y revoke_trigger tiene los parámetros esperados", () => {
  const tools = createAgentTools(ENV, "writer");
  const schedule = tools.find((t) => t.name === SCHEDULE_TRIGGER_TOOL_NAME)!;
  const revoke = tools.find((t) => t.name === REVOKE_TRIGGER_TOOL_NAME)!;
  assert.equal(schedule.executionMode, "sequential");
  assert.equal(revoke.executionMode, "sequential");
  const revokeParams = revoke.parameters as Record<string, unknown>;
  assert.equal(
    (revokeParams as { additionalProperties?: boolean }).additionalProperties,
    false,
  );
  const props = revokeParams.properties as Record<string, unknown>;
  assert.ok(props.triggerId, "revoke_trigger exige triggerId");
});

test("una sesión human excluye ask_human y NO inyecta las tools de scheduling (customTools ausentes)", async () => {
  const captured: { options: Record<string, unknown> | null } = {
    options: null,
  };
  const factory = new SessionFactory(
    {
      dataDir: "/tmp",
      memoryEnabled: false,
      platformPromptEnabled: false,
    } as never,
    {
      name: "writer",
      port: 0,
      enabled: true,
      createdAt: "2025-01-01",
    } as never,
    undefined,
    "human",
  );
  (factory as any).runtimeProviders = {
    createSession: async (opts: any) => {
      captured.options = opts;
      return {
        isStreaming: false,
        subscribe: () => () => {},
        async prompt() {},
        async abort() {},
        dispose() {},
      };
    },
    registerExtensionProviders: async () => {},
    resolveModel: async () => null,
  };
  await factory.create();
  assert.deepEqual(captured.options!.excludeTools, [ASK_HUMAN_TOOL_NAME]);
  assert.ok(
    !captured.options!.customTools,
    "human no puede invocar tools de scheduling (no son customTools)",
  );
});

test("una sesión initiative inyecta ask_human + schedule_trigger + revoke_trigger vía customTools", async () => {
  const captured: { options: Record<string, unknown> | null } = {
    options: null,
  };
  const factory = new SessionFactory(
    {
      dataDir: "/tmp",
      memoryEnabled: false,
      platformPromptEnabled: false,
    } as never,
    {
      name: "writer",
      port: 0,
      enabled: true,
      createdAt: "2025-01-01",
    } as never,
    undefined,
    "initiative",
  );
  (factory as any).runtimeProviders = {
    createSession: async (opts: any) => {
      captured.options = opts;
      return {
        isStreaming: false,
        subscribe: () => () => {},
        async prompt() {},
        async abort() {},
        dispose() {},
      };
    },
    registerExtensionProviders: async () => {},
    resolveModel: async () => null,
  };
  await factory.create();
  assert.ok(!captured.options!.excludeTools, "initiative no excluye ask_human");
  const names = (captured.options!.customTools as Array<{ name: string }>).map(
    (t) => t.name,
  );
  assert.deepEqual(names, [
    ASK_HUMAN_TOOL_NAME,
    SCHEDULE_TRIGGER_TOOL_NAME,
    REVOKE_TRIGGER_TOOL_NAME,
  ]);
});

// ---------------------------------------------------------------------------
// 2. Validación de parámetros del schedule
// ---------------------------------------------------------------------------

test("schedule_trigger rechaza version != 2", () => {
  const tool = createAgentTools(ENV, "writer")[1];
  assert.equal(
    Check(tool.parameters, {
      schedule: { ...SCHEDULE, version: 1 },
      intent: "hacer algo",
    }),
    false,
  );
});

test("schedule_trigger rechaza kind fuera de daily|weekly", () => {
  const tool = createAgentTools(ENV, "writer")[1];
  assert.equal(
    Check(tool.parameters, {
      schedule: { ...SCHEDULE, kind: "hourly" },
      intent: "hacer algo",
    }),
    false,
  );
});

test("schedule_trigger rechaza timeZone vacía", () => {
  const tool = createAgentTools(ENV, "writer")[1];
  assert.equal(
    Check(tool.parameters, {
      schedule: { ...SCHEDULE, timeZone: "" },
      intent: "hacer algo",
    }),
    false,
  );
});

test("schedule_trigger rechaza at fuera de HH:MM", () => {
  const tool = createAgentTools(ENV, "writer")[1];
  assert.equal(
    Check(tool.parameters, {
      schedule: { ...SCHEDULE, at: "25:00" },
      intent: "hacer algo",
    }),
    false,
  );
  assert.equal(
    Check(tool.parameters, {
      schedule: { ...SCHEDULE, at: "9:30" },
      intent: "hacer algo",
    }),
    false,
  );
});

test("schedule_trigger acepta schedule daily válido (y weekly con days)", () => {
  const tool = createAgentTools(ENV, "writer")[1];
  assert.equal(
    Check(tool.parameters, {
      schedule: SCHEDULE,
      intent: "hacer algo",
      mode: "solo",
    }),
    true,
  );
  assert.equal(
    Check(tool.parameters, {
      schedule: {
        version: 2,
        kind: "weekly",
        timeZone: "UTC",
        at: "10:00",
        days: ["mon", "wed"],
      },
      intent: "hacer algo",
      suggestedSkill: "foobar",
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 3. Success path: ruta + headers + body, y parseo del Trigger 201
// ---------------------------------------------------------------------------

test("schedule_trigger llama al POST correcto con headers de identidad e idempotency, body exacto", async () => {
  const mock = installMockFetch(
    () =>
      new Response(
        JSON.stringify({
          trigger: { id: "trig-1", nextFireAt: 1234567890000 },
          replayed: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const tool = createAgentTools(ENV, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "Resumir noticias",
      mode: "ask",
      suggestedSkill: "news",
      idempotencyKey: "idem-42",
    });
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(
      call.url,
      "http://127.0.0.1:4000/api/v1/agents/writer/triggers",
    );
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer TEST_TOKEN");
    assert.equal(headers["Idempotency-Key"], "idem-42");
    assert.equal(headers["X-Pihub-Principal"], "runner");
    assert.equal(headers["X-Pihub-Agent"], "writer");
    assert.ok(headers["x-correlation-id"], "emite x-correlation-id");
    assert.deepEqual(call.body, {
      definition: SCHEDULE,
      intent: "Resumir noticias",
      mode: "ask",
      suggestedSkill: "news",
    });

    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /Trigger scheduled \(id: trig-1, next fire: /);
  } finally {
    mock.restore();
  }
});

test("idempotencyKey ausente genera un UUID en el header y NO aparece en el body", async () => {
  const mock = installMockFetch(
    () =>
      new Response(
        JSON.stringify({
          trigger: { id: "trig-2", nextFireAt: 1234567890000 },
          replayed: false,
        }),
        {
          status: 201,
        },
      ),
  );
  try {
    const tool = createAgentTools(ENV, "writer")[1];
    await callSchedule(tool, { schedule: SCHEDULE, intent: "hacer algo" });
    const call = mock.calls[0];
    const headers = call.init.headers as Record<string, string>;
    assert.ok(
      headers["Idempotency-Key"],
      "genera clave si el modelo no la pasa",
    );
    assert.match(headers["Idempotency-Key"], /^[0-9a-f-]{36}$/i);
    assert.equal(
      call.body.idempotencyKey,
      undefined,
      "idempotencyKey no va en el body (schema strict del Manager)",
    );
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Mapeo de errores 403/409
// ---------------------------------------------------------------------------

test("schedule_trigger mapea 409 TRIGGER_LIMIT_REACHED a texto code+message", async () => {
  const mock = installMockFetch(
    () =>
      new Response(
        JSON.stringify({
          code: "TRIGGER_LIMIT_REACHED",
          message: "Active agent trigger limit reached",
          correlationId: "c",
        }),
        { status: 409 },
      ),
  );
  try {
    const tool = createAgentTools(ENV, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "x",
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.equal(
      text,
      "TRIGGER_LIMIT_REACHED: Active agent trigger limit reached",
    );
  } finally {
    mock.restore();
  }
});

test("schedule_trigger mapea 403 AUTONOMY_DISABLED a texto code+message", async () => {
  const mock = installMockFetch(
    () =>
      new Response(
        JSON.stringify({
          code: "AUTONOMY_DISABLED",
          message: "Autonomous trigger creation is disabled",
          correlationId: "c",
        }),
        { status: 403 },
      ),
  );
  try {
    const tool = createAgentTools(ENV, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "x",
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.equal(
      text,
      "AUTONOMY_DISABLED: Autonomous trigger creation is disabled",
    );
  } finally {
    mock.restore();
  }
});

test("manager inaccesible (fetch throws) se mapea a INTERNAL_ERROR legible", async () => {
  const mock = installMockFetch(() => {
    throw new Error("connection refused");
  });
  try {
    const tool = createAgentTools(ENV, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "x",
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(
      text,
      /^INTERNAL_ERROR: Manager inaccesible: connection refused$/,
    );
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 2b. Integration (real HTTP): the tool forwards the service credential as a
// Bearer Authorization header to satisfy the Manager's auth middleware. This
// guards the runtime env wiring (runnerEnvFor must inject API_TOKEN so
// env.apiToken is populated in the runner), not just the mocked unit path.
// ---------------------------------------------------------------------------

async function startMockManager(): Promise<{
  server: Server;
  port: number;
  seenAuthorization: () => string | undefined;
  close: () => Promise<void>;
}> {
  let seen: string | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen = (req.headers.authorization as string | undefined) ?? undefined;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          trigger: { id: "trig-int", nextFireAt: 1234567890000 },
          replayed: false,
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock manager address unexpectedly missing");
  }
  return {
    server,
    port: address.port,
    seenAuthorization: () => seen,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("schedule_trigger envía el header Authorization Bearer a un Manager real y parsea el 201", async () => {
  const manager = await startMockManager();
  try {
    const env = {
      dataDir: "/data",
      managerPort: manager.port,
      apiToken: "real-integration-token",
    } as never;
    const tool = createAgentTools(env, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "x",
    });
    assert.equal(manager.seenAuthorization(), "Bearer real-integration-token");
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /Trigger scheduled \(id: trig-int, next fire: /);
  } finally {
    await manager.close();
  }
});

test("schedule_trigger sin apiToken NO envía el header Authorization (degradado tolerante)", async () => {
  const manager = await startMockManager();
  try {
    const env = {
      dataDir: "/data",
      managerPort: manager.port,
      apiToken: "",
    } as never;
    const tool = createAgentTools(env, "writer")[1];
    const result = await callSchedule(tool, {
      schedule: SCHEDULE,
      intent: "x",
    });
    assert.equal(manager.seenAuthorization(), undefined);
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /Trigger scheduled \(id: trig-int/);
  } finally {
    await manager.close();
  }
});

// ---------------------------------------------------------------------------
// 5. revoke_trigger
// ---------------------------------------------------------------------------

test("revoke_trigger llama al POST de revoke con identidad, sin idempotency, y texto de éxito", async () => {
  const mock = installMockFetch(
    () =>
      new Response(JSON.stringify({ trigger: { id: "trig-9" } }), {
        status: 200,
      }),
  );
  try {
    const tools = createAgentTools(ENV, "writer");
    const revoke = tools.find((t) => t.name === REVOKE_TRIGGER_TOOL_NAME)!;
    const result = await revoke.execute("call-1", {
      triggerId: "trig-9",
    } as never);
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(
      call.url,
      "http://127.0.0.1:4000/api/v1/agents/writer/triggers/trig-9/revoke",
    );
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["X-Pihub-Agent"], "writer");
    assert.equal(headers["X-Pihub-Principal"], "runner");
    assert.equal(headers.authorization, "Bearer TEST_TOKEN");
    assert.equal(
      headers["Idempotency-Key"],
      undefined,
      "revoke no exige idempotency",
    );
    assert.deepEqual(call.body, {});
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.equal(text, "Trigger trig-9 revoked");
  } finally {
    mock.restore();
  }
});

test("revoke_trigger mapea 404 TRIGGER_NOT_FOUND a texto code+message", async () => {
  const mock = installMockFetch(
    () =>
      new Response(
        JSON.stringify({
          code: "TRIGGER_NOT_FOUND",
          message: "Trigger not found",
          correlationId: "c",
        }),
        {
          status: 404,
        },
      ),
  );
  try {
    const tools = createAgentTools(ENV, "writer");
    const revoke = tools.find((t) => t.name === REVOKE_TRIGGER_TOOL_NAME)!;
    const result = await revoke.execute("call-1", {
      triggerId: "nope",
    } as never);
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.equal(text, "TRIGGER_NOT_FOUND: Trigger not found");
  } finally {
    mock.restore();
  }
});
