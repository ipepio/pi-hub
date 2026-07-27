// packages/manager/test/api-v1-auth.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyServiceAuth } from "../src/api-v1/auth.ts";

describe("service auth de /api/v1", () => {
  it("sin header devuelve MISSING_AUTH", () => {
    assert.strictEqual(classifyServiceAuth(undefined, "secreto"), "MISSING_AUTH");
  });

  it("header vacío o sin Bearer devuelve MISSING_AUTH", () => {
    assert.strictEqual(classifyServiceAuth("", "secreto"), "MISSING_AUTH");
    assert.strictEqual(classifyServiceAuth("secreto", "secreto"), "MISSING_AUTH");
  });

  it("token que no coincide devuelve INVALID_AUTH, distinto de ausente", () => {
    // Distinguirlos es el criterio de H01.02: el dashboard reacciona
    // distinto a "no mandé credencial" que a "mi credencial ya no vale".
    assert.strictEqual(classifyServiceAuth("Bearer otro", "secreto"), "INVALID_AUTH");
  });

  it("token correcto devuelve ok", () => {
    assert.strictEqual(classifyServiceAuth("Bearer secreto", "secreto"), "ok");
  });

  it("no acepta cookie de sesión: el panel y el servicio son credenciales distintas", () => {
    // El guard viejo aceptaba cookie; /api/v1 es solo servicio-a-servicio.
    assert.strictEqual(classifyServiceAuth("pihub_session=secreto", "secreto"), "MISSING_AUTH");
  });
});
