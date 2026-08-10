// T01.03 — Contract Red tests para `/api/v1` del Manager.
//
// Estos tests afirman el comportamiento OBJETIVO descrito en
// docs/manager-api-v1.md, no el comportamiento actual. Deben fallar hoy
// porque la interfaz versionada y el error envelope todavía no existen;
// la MISMA suite, sin editar, debe pasar a verde cuando H01.01/H01.02 la
// implementen (Red → Green real, no una descripción de la ausencia).
//
// Requiere un Manager real arrancado y accesible (docker compose up),
// igual que el resto de suites de contrato del roadmap. Variables:
//   MANAGER_URL — default http://127.0.0.1:4000
//   API_TOKEN   — credencial de servicio actual del Manager en ejecución
//                 (se lee de esta env var o, si falta, del .env del repo;
//                 nunca se hardcodea ni se loguea).
//
// Ejecutar con: npm run test:contract-red

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://127.0.0.1:4000";
// The contract is Provider-agnostic; local verification may inject a deterministic seam.
const CONTRACT_MODEL = process.env.PIHUB_CONTRACT_MODEL ?? "anthropic/claude-sonnet-5";

function loadApiToken(): string {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;

  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  try {
    const raw = readFileSync(envPath, "utf8");
    const match = raw.match(/^API_TOKEN=(.*)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // handled below
  }

  throw new Error(
    "API_TOKEN no disponible: exporta API_TOKEN o arranca el Manager con " +
      "`docker compose up` (lee .env) antes de correr esta suite.",
  );
}

let VALID_TOKEN: string;
let UPLOAD_AGENT: string;
let TURN_AGENT: string;
let TURN_AGENT_CREATION: Promise<void> | undefined;
let DEFAULT_AGENT: string;
let PANEL_COOKIE: string;
let PANEL_CSRF: string;
let AUTONOMY_AGENT: string;
let JOURNEY_AGENT: string | undefined;

function headerCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
}

async function loginPanel(): Promise<void> {
  const response = await fetch(new URL("/auth/session", MANAGER_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: VALID_TOKEN }),
  });
  const rawText = await response.text();
  assert.strictEqual(response.status, 200, `login de panel falló: ${rawText}`);
  const body = JSON.parse(rawText) as { ok?: boolean; csrfToken?: string };
  assert.strictEqual(body.ok, true);
  assert.ok(body.csrfToken);

  const cookies = headerCookies(response);
  const session = cookies.find((cookie) => cookie.startsWith("pihub_token="));
  const csrf = cookies.find((cookie) => cookie.startsWith("pihub_csrf="));
  assert.ok(session, "login no emitió pihub_token");
  assert.ok(csrf, "login no emitió pihub_csrf");
  PANEL_COOKIE = `${session!.split(";", 1)[0]}; ${csrf!.split(";", 1)[0]}`;
  PANEL_CSRF = body.csrfToken;
}

async function panelRequest(
  path: string,
  options: { method?: string; body?: unknown; origin?: string; headersExtra?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Cookie: PANEL_COOKIE,
    "Content-Type": "application/json",
  };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["X-CSRF-Token"] = PANEL_CSRF;
  }
  if (options.origin) headers.Origin = options.origin;
  if (options.headersExtra) Object.assign(headers, options.headersExtra);

  const response = await fetch(new URL(path, MANAGER_URL), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const rawText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }
  return { status: response.status, body, rawText };
}

async function panelUploadRequest(path: string): Promise<{ status: number; body: unknown; rawText: string }> {
  const form = new FormData();
  form.append("file", new File(["audio"], "voice.webm", { type: "audio/webm" }));
  const response = await fetch(new URL(path, MANAGER_URL), {
    method: "POST",
    headers: { Cookie: PANEL_COOKIE, "X-CSRF-Token": PANEL_CSRF },
    body: form,
  });
  const rawText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }
  return { status: response.status, body, rawText };
}

before(async () => {
  VALID_TOKEN = loadApiToken();
  await loginPanel();
  UPLOAD_AGENT = `h09-upload-${Date.now()}`;
  const created = await request("/api/v1/agents", {
    method: "POST",
    body: { name: UPLOAD_AGENT, model: CONTRACT_MODEL },
  });
  assert.strictEqual(created.status, 201, `no se pudo crear el Agent de H09: ${created.rawText}`);

  AUTONOMY_AGENT = `p27-autonomy-${Date.now()}`;
  const autoCreated = await request("/api/v1/agents", {
    method: "POST",
    body: { name: AUTONOMY_AGENT, model: CONTRACT_MODEL },
  });
  assert.strictEqual(autoCreated.status, 201, `no se pudo crear el Agent de P2.7: ${autoCreated.rawText}`);
  DEFAULT_AGENT = `h09-default-${Date.now()}`;
  const defaultCreated = await request("/api/v1/agents", {
    method: "POST",
    body: { name: DEFAULT_AGENT },
  });
  assert.strictEqual(defaultCreated.status, 201, `no se pudo crear Agent sin model: ${defaultCreated.rawText}`);
});

after(async () => {
  if (DEFAULT_AGENT) await request(`/api/v1/agents/${DEFAULT_AGENT}`, { method: "DELETE" });
  if (TURN_AGENT) await request(`/api/v1/agents/${TURN_AGENT}`, { method: "DELETE" });
  if (UPLOAD_AGENT) await request(`/api/v1/agents/${UPLOAD_AGENT}`, { method: "DELETE" });
  if (AUTONOMY_AGENT) await request(`/api/v1/agents/${AUTONOMY_AGENT}`, { method: "DELETE" });
  if (JOURNEY_AGENT) await request(`/api/v1/agents/${JOURNEY_AGENT}`, { method: "DELETE" });
});

async function uploadRequest(
  path: string,
  options: { auth?: "valid" | "invalid" | "none" } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const headers: Record<string, string> = {};
  const auth = options.auth ?? "valid";
  if (auth === "valid") headers.Authorization = `Bearer ${VALID_TOKEN}`;
  if (auth === "invalid") headers.Authorization = "Bearer this-token-is-not-valid";

  const form = new FormData();
  form.append("file", new File(["informe"], "informe.csv", { type: "text/csv" }));
  const res = await fetch(new URL(path, MANAGER_URL), {
    method: "POST",
    headers,
    body: form,
  });
  const rawText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }
  return { status: res.status, body, rawText };
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; auth?: "valid" | "invalid" | "none"; headersExtra?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = options.auth ?? "valid";
  if (auth === "valid") headers["Authorization"] = `Bearer ${VALID_TOKEN}`;
  if (auth === "invalid") headers["Authorization"] = "Bearer this-token-is-not-valid";
  if (options.headersExtra) Object.assign(headers, options.headersExtra);

  const res = await fetch(new URL(path, MANAGER_URL), {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const rawText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }

  return { status: res.status, body, rawText };
}

interface ContractSseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function ensureTurnAgent(): Promise<void> {
  if (TURN_AGENT_CREATION) return TURN_AGENT_CREATION;
  TURN_AGENT_CREATION = (async () => {
    if (!TURN_AGENT) {
      TURN_AGENT = `h09-turn-${Date.now()}`;
      const created = await request("/api/v1/agents", {
        method: "POST",
        body: {
          name: TURN_AGENT,
          model: CONTRACT_MODEL,
          thinkingLevel: "low",
        },
      });
      assert.strictEqual(created.status, 201, `no se pudo crear el Agent de turnos: ${created.rawText}`);
    }
    await waitForAgentRunning(TURN_AGENT);
  })();
  return TURN_AGENT_CREATION;
}

async function waitForAgentRunning(agent: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await request(`/api/v1/agents/${agent}`);
    if (result.status === 200 && (result.body as { status?: string }).status === "running") {
      const commands = await request(`/api/v1/agents/${agent}/commands`);
      if (commands.status === 200) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent ${agent} no llegó a running antes del turno`);
}

async function streamTurn(
  agent: string,
  options: {
    turnId: string;
    idempotencyKey: string;
    message: string;
    eventProfile?: "basic" | "verbose";
    abort?: boolean;
  },
): Promise<ContractSseEvent[]> {
  await waitForAgentRunning(agent);
  const suffix = options.eventProfile ? `?eventProfile=${options.eventProfile}` : "";
  const response = await fetch(new URL(`/api/v1/agents/${agent}/turns${suffix}`, MANAGER_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionKey: "contract-red-session",
      turnId: options.turnId,
      idempotencyKey: options.idempotencyKey,
      correlationId: `contract-red-${options.turnId}`,
      message: options.message,
    }),
  });
  if (response.status !== 200) {
    throw new Error(`turno no abrió SSE: ${await response.text()}`);
  }
  if (!response.body) throw new Error("Manager devolvió un turno sin body SSE");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ContractSseEvent[] = [];
  let pending = "";
  let abortSent = false;

  const consumeBlock = async (block: string): Promise<void> => {
    const eventName = block.match(/^event: (.+)$/m)?.[1];
    const dataLines = [...block.matchAll(/^data: (.*)$/gm)].map((match) => match[1]);
    if (!eventName || dataLines.length === 0) return;

    const event: ContractSseEvent = {
      event: eventName,
      data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
    };
    events.push(event);

    if (options.abort && !abortSent && event.event === "turn-start") {
      const result = await request(`/api/v1/agents/${agent}/turns/${options.turnId}/abort`, {
        method: "POST",
      });
      assert.strictEqual(result.status, 202, `abort no aceptado: ${result.rawText}`);
      abortSent = true;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) pending += decoder.decode(value, { stream: !done });
    pending = pending.replace(/\r\n/g, "\n");
    let separator = pending.indexOf("\n\n");
    while (separator >= 0) {
      const block = pending.slice(0, separator);
      pending = pending.slice(separator + 2);
      await consumeBlock(block);
      separator = pending.indexOf("\n\n");
    }
    if (done) break;
  }

  assert.ok(events.length > 0, "el SSE del turno no publicó eventos");
  if (options.abort) assert.equal(abortSent, true, "el abort no llegó a un turno vivo");
  return events;
}

/** Spec §7: ningún response debe filtrar paths, puertos de Runner o el token. */
function assertNoInternalsLeaked(rawText: string) {
  assert.doesNotMatch(rawText, /\/data\b/, "no debe exponer el path de datos interno");
  assert.doesNotMatch(rawText, /\b41\d{2}\b/, "no debe exponer puertos de Runner (4100-4199)");
  assert.doesNotMatch(rawText, new RegExp(VALID_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no debe exponer el token de servicio");
}

describe("T01.03 — Contract Red: /api/v1 (spec docs/manager-api-v1.md)", () => {
  describe("§3.3 — Service auth", () => {
    it("sin credencial responde 401 con {code: MISSING_AUTH, correlationId}", async () => {
      const { status, body, rawText } = await request("/api/status", { auth: "none" });

      assert.strictEqual(status, 401);
      assert.strictEqual(
        (body as { code?: string }).code,
        "MISSING_AUTH",
        `esperaba code MISSING_AUTH, respuesta actual: ${rawText}`,
      );
      assert.ok((body as { correlationId?: string }).correlationId, "falta correlationId");
    });

    it("con credencial inválida responde 401 con {code: INVALID_AUTH}", async () => {
      const { status, body, rawText } = await request("/api/status", { auth: "invalid" });

      assert.strictEqual(status, 401);
      assert.strictEqual(
        (body as { code?: string }).code,
        "INVALID_AUTH",
        `esperaba code INVALID_AUTH (distinto de MISSING_AUTH), respuesta actual: ${rawText}`,
      );
    });
  });

  describe("§4.2 — Health y Readiness", () => {
    it("GET /api/v1/health responde 200 con {status: ok, version, timestamp}", async () => {
      const { status, body, rawText } = await request("/api/v1/health");

      assert.strictEqual(status, 200, `todavía no existe /api/v1: ${rawText}`);
      const parsed = body as { status?: string; version?: string; timestamp?: string };
      assert.strictEqual(parsed.status, "ok");
      assert.ok(parsed.version);
      assert.ok(parsed.timestamp);
    });

    it("GET /api/v1/readiness responde 200 con {status, checks: []}", async () => {
      const { status, body, rawText } = await request("/api/v1/readiness");

      assert.strictEqual(status, 200, `todavía no existe /api/v1: ${rawText}`);
      assert.ok(Array.isArray((body as { checks?: unknown[] }).checks));
    });
  });

  describe("§4.3 — Agents", () => {
    it("GET /api/v1/agents responde 200 con un array", async () => {
      const { status, body, rawText } = await request("/api/v1/agents");

      assert.strictEqual(status, 200, `todavía no existe /api/v1/agents: ${rawText}`);
      assert.ok(Array.isArray(body));
    });

    it("POST /api/v1/agents con body inválido responde 400 con {code: BAD_REQUEST}", async () => {
      const { status, body, rawText } = await request("/api/v1/agents", {
        method: "POST",
        body: {},
      });

      assert.strictEqual(status, 400, `todavía no existe /api/v1/agents: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "BAD_REQUEST");
    });

    it("DELETE /api/v1/agents/:name inexistente responde 404 con {code: AGENT_NOT_FOUND}", async () => {
      const { status, body, rawText } = await request("/api/v1/agents/does-not-exist-xyz", {
        method: "DELETE",
      });

      assert.strictEqual(status, 404, `respuesta actual: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "AGENT_NOT_FOUND");
      assertNoInternalsLeaked(rawText);
    });
  });

  describe("§4.4 — Sesiones", () => {
    it("POST /api/v1/agents/:name/sessions con agente inexistente responde 404 AGENT_NOT_FOUND", async () => {
      const { status, body, rawText } = await request(
        "/api/v1/agents/does-not-exist-xyz/sessions",
        { method: "POST", body: { channel: "web", sessionKey: "test-key" } },
      );

      assert.strictEqual(status, 404, `todavía no existe /api/v1/.../sessions: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "AGENT_NOT_FOUND");
    });
  });

  describe("§4.6 — Subida de ficheros", () => {
    it("POST /api/v1/agents/:name/uploads devuelve el fichero con path relativo al workspace", async () => {
      let result = await uploadRequest(`/api/v1/agents/${UPLOAD_AGENT}/uploads`);
      for (let attempt = 0; attempt < 30 && result.status === 503; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = await uploadRequest(`/api/v1/agents/${UPLOAD_AGENT}/uploads`);
      }

      assert.strictEqual(result.status, 200, `respuesta actual: ${result.rawText}`);
      const body = result.body as { path?: string; name?: string; size?: number; type?: string };
      assert.equal(body.name, "informe.csv");
      assert.equal(body.size, 7);
      assert.equal(body.type, "text/csv");
      assert.match(body.path ?? "", /^uploads\/[0-9]+-informe\.csv$/);
      assert.doesNotMatch(body.path ?? "", /^\//);
      assertNoInternalsLeaked(result.rawText);
    });

    it("un Agent inexistente responde AGENT_NOT_FOUND antes de leer el multipart", async () => {
      const { status, body, rawText } = await uploadRequest("/api/v1/agents/does-not-exist-xyz/uploads");

      assert.strictEqual(status, 404, `respuesta actual: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "AGENT_NOT_FOUND");
    });
  });

  describe("§4.5 y §5 — Turnos: campos obligatorios", () => {
    it("POST /api/v1/agents/:name/turns sin turnId/idempotencyKey/correlationId responde 400", async () => {
      const { status, body, rawText } = await request(
        "/api/v1/agents/does-not-exist-xyz/turns",
        { method: "POST", body: { sessionKey: "test-key", message: "hola" } },
      );

      assert.strictEqual(status, 400, `todavía no existe /api/v1/.../turns: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "BAD_REQUEST");
    });
  });

  describe("§3.1 — Rotación de credencial", () => {
    it("POST /api/v1/auth/rotate existe como ruta autenticada", async () => {
      const { status, rawText } = await request("/api/v1/auth/rotate", {
        method: "POST",
        body: { oldToken: VALID_TOKEN, newToken: "placeholder-new-token-1234567890" },
      });

      assert.notStrictEqual(status, 404, `la ruta de rotación todavía no existe: ${rawText}`);
    });
  });

  // --- Fase 1 (2026-07-29): paridad panel↔/api/v1. Los 4 bugs originales
  // eran invisibles para los tests unitarios porque los fakes registran la
  // llamada, no reinician nada de verdad — solo un Manager real lo prueba.

  describe("§4.3 — GET /api/v1/agents/:name (bug 4)", () => {
    it("existe y trae systemPrompt/envKeys/packages; el listado NO los lleva", async () => {
      const { status, body, rawText } = await request(`/api/v1/agents/${UPLOAD_AGENT}`);

      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      const parsed = body as { systemPrompt?: unknown; envKeys?: unknown; packages?: unknown };
      assert.ok("systemPrompt" in parsed, "falta systemPrompt en GET de un Agent");
      assert.ok(Array.isArray(parsed.envKeys), "envKeys debe ser un array");
      assert.ok(Array.isArray(parsed.packages), "packages debe ser un array");
      assertNoInternalsLeaked(rawText);

      const list = await request("/api/v1/agents");
      assert.doesNotMatch(list.rawText, /systemPrompt/, "el listado no debe llevar systemPrompt");
    });

    it("de un Agent inexistente responde 404 AGENT_NOT_FOUND", async () => {
      const { status, body } = await request("/api/v1/agents/does-not-exist-xyz");
      assert.strictEqual(status, 404);
      assert.strictEqual((body as { code?: string }).code, "AGENT_NOT_FOUND");
    });
  });

  describe("§4.3 — PATCH /api/v1/agents/:name (bugs 1 y 2, huella de arranque)", () => {
    it("reconciliar el MISMO estado dos veces no rompe nada y el Agent sigue running", async () => {
      const first = await request(`/api/v1/agents/${UPLOAD_AGENT}`, {
        method: "PATCH",
        body: { model: "anthropic/claude-sonnet-5" },
      });
      assert.strictEqual(first.status, 200, `respuesta actual: ${first.rawText}`);

      // Mismo body otra vez: la huella no cambió, no debería reiniciar —
      // si reiniciara en bucle, el Agent no llegaría nunca a "running"
      // (bug 1 generalizado: reconciliar en cada llamada no debe tumbar
      // el Runner una y otra vez).
      const second = await request(`/api/v1/agents/${UPLOAD_AGENT}`, {
        method: "PATCH",
        body: { model: "anthropic/claude-sonnet-5" },
      });
      assert.strictEqual(second.status, 200, `respuesta actual: ${second.rawText}`);
      const parsed = second.body as { status?: string };
      assert.strictEqual(parsed.status, "running", `el Agent no volvió a running: ${second.rawText}`);
    });

    it("{enabled:false} para el proceso de verdad (bug 2)", async () => {
      const stopAgent = `h-lifecycle-${Date.now()}`;
      const created = await request("/api/v1/agents", {
        method: "POST",
        body: { name: stopAgent, model: "anthropic/claude-sonnet-5" },
      });
      assert.strictEqual(created.status, 201, `no se pudo crear el Agent: ${created.rawText}`);

      try {
        const patched = await request(`/api/v1/agents/${stopAgent}`, {
          method: "PATCH",
          body: { enabled: false },
        });
        assert.strictEqual(patched.status, 200, `respuesta actual: ${patched.rawText}`);
        assert.strictEqual(
          (patched.body as { status?: string }).status,
          "stopped",
          `el proceso debía parar de verdad: ${patched.rawText}`,
        );
      } finally {
        await request(`/api/v1/agents/${stopAgent}`, { method: "DELETE" });
      }
    });
  });

  describe("§4.3b — Env del Agent", () => {
    it("PUT reemplaza el conjunto y GET devuelve solo las claves", async () => {
      const put = await request(`/api/v1/agents/${UPLOAD_AGENT}/env`, {
        method: "PUT",
        body: { env: { CONTRACT_RED_VAR: "valor-secreto" } },
      });
      assert.strictEqual(put.status, 200, `respuesta actual: ${put.rawText}`);
      assert.doesNotMatch(put.rawText, /valor-secreto/, "no debe exponer el valor");

      const get = await request(`/api/v1/agents/${UPLOAD_AGENT}/env`);
      assert.deepStrictEqual((get.body as { keys?: string[] }).keys, ["CONTRACT_RED_VAR"]);
      assert.doesNotMatch(get.rawText, /valor-secreto/);
    });
  });

  describe("§4.3c — Paquetes del Agent", () => {
    it("GET responde 200 con un array (la instalación real se prueba en smoke:t12)", async () => {
      const { status, body, rawText } = await request(`/api/v1/agents/${UPLOAD_AGENT}/packages`);
      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      assert.ok(Array.isArray((body as { packages?: unknown }).packages));
    });
  });

  describe("§4.3d — Ciclo de vida explícito", () => {
    it("stop para el proceso y start lo vuelve a arrancar", async () => {
      const stopped = await request(`/api/v1/agents/${UPLOAD_AGENT}/stop`, { method: "POST" });
      assert.strictEqual(stopped.status, 200, `respuesta actual: ${stopped.rawText}`);
      assert.strictEqual((stopped.body as { status?: string }).status, "stopped");

      const started = await request(`/api/v1/agents/${UPLOAD_AGENT}/start`, { method: "POST" });
      assert.strictEqual(started.status, 200, `respuesta actual: ${started.rawText}`);
      assert.strictEqual((started.body as { status?: string }).status, "running");
    });
  });

  describe("§4.5 — Abortar un turno", () => {
    it("un turno que no existe responde 404 TURN_NOT_FOUND", async () => {
      const { status, body, rawText } = await request(
        `/api/v1/agents/${UPLOAD_AGENT}/turns/no-existe/abort`,
        { method: "POST" },
      );
      assert.strictEqual(status, 404, `respuesta actual: ${rawText}`);
      assert.strictEqual((body as { code?: string }).code, "TURN_NOT_FOUND");
    });
  });

  describe("§4.7 — Modelos disponibles", () => {
    it("GET /api/v1/models responde 200 con {models: []}", async () => {
      const { status, body, rawText } = await request("/api/v1/models");
      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      assert.ok(Array.isArray((body as { models?: unknown }).models));
    });
  });

  describe("§4.8 — Estado global", () => {
    it("GET /api/v1/status responde 200 sin portRange (spec §7)", async () => {
      const { status, body, rawText } = await request("/api/v1/status");
      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      assert.ok(!("portRange" in (body as object)), "no debe exponer portRange");
      assertNoInternalsLeaked(rawText);
    });
  });

  describe("Release A — auth de cookie + CSRF contra Manager real", () => {
    it("login emite la cookie de sesión y el token CSRF", () => {
      assert.match(PANEL_COOKIE, /pihub_token=[^;]+/);
      assert.match(PANEL_COOKIE, /pihub_csrf=[^;]+/);
      assert.match(PANEL_CSRF, /^[0-9a-f]{64}$/);
    });

    it("GET /api/v1/status acepta la cookie sin CSRF", async () => {
      const { status, body, rawText } = await panelRequest("/api/v1/status");
      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      assert.ok(!("portRange" in (body as object)));
    });

    it("PATCH autenticado con cookie y CSRF llega al Manager", async () => {
      const result = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}`, {
        method: "PATCH",
        body: {},
      });
      assert.strictEqual(result.status, 200, `respuesta actual: ${result.rawText}`);
    });

    it("POST de turno autenticado con cookie y CSRF llega a validar el payload", async () => {
      // El body deliberadamente incompleto evita arrancar una inferencia real:
      // este contrato prueba la puerta de auth, no el transporte de turnos.
      const result = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/turns`, {
        method: "POST",
        body: { message: "auth contract" },
      });
      assert.strictEqual(result.status, 400, `respuesta actual: ${result.rawText}`);
      assert.strictEqual((result.body as { code?: string }).code, "BAD_REQUEST");
    });
  });

  describe("Red 2 — superficie panel en /api/v1 contra Manager real", () => {
    const packageSource = "npm:@earendil-works/pi-coding-agent@0.80.3";

    it("GET commands devuelve skills y prompts del Runner", async () => {
      const result = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/commands`);
      assert.strictEqual(result.status, 200, `respuesta actual: ${result.rawText}`);
      assert.ok(Array.isArray((result.body as { skills?: unknown }).skills));
      assert.ok(Array.isArray((result.body as { prompts?: unknown }).prompts));
    });

    it("POST transcribe conserva 501 cuando el Runtime no tiene STT", async () => {
      const result = await panelUploadRequest(`/api/v1/agents/${UPLOAD_AGENT}/transcribe`);
      assert.strictEqual(result.status, 501, `respuesta actual: ${result.rawText}`);
    });

    it("env del Agent permite PUT/GET/DELETE por clave sin devolver valores", async () => {
      const put = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/env/RED2_AGENT_KEY`, {
        method: "PUT",
        body: { value: "red2-secret" },
      });
      assert.strictEqual(put.status, 200, `respuesta actual: ${put.rawText}`);
      assert.doesNotMatch(put.rawText, /red2-secret/);

      const get = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/env`);
      assert.strictEqual(get.status, 200);
      assert.deepStrictEqual((get.body as { keys?: string[] }).keys, ["CONTRACT_RED_VAR", "RED2_AGENT_KEY"]);
      assert.doesNotMatch(get.rawText, /red2-secret/);

      const remove = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/env/RED2_AGENT_KEY`, {
        method: "DELETE",
      });
      assert.strictEqual(remove.status, 200, `respuesta actual: ${remove.rawText}`);
      assert.doesNotMatch(remove.rawText, /red2-secret/);
    });

    it("env global permite GET/PUT/DELETE por clave y queda separado del Agent", async () => {
      const put = await panelRequest("/api/v1/env/RED2_GLOBAL_KEY", {
        method: "PUT",
        body: { value: "global-secret" },
      });
      assert.strictEqual(put.status, 200, `respuesta actual: ${put.rawText}`);
      assert.doesNotMatch(put.rawText, /global-secret/);

      const get = await panelRequest("/api/v1/env");
      assert.strictEqual(get.status, 200);
      const globalKeys = (get.body as { keys?: string[] }).keys ?? [];
      assert.ok(globalKeys.includes("RED2_GLOBAL_KEY"));
      assert.ok(!globalKeys.includes("CONTRACT_RED_VAR"));
      assert.doesNotMatch(get.rawText, /global-secret|agent-secret/);

      const remove = await panelRequest("/api/v1/env/RED2_GLOBAL_KEY", { method: "DELETE" });
      assert.strictEqual(remove.status, 200, `respuesta actual: ${remove.rawText}`);
      assert.ok(!((remove.body as { keys?: string[] }).keys ?? []).includes("RED2_GLOBAL_KEY"));
    });

    it("packages GET/POST/DELETE por item del Agent funcionan con el pi real", async () => {
      const list = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/packages`);
      assert.strictEqual(list.status, 200);
      assert.ok(Array.isArray((list.body as { packages?: unknown }).packages));

      const added = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/packages`, {
        method: "POST",
        body: { source: packageSource },
      });
      assert.strictEqual(added.status, 202, `respuesta actual: ${added.rawText}`);

      const removed = await panelRequest(`/api/v1/agents/${UPLOAD_AGENT}/packages`, {
        method: "DELETE",
        body: { source: packageSource },
      });
      assert.strictEqual(removed.status, 202, `respuesta actual: ${removed.rawText}`);
    });

    it("packages global GET/POST/DELETE por item funcionan con el pi real", async () => {
      const list = await panelRequest("/api/v1/packages");
      assert.strictEqual(list.status, 200);
      assert.ok(Array.isArray((list.body as { packages?: unknown }).packages));

      const added = await panelRequest("/api/v1/packages", {
        method: "POST",
        body: { source: packageSource },
      });
      assert.strictEqual(added.status, 202, `respuesta actual: ${added.rawText}`);

      const removed = await panelRequest("/api/v1/packages", {
        method: "DELETE",
        body: { source: packageSource },
      });
      assert.strictEqual(removed.status, 202, `respuesta actual: ${removed.rawText}`);
    });

    it("Skills por contenido local persisten por skillId, recargan el Runner y no filtran paths", async () => {
      const skillId = randomUUID();
      const v1 = `content-skill-v1-${skillId.slice(0, 8)}`;
      const v2 = `content-skill-v2-${skillId.slice(0, 8)}`;
      const skill = (name: string, description: string) => ({
        skillId,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
          },
          { path: "references/guide.md", content: `# ${name}\n` },
        ],
      });

      const installed = await request(`/api/v1/agents/${UPLOAD_AGENT}/skills`, {
        method: "POST",
        body: skill(v1, "primera versión"),
      });
      assert.strictEqual(installed.status, 202, `instalación de Skill: ${installed.rawText}`);
      assert.deepStrictEqual((installed.body as { skills?: unknown }).skills, [skillId]);
      assert.doesNotMatch(installed.rawText, /imported-skills|\/data\//);

      await eventually(async () => {
        const commands = await request(`/api/v1/agents/${UPLOAD_AGENT}/commands`);
        const skills = (commands.body as { skills?: Array<{ name?: string }> }).skills ?? [];
        assert.ok(skills.some((entry) => entry.name === v1), `commands actual: ${commands.rawText}`);
      });

      const updated = await request(`/api/v1/agents/${UPLOAD_AGENT}/skills`, {
        method: "POST",
        body: skill(v2, "segunda versión"),
      });
      assert.strictEqual(updated.status, 202, `actualización de Skill: ${updated.rawText}`);
      assert.deepStrictEqual((updated.body as { skills?: unknown }).skills, [skillId]);

      await eventually(async () => {
        const commands = await request(`/api/v1/agents/${UPLOAD_AGENT}/commands`);
        const skills = (commands.body as { skills?: Array<{ name?: string }> }).skills ?? [];
        assert.ok(skills.some((entry) => entry.name === v2), `commands actual: ${commands.rawText}`);
        assert.ok(!skills.some((entry) => entry.name === v1), `Skill previa aún cargada: ${commands.rawText}`);
      });

      const removed = await request(`/api/v1/agents/${UPLOAD_AGENT}/skills/${skillId}`, { method: "DELETE" });
      assert.strictEqual(removed.status, 202, `eliminación de Skill: ${removed.rawText}`);
      assert.deepStrictEqual((removed.body as { skills?: unknown }).skills, []);
    });

    it("OAuth providers está disponible como extensión panel/operator", async () => {
      const result = await panelRequest("/api/v1/auth/providers");
      assert.strictEqual(result.status, 200, `respuesta actual: ${result.rawText}`);
      assert.ok(Array.isArray((result.body as { providers?: unknown }).providers));
    });

    it("crear un Agent sin model explícito aplica el default de pihub", async () => {
      const result = await request(`/api/v1/agents/${DEFAULT_AGENT}`);
      assert.strictEqual(result.status, 200, `respuesta actual: ${result.rawText}`);
      assert.ok((result.body as { model?: string }).model);
    });
  });

  describe("Red 3 — eventos y streaming contra Manager y Runner reales", { concurrency: false }, () => {
    it("eventProfile inválido responde 400 BAD_REQUEST sin abrir un turno", async () => {
      await ensureTurnAgent();
      const result = await request(`/api/v1/agents/${TURN_AGENT}/turns?eventProfile=diagnostic`, {
        method: "POST",
        body: {
          sessionKey: "contract-red-session",
          turnId: `invalid-profile-${Date.now()}-${TURN_AGENT}`,
          idempotencyKey: `invalid-profile-${Date.now()}`,
          correlationId: `invalid-profile-${Date.now()}`,
          message: "no ejecutar",
        },
      });
      assert.strictEqual(result.status, 400, `respuesta actual: ${result.rawText}`);
      assert.strictEqual((result.body as { code?: string }).code, "BAD_REQUEST");
    });

    it("basic conserva el vocabulario normal del turno y termina en turn-complete", async () => {
      await ensureTurnAgent();
      const events = await streamTurn(TURN_AGENT, {
        turnId: `basic-${Date.now()}`,
        idempotencyKey: `basic-${Date.now()}`,
        message: "Responde exactamente OK y nada más.",
      });
      assert.equal(events[0]?.event, "turn-start");
      assert.equal(events.at(-1)?.event, "turn-complete");
      assert.ok(events.some((event) => event.event === "chunk"), "faltó chunk en el turno basic");
      assert.ok(
        events.every((event) =>
          ["turn-start", "chunk", "turn-complete", "turn-error"].includes(event.event),
        ),
        "basic no debe publicar thinking/tools",
      );
      assert.deepStrictEqual(events.at(-1)?.data, {
        turnId: events.at(-1)?.data.turnId,
        totalTokens: 0,
      });
    });

    it("verbose conserva el turno y valida los shapes de thinking/tools si el Runner los produce", async () => {
      await ensureTurnAgent();
      const events = await streamTurn(TURN_AGENT, {
        turnId: `verbose-${Date.now()}`,
        idempotencyKey: `verbose-${Date.now()}`,
        eventProfile: "verbose",
        message: "Usa la herramienta read para leer package.json y después responde exactamente DONE.",
      });
      assert.equal(events[0]?.event, "turn-start");
      assert.equal(events.at(-1)?.event, "turn-complete");

      for (const event of events) {
        if (event.event === "thinking-delta") {
          assert.equal(typeof event.data.turnId, "string");
          assert.equal(typeof event.data.delta, "string");
        }
        if (event.event === "tool-start") {
          assert.equal(typeof event.data.turnId, "string");
          assert.equal(typeof event.data.toolName, "string");
          assert.doesNotMatch(String(event.data.toolName), /[\\/\\s]/);
        }
        if (event.event === "tool-end") {
          assert.equal(typeof event.data.turnId, "string");
          assert.equal(typeof event.data.toolName, "string");
          assert.equal(typeof event.data.isError, "boolean");
          assert.doesNotMatch(String(event.data.toolName), /[\\/\\s]/);
        }
      }
      assert.ok(
        events.every((event) =>
          [
            "turn-start",
            "chunk",
            "thinking-delta",
            "tool-start",
            "tool-end",
            "turn-complete",
            "turn-error",
          ].includes(event.event),
        ),
        "verbose publicó un evento fuera del contrato",
      );
    });

    it("abort real termina el SSE con turn-aborted y nunca con turn-complete", async () => {
      await ensureTurnAgent();
      const events = await streamTurn(TURN_AGENT, {
        turnId: `abort-${Date.now()}`,
        idempotencyKey: `abort-${Date.now()}`,
        abort: true,
        message:
          "Escribe una respuesta muy larga de al menos 2000 palabras sobre la historia de la computación y continúa hasta que te cancele.",
      });
      assert.equal(events.at(-1)?.event, "turn-aborted");
      assert.deepStrictEqual(events.at(-1)?.data, { turnId: events.at(-1)?.data.turnId });
      assert.equal(events.some((event) => event.event === "turn-complete"), false);
    });
  });

  // ---------------------------------------------------------------------------
  // P2.7 — Contrato real de Autonomía (Gobernador Bearer↔cookie)
  // ---------------------------------------------------------------------------
  //
  // Estas pruebas verifican que el conjunto ensamblado funciona de verdad:
  // snapshot, create trigger y revoke trigger, verificando que una mutación
  // hecha con Bearer se ve con cookie y viceversa.

  describe("P2.7 — Gobernador: Autonomía Bearer↔cookie", () => {
    const dailyTrigger = {
      definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
      intent: "revisar el estado",
      mode: "solo",
      suggestedSkill: null,
    };

    let createdTriggerId: string;

    it("GET /api/v1/agents/:name/autonomy con Bearer devuelve 200 con shape correcta", async () => {
      const { status, body, rawText } = await request(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`);
      assert.strictEqual(status, 200, `respuesta actual: ${rawText}`);
      const parsed = body as { asOf?: number; initiatives?: unknown[]; agenda?: unknown[]; inbox?: unknown[]; triggers?: unknown[]; historyTruncated?: boolean };
      assert.strictEqual(typeof parsed.asOf, "number");
      assert.ok(Array.isArray(parsed.initiatives));
      assert.ok(Array.isArray(parsed.agenda));
      assert.ok(Array.isArray(parsed.inbox));
      assert.ok(Array.isArray(parsed.triggers));
      assert.strictEqual(typeof parsed.historyTruncated, "boolean");
      assertNoInternalsLeaked(rawText);
    });

    it("GET /api/v1/agents/:name/autonomy con cookie devuelve idéntico asOf", async () => {
      const [bearerRes, cookieRes] = await Promise.all([
        request(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`),
        panelRequest(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`),
      ]);
      assert.strictEqual(bearerRes.status, 200, `Bearer: ${bearerRes.rawText}`);
      assert.strictEqual(cookieRes.status, 200, `Cookie: ${cookieRes.rawText}`);
      const bearer = bearerRes.body as { asOf?: number };
      const cookie = cookieRes.body as { asOf?: number };
      // Misma proyección, mismo asOf en el intervalo de la petición
      assert.strictEqual(bearer.asOf, cookie.asOf, "Bearer y cookie deben ver la misma Projection");
    });

    it("POST /api/v1/agents/:name/triggers con Bearer crea trigger y devuelve 201", async () => {
      const { status, body, rawText } = await request(`/api/v1/agents/${AUTONOMY_AGENT}/triggers`, {
        method: "POST",
        body: dailyTrigger,
        headersExtra: { "Idempotency-Key": `p27-create-${Date.now()}` },
      });
      assert.strictEqual(status, 201, `esperaba 201: ${rawText}`);
      const parsed = body as { trigger?: { id?: string }; replayed?: boolean };
      assert.ok(parsed.trigger?.id, "falta trigger.id");
      assert.strictEqual(parsed.replayed, false);
      createdTriggerId = parsed.trigger!.id;
      assertNoInternalsLeaked(rawText);
    });

    it("el trigger creado con Bearer es visible vía cookie", async () => {
      assert.ok(createdTriggerId, "precondición: trigger creado");
      const { status, body, rawText } = await panelRequest(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`);
      assert.strictEqual(status, 200, `cookie falló: ${rawText}`);
      const parsed = body as { triggers?: Array<{ id?: string; enabled?: boolean }> };
      const found = parsed.triggers?.find((t) => t.id === createdTriggerId);
      assert.ok(found, `trigger ${createdTriggerId} no visible vía cookie`);
      assert.strictEqual(found.enabled, true);
      assertNoInternalsLeaked(rawText);
    });

    it("POST /api/v1/agents/:name/triggers/:id/revoke con cookie revoca el trigger", async () => {
      assert.ok(createdTriggerId, "precondición: trigger creado");
      const { status, body, rawText } = await panelRequest(
        `/api/v1/agents/${AUTONOMY_AGENT}/triggers/${createdTriggerId}/revoke`,
        { method: "POST" },
      );
      assert.strictEqual(status, 200, `revoke falló: ${rawText}`);
      const parsed = body as { trigger?: { id?: string; enabled?: boolean } };
      assert.strictEqual(parsed.trigger?.id, createdTriggerId);
      assert.strictEqual(parsed.trigger?.enabled, false);
      assertNoInternalsLeaked(rawText);
    });

    it("trigger revocado con cookie se ve como disabled vía Bearer", async () => {
      assert.ok(createdTriggerId, "precondición: trigger creado");
      const { status, body, rawText } = await request(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`);
      assert.strictEqual(status, 200, `Bearer falló: ${rawText}`);
      const parsed = body as { triggers?: Array<{ id?: string; enabled?: boolean }> };
      const found = parsed.triggers?.find((t) => t.id === createdTriggerId);
      assert.ok(found, `trigger ${createdTriggerId} no visible vía Bearer tras revoke`);
      assert.strictEqual(found.enabled, false, "debe verse revocado");
    });

    it("ninguna respuesta contiene secretos internos (redacción)", async () => {
      // Revisar snapshot con ambas auth
      const [bearer, cookie] = await Promise.all([
        request(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`),
        panelRequest(`/api/v1/agents/${AUTONOMY_AGENT}/autonomy`),
      ]);
      assertNoInternalsLeaked(bearer.rawText);
      assertNoInternalsLeaked(cookie.rawText);

      // Verificar que no hay campos internos en la respuesta
      const bearerBody = JSON.stringify(bearer.body);
      const forbiddenPatterns = ["sessionKey", "turnId", "boundModel", "result", "definitionJson", "createIdempotencyKey", "createCommandHash"];
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(bearerBody, new RegExp(pattern), `Bearer no debe contener "${pattern}"`);
        assert.doesNotMatch(cookie.rawText, new RegExp(pattern), `Cookie no debe contener "${pattern}"`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // P2.7 — Gobernado: sin sesión, cookie no autoriza, Bearer sí
  // ---------------------------------------------------------------------------

  describe("P2.7 — Gobernado: sin sesión, cookie rechazada, Bearer funciona", () => {
    // En Gobernado (PIHUB_PANEL_ENABLED=false):
    //   - POST /auth/session da 404 sin Set-Cookie
    //   - Cookie antigua da 401 en /api/v1
    //   - Bearer funciona en GET autonomy

    it("POST /auth/session en Gobernado responde 404 sin Set-Cookie", { skip: true }, async () => {
      // Esta prueba requiere un Manager arrancado en modo Gobernado.
      // Ejecutar manualmente con:
      //   PIHUB_PANEL_ENABLED=false npm start
      // luego apuntar a ese MANAGER_URL.
      const response = await fetch(new URL("/auth/session", MANAGER_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN }),
      });
      assert.strictEqual(response.status, 404, "Gobernado no debe tener /auth/session");
      const cookies = response.headers as unknown as { getSetCookie?: () => string[] };
      const setCookie = cookies.getSetCookie?.() ?? [];
      assert.strictEqual(setCookie.length, 0, "no debe emitir Set-Cookie");
    });

    it("cookie antigua de panel no autoriza /api/v1 en Gobernado", { skip: true }, async () => {
      // Requiere Gobernado.
      const result = await panelRequest("/api/v1/agents");
      assert.strictEqual(result.status, 401, "cookie de panel no debe autorizar en Gobernado");
      assert.strictEqual(
        (result.body as { code?: string }).code,
        "INVALID_AUTH",
      );
    });

  // ---------------------------------------------------------------------------
  // P3.7 — Journey Governor contractual (black-box HTTP): Trigger → running →
  // Ask → inbox → respond panel → misma sesión → terminal.
  // ---------------------------------------------------------------------------
  //
  // Esta capa valida el contrato público y el journey observable contra un
  // Manager REAL arrancado en :4000 (Gobernador, panel activado). El modelo
  // real recibe un intent que le ordena llamar `ask_human` exactamente una
  // vez; `PIHUB_CONTRACT_MODEL` inyecta el seam determinista de la
  // verificación local (no es un modelo fake de dominio). Telegram no se
  // configura en esta capa (fail-closed A10): el panel sigue siendo operativo
  // y `notificationStatus` se proyecta sin coordenadas de delivery. Las
  // variantes Telegram fake (entregada + reply correlacionada, y fallo de
  // entrega) viven en la capa in-process `p3-journey.test.ts`.

  describe("P3.7 — Journey Governor: trigger → running → Ask → inbox → respond panel → terminal", { concurrency: false }, () => {
    const triggerTime = (): string => {
      // Próximo minuto civil en Europe/Madrid (el Loop dispara por
      // `next_fire_at` en cada tick de 1s).
      const civil = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Madrid",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(Date.now() + 120_000));
      const get = (type: string): string => civil.find((p) => p.type === type)?.value ?? "00";
      return `${get("hour")}:${get("minute")}`;
    };

    interface PublicInitiativeShape {
      id?: string;
      origin?: string;
      triggerId?: string | null;
      status?: string;
      question?: string | null;
      expiresAt?: number | null;
      notificationStatus?: "delivered" | "not_delivered" | null;
    }

    const initiativesOf = (body: unknown): PublicInitiativeShape[] =>
      ((body as { initiatives?: unknown[] }).initiatives ?? []) as PublicInitiativeShape[];

    /** Espera a que el snapshot tenga una Initiative del trigger con `status`. */
    const waitForStatus = async (
      agent: string,
      triggerId: string,
      status: string,
      timeoutMs: number,
    ): Promise<PublicInitiativeShape> => {
      const deadline = Date.now() + timeoutMs;
      let lastBody: unknown;
      for (;;) {
        const result = await request(`/api/v1/agents/${agent}/autonomy`);
        assert.strictEqual(result.status, 200, `snapshot del Agent falló: ${result.rawText}`);
        lastBody = result.body;
        const found = initiativesOf(result.body).find(
          (ini) => ini.triggerId === triggerId && ini.status === status,
        );
        if (found) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `timeout ${timeoutMs}ms: la Initiative del trigger ${triggerId} no llegó a ${status}; ` +
              `último snapshot: ${JSON.stringify(lastBody).slice(0, 400)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };

    it("P3 journey from trigger to terminal via the panel in the same session", async () => {
      // (0) Agent fresco del journey (modelo inyectado por PIHUB_CONTRACT_MODEL).
      JOURNEY_AGENT = `p37-journey-${Date.now()}`;
      const created = await request("/api/v1/agents", {
        method: "POST",
        body: { name: JOURNEY_AGENT, model: CONTRACT_MODEL, thinkingLevel: "low" },
      });
      assert.strictEqual(created.status, 201, `no se pudo crear el Agent del journey: ${created.rawText}`);
      await waitForAgentRunning(JOURNEY_AGENT);

      // (1) Trigger diario en el próximo minuto, mode ask, intent que ordena
      //     pedir aprobación humana con la tool ask_human (P3.1).
      const triggerResult = await request(`/api/v1/agents/${JOURNEY_AGENT}/triggers`, {
        method: "POST",
        body: {
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: triggerTime() },
          intent:
            "STOP: you must ask the human for approval before continuing. " +
            "Call the ask_human tool EXACTLY ONCE with question='May I continue with the plan?' " +
            "and summary='I need your approval to continue'. Do not output any text. " +
            "Stop immediately after the tool call.",
          mode: "ask",
          suggestedSkill: null,
        },
        headersExtra: { "Idempotency-Key": `p37-trigger-${Date.now()}` },
      });
      assert.strictEqual(triggerResult.status, 201, `crear Trigger falló: ${triggerResult.rawText}`);
      const triggerId = (triggerResult.body as { trigger?: { id?: string } }).trigger?.id;
      assert.ok(triggerId, "falta trigger.id");

      // (2) running → Ask (waiting_human con pregunta y deadline por fila).
      await waitForStatus(JOURNEY_AGENT, triggerId, "running", 240_000);
      const waiting = await waitForStatus(JOURNEY_AGENT, triggerId, "waiting_human", 240_000);
      assert.ok(waiting.id, "la Initiative en waiting_human debe tener id");
      assert.match(waiting.question ?? "", /May I continue/, "el panel debe ver la pregunta del ask_human");
      assert.ok(
        typeof waiting.expiresAt === "number" && waiting.expiresAt > Date.now() / 2,
        "el panel debe ver el deadline por fila",
      );

      // (3) El inbox (vía cookie de panel) ve la Initiative esperando sin
      //     internals y con la clave `notificationStatus` allowlisted.
      const panelSnapshot = await panelRequest(`/api/v1/agents/${JOURNEY_AGENT}/autonomy`);
      assert.strictEqual(panelSnapshot.status, 200, `panel snapshot falló: ${panelSnapshot.rawText}`);
      const inboxInis = ((panelSnapshot.body as { inbox?: PublicInitiativeShape[] }).inbox ?? []);
      const inboxIni = inboxInis.find((ini) => ini.id === waiting.id);
      assert.ok(inboxIni, "la Initiative esperando debe estar en el inbox del panel");
      assert.equal(
        inboxIni.notificationStatus,
        "not_delivered",
        "sin Primary Channel no hay tarjeta: la Initiative se ve como not_delivered (fail-closed) sin coordenadas",
      );
      assert.equal(inboxIni.status, "waiting_human");
      assertNoInternalsLeaked(panelSnapshot.rawText);
      for (const field of ["sessionKey", "turnId", "humanRequestId", "askCorrelation", "chatId", "messageId"]) {
        assert.doesNotMatch(panelSnapshot.rawText, new RegExp(field), `el snapshot no debe contener "${field}"`);
      }

      // (4) Respond por panel (cookie + CSRF + Idempotency-Key): reencola
      //     (queued), no despacha.
      const respond = await panelRequest(`/api/v1/agents/${JOURNEY_AGENT}/initiatives/${waiting.id}/respond`, {
        method: "POST",
        body: { answer: "Yes, continue and finish the task now. Complete your work and stop." },
        headersExtra: { "Idempotency-Key": `p37-respond-${Date.now()}` },
      });
      assert.strictEqual(respond.status, 200, `respond del panel falló: ${respond.rawText}`);
      const respondBody = respond.body as {
        initiative?: PublicInitiativeShape;
        replayed?: boolean;
      };
      assert.equal(respondBody.replayed, false);
      assert.equal(respondBody.initiative?.status, "queued", "respond solo reencola; el Loop es el único dispatcher");

      // (5) Misma sesión (mismo id de Initiative, mismo trigger) → terminal.
      //     El `respond` ya afirmó el reencolado a queued (paso 4); aquí el
      //     Loop reclama y la misma Initiative llega a terminal.
      const terminal = await waitForStatus(JOURNEY_AGENT, triggerId, "succeeded", 240_000);
      assert.equal(terminal.id, waiting.id, "la misma Initiative llega a terminal (misma sesión)");

      // (6) Una sola Initiative del trigger en todo el journey (sin duplicados).
      const finalSnapshot = await request(`/api/v1/agents/${JOURNEY_AGENT}/autonomy`);
      const fromTrigger = initiativesOf(finalSnapshot.body).filter((ini) => ini.triggerId === triggerId);
      assert.equal(fromTrigger.length, 1, `el trigger no debe crear más de una Initiative: ${JSON.stringify(fromTrigger)}`);
      assertNoInternalsLeaked(finalSnapshot.rawText);
    });
  });
});
});
