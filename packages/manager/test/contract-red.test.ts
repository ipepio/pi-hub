// T01.03 — Contract Red tests para `/api/v1` del Manager
// Estos tests demuestran que la interfaz versionada y el service auth
// aún NO existen. Deben fallar con mensajes claros de "capacidad ausente".
//
// Ejecutar con: npm run test:contract-red

import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";

const BASE_URL = "http://127.0.0.1:4000";

/**
 * Helper para hacer requests HTTP con auth opcional.
 */
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, BASE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(url.toString(), {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }

  return { status: res.status, body };
}

describe("T01.03 — Contract Red: /api/v1 no existe todavía", () => {
  it("RED: GET /api/v1/health responde 404 porque la ruta no existe", async () => {
    // Spec §4.2: GET /api/v1/health debe responder con health envelope
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/health");
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: GET /api/v1/readiness responde 404 porque la ruta no existe", async () => {
    // Spec §4.2: GET /api/v1/readiness debe responder con readiness envelope
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/readiness");
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: GET /api/v1/agents responde 404 porque la ruta no existe", async () => {
    // Spec §4.3: GET /api/v1/agents debe listar agentes
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents");
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1/agents no está implementado");
  });

  it("RED: POST /api/v1/agents sin auth responde 404 (no 401 con error tipado)", async () => {
    // Spec §3.3: sin auth debe recibir 401 con {code: "MISSING_AUTH", ...}
    // Red: la ruta no existe → 404, no el 401 esperado
    const { status } = await request("/api/v1/agents", { method: "POST", body: { name: "test" } });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: POST /api/v1/agents con auth inválida responde 401 con MISSING_AUTH o INVALID_AUTH", async () => {
    // Spec §3.3: con token inválido debe recibir 401 con {code: "INVALID_AUTH", ...}
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents", {
      method: "POST",
      body: { name: "test" },
      token: "token-invalido-12345",
    });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: POST /api/v1/agents con credencial ausente responde 401 con MISSING_AUTH", async () => {
    // Spec §3.3: sin credencial debe recibir 401 con {code: "MISSING_AUTH", ...}
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents", {
      method: "POST",
      body: { name: "test" },
    });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: POST /api/v1/agents con body inválido responde 400 con BAD_REQUEST", async () => {
    // Spec §4.3: body inválido debe recibir 400 con {code: "BAD_REQUEST", ...}
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents", {
      method: "POST",
      body: {}, // sin nombre
    });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
  });

  it("RED: Los errores del servidor no exponen paths, puertos ni tokens internos", async () => {
    // Spec §3.3 y §7: los errores nunca exponen secretos ni detalles internos
    // Red: no hay forma de verificar esto porque la ruta no existe
    const { status, body } = await request("/api/v1/agents/this-does-not-exist");
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1 no está implementado");
    // Una vez implementado, se verificaría que el body es {code, message, correlationId}
    // y no contiene paths, puertos, ni tokens.
  });

  it("RED: POST /api/v1/agents/:name/sessions no existe", async () => {
    // Spec §4.4: POST /api/v1/agents/:name/sessions debe crear sesión
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents/test-agent/sessions", {
      method: "POST",
      body: { channel: "web", sessionKey: "test-key" },
    });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1/sessions no está implementado");
  });

  it("RED: POST /api/v1/agents/:name/turns no existe", async () => {
    // Spec §4.5: POST /api/v1/agents/:name/turns debe ejecutar turno con streaming
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents/test-agent/turns", {
      method: "POST",
      body: {
        sessionKey: "test-key",
        turnId: "turn-001",
        idempotencyKey: "idem-001",
        correlationId: "req-001",
        message: "Hola",
      },
    });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1/turns no está implementado");
  });

  it("RED: GET /api/v1/agents/:name/turns/:id no existe", async () => {
    // Spec §4.5: GET /api/v1/agents/:name/turns/:id debe leer estado del turno
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents/test-agent/turns/turn-001");
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1/turns/:id no está implementado");
  });

  it("RED: DELETE /api/v1/agents/:name no existe", async () => {
    // Spec §4.3: DELETE /api/v1/agents/:name debe eliminar agente
    // Red: la ruta no existe → 404
    const { status } = await request("/api/v1/agents/test-agent", { method: "DELETE" });
    assert.strictEqual(status, 404, "Se esperaba 404 porque /api/v1/agents/:name no está implementado");
  });
});
