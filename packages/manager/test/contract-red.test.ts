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
import { fileURLToPath } from "node:url";

const MANAGER_URL = process.env.MANAGER_URL ?? "http://127.0.0.1:4000";

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

before(async () => {
  VALID_TOKEN = loadApiToken();
  UPLOAD_AGENT = `h09-upload-${Date.now()}`;
  const created = await request("/api/v1/agents", {
    method: "POST",
    body: { name: UPLOAD_AGENT, model: "anthropic/claude-sonnet-5" },
  });
  assert.strictEqual(created.status, 201, `no se pudo crear el Agent de H09: ${created.rawText}`);
});

after(async () => {
  if (UPLOAD_AGENT) await request(`/api/v1/agents/${UPLOAD_AGENT}`, { method: "DELETE" });
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

async function request(
  path: string,
  options: { method?: string; body?: unknown; auth?: "valid" | "invalid" | "none" } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = options.auth ?? "valid";
  if (auth === "valid") headers["Authorization"] = `Bearer ${VALID_TOKEN}`;
  if (auth === "invalid") headers["Authorization"] = "Bearer this-token-is-not-valid";

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
});
