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
});
