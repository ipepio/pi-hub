import { describe, it } from "node:test";
import assert from "node:assert";
import { apiError, HTTP_STATUS_BY_CODE } from "../src/api-v1/errors.ts";

describe("api-v1 error envelope", () => {
  it("construye el envelope con code, message y correlationId", () => {
    const envelope = apiError("AGENT_NOT_FOUND", "no existe", "req-1");
    assert.deepStrictEqual(envelope, {
      code: "AGENT_NOT_FOUND",
      message: "no existe",
      correlationId: "req-1",
    });
  });

  it("cada código del catálogo tiene un status HTTP", () => {
    // La spec §4.1 fija el catálogo; sin status un código sería inservible.
    for (const code of [
      "AGENT_NOT_FOUND",
      "AGENT_ALREADY_EXISTS",
      "SESSION_NOT_FOUND",
      "SESSION_EXPIRED",
      "TURN_IN_PROGRESS",
      "MODEL_FORBIDDEN",
      "RESOURCE_UNAVAILABLE",
      "INTERNAL_ERROR",
      "MISSING_AUTH",
      "INVALID_AUTH",
      "ROTATED_AUTH",
      "BAD_REQUEST",
      "CSRF_REQUIRED",
      "CSRF_INVALID",
    ] as const) {
      assert.ok(HTTP_STATUS_BY_CODE[code], `falta status para ${code}`);
    }
  });

  it("CSRF_REQUIRED y CSRF_INVALID son errores 403", () => {
    assert.strictEqual(HTTP_STATUS_BY_CODE.CSRF_REQUIRED, 403);
    assert.strictEqual(HTTP_STATUS_BY_CODE.CSRF_INVALID, 403);
  });

  it("INTERNAL_ERROR nunca lleva el detalle real al caller", () => {
    // Spec §4.1: el error interno se registra, no se expone.
    const envelope = apiError("INTERNAL_ERROR", "ENOENT /data/agents/x", "req-2");
    assert.doesNotMatch(envelope.message, /\/data/);
  });
});
