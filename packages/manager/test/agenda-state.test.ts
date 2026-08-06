// Fase 2.1 — máquina de estados y catálogo de errores (puros, sin disco).
//
// Verifica la matriz 8×8 de transiciones que fija el plan de Fase 2 (§4.1/§4.2,
// consolidada en §12.1: la reanudación va a `queued`, no a `running`), el
// concepto de estado terminal, la regla de `mode` (solo→ask; nunca ask→solo) y
// el catálogo cerrado de errores con su traducción a `api-v1/errors.ts` (§9).
// Nada de esto toca la base: `state.ts` y `errors.ts` son módulos puros.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canChangeMode,
  canTransition,
  isTerminal,
  type InitiativeMode,
  type InitiativeState,
} from "../src/agenda/state.ts";
import {
  DomainError,
  toApiError,
  type DomainErrorCode,
} from "../src/agenda/errors.ts";
import { HTTP_STATUS_BY_CODE } from "../src/api-v1/errors.ts";

const STATES: readonly InitiativeState[] = [
  "queued",
  "running",
  "waiting_human",
  "waiting_agent",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
];

/** Filas legítimas del plan (§4.1), tal y como quedan consolidadas en §12.1. */
const EXPECTED: Readonly<Record<InitiativeState, readonly InitiativeState[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_human", "waiting_agent", "succeeded", "failed", "cancelled"],
  waiting_human: ["queued", "failed", "expired", "cancelled"],
  waiting_agent: ["queued", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  expired: [],
  cancelled: [],
};

describe("state.ts — máquina de ocho estados (matriz 8×8, sin disco)", () => {
  it("cada fila de transiciones del plan (§4.1) es legal", () => {
    for (const from of STATES) {
      for (const to of EXPECTED[from]) {
        assert.equal(canTransition(from, to), true, `${from} -> ${to} debería ser legal`);
      }
    }
  });

  it("toda combinación no listada en el plan (§4.2: las 64 celdas) es ilegal", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        assert.equal(
          canTransition(from, to),
          EXPECTED[from].includes(to),
          `${from} -> ${to} debe ser legal exactamente cuando la tabla del plan lo fija`,
        );
      }
    }
  });

  it("la reanudación va a queued, no a running (§12.1)", () => {
    assert.equal(canTransition("waiting_human", "queued"), true);
    assert.equal(canTransition("waiting_agent", "queued"), true);
    assert.equal(canTransition("waiting_human", "running"), false);
    assert.equal(canTransition("waiting_agent", "running"), false);
  });

  it("running -> queued es ilegal (reencolado automático prohibido, ADR 0005)", () => {
    assert.equal(canTransition("running", "queued"), false);
  });

  it("waiting_agent -> expired es ilegal (la caducidad de Agent Policy no aplica a waiting_agent, CONTEXT.md:40)", () => {
    assert.equal(canTransition("waiting_agent", "expired"), false);
  });

  it("los terminales son absorbedores: ninguna transición sale de ellos", () => {
    for (const terminal of ["succeeded", "failed", "expired", "cancelled"] as const) {
      for (const to of STATES) {
        assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to} debería ser ilegal`);
      }
    }
  });

  it("isTerminal es true solo para succeeded/failed/expired/cancelled", () => {
    for (const state of STATES) {
      assert.equal(
        isTerminal(state),
        state === "succeeded" || state === "failed" || state === "expired" || state === "cancelled",
        `${state} terminal=${isTerminal(state)}`,
      );
    }
  });

  it("mode: el Agent puede escalar solo->ask pero nunca ask->solo (CONTEXT.md:52,68)", () => {
    const modes: readonly InitiativeMode[] = ["solo", "ask"];
    for (const from of modes) {
      for (const to of modes) {
        assert.equal(canChangeMode(from, to), from === "solo" && to === "ask", `${from}->${to}`);
      }
    }
  });
});

describe("errors.ts — catálogo cerrado y traducción hacia arriba (§9)", () => {
  const ALL_DOMAIN_CODES: readonly DomainErrorCode[] = [
    "INITIATIVE_NOT_FOUND",
    "TRIGGER_NOT_FOUND",
    "INITIATIVE_TRANSITION_ILLEGAL",
    "INITIATIVE_STATE_CONFLICT",
    "INITIATIVE_ALREADY_TERMINAL",
    "INITIATIVE_INVARIANT_VIOLATION",
    "TRIGGER_NOT_DISPARABLE",
    "CHAIN_DEPTH_EXCEEDED",
    "CHAIN_DEADLINE_EXCEEDED",
    "CALLBACK_NOT_FOUND",
    "CALLBACK_PARENT_MISMATCH",
    "CALLBACK_PARENT_TERMINAL",
    "CALLBACK_ALREADY_PENDING",
    "IDEMPOTENCY_DUPLICATE",
    "TURN_NOT_FOUND",
    "TURN_ALREADY_TERMINAL",
    "TURN_ID_CONFLICT",
    "STARTUP_RECOVERY_FAILED",
    "STORAGE_BUSY",
    "STORAGE_UNAVAILABLE",
    "STORAGE_CORRUPT",
    "SCHEMA_UNSUPPORTED",
  ];

  it("DomainError lleva su código y un mensaje interno (el texto no sale del Manager)", () => {
    const err = new DomainError("INITIATIVE_TRANSITION_ILLEGAL", "queued -> succeeded");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "DomainError");
    assert.equal(err.code, "INITIATIVE_TRANSITION_ILLEGAL");
    assert.equal(err.message, "queued -> succeeded");
    // El `cause` se conserva solo para log interno (§10.5).
    const withCause = new DomainError("STORAGE_BUSY", "busy_timeout agotado", {
      cause: new Error("SQLITE_BUSY"),
    });
    assert.ok(withCause.cause instanceof Error);
  });

  it("toApiError traduce todo el catálogo a un ApiErrorCode con HTTP definido (§9.2)", () => {
    for (const code of ALL_DOMAIN_CODES) {
      const apiCode = toApiError(code);
      assert.ok(apiCode in HTTP_STATUS_BY_CODE, `${code} -> ${apiCode} debe tener HTTP definido`);
      assert.equal(typeof HTTP_STATUS_BY_CODE[apiCode], "number");
    }
  });

  it("traducciones fijadas por la tabla §9.2", () => {
    assert.equal(toApiError("INITIATIVE_NOT_FOUND"), "INITIATIVE_NOT_FOUND");
    assert.equal(toApiError("TURN_NOT_FOUND"), "TURN_NOT_FOUND");
    assert.equal(toApiError("INITIATIVE_TRANSITION_ILLEGAL"), "BAD_REQUEST");
    assert.equal(toApiError("INITIATIVE_STATE_CONFLICT"), "INITIATIVE_STATE_CONFLICT");
    assert.equal(toApiError("INITIATIVE_ALREADY_TERMINAL"), "BAD_REQUEST");
    assert.equal(toApiError("INITIATIVE_INVARIANT_VIOLATION"), "INTERNAL_ERROR");
    assert.equal(toApiError("TRIGGER_NOT_FOUND"), "TRIGGER_NOT_FOUND");
    assert.equal(toApiError("TRIGGER_NOT_DISPARABLE"), "BAD_REQUEST");
    assert.equal(toApiError("IDEMPOTENCY_CONFLICT"), "IDEMPOTENCY_CONFLICT");
    assert.equal(toApiError("CHAIN_DEPTH_EXCEEDED"), "BAD_REQUEST");
    assert.equal(toApiError("CALLBACK_PARENT_MISMATCH"), "BAD_REQUEST");
    assert.equal(toApiError("CALLBACK_PARENT_TERMINAL"), "BAD_REQUEST");
    assert.equal(toApiError("CALLBACK_ALREADY_PENDING"), "BAD_REQUEST");
    assert.equal(toApiError("TURN_ALREADY_TERMINAL"), "BAD_REQUEST");
    assert.equal(toApiError("TURN_ID_CONFLICT"), "BAD_REQUEST");
    assert.equal(toApiError("STORAGE_BUSY"), "RESOURCE_UNAVAILABLE");
    assert.equal(toApiError("STORAGE_UNAVAILABLE"), "RESOURCE_UNAVAILABLE");
    assert.equal(toApiError("STORAGE_CORRUPT"), "INTERNAL_ERROR");
    assert.equal(toApiError("STARTUP_RECOVERY_FAILED"), "INTERNAL_ERROR");
    assert.equal(toApiError("SCHEMA_UNSUPPORTED"), "INTERNAL_ERROR");
  });

  it("códigos sin fila en §9.2 mapean a INTERNAL_ERROR (no deben llegar a HTTP en Fase 2)", () => {
    assert.equal(toApiError("CALLBACK_NOT_FOUND"), "INTERNAL_ERROR");
    assert.equal(toApiError("CHAIN_DEADLINE_EXCEEDED"), "INTERNAL_ERROR");
    assert.equal(toApiError("IDEMPOTENCY_DUPLICATE"), "INTERNAL_ERROR");
  });

  it("INITIATIVE_TRANSITION_ILLEGAL (bug del caller) y INITIATIVE_STATE_CONFLICT (carrera perdida) son códigos distintos (§12.4)", () => {
    assert.notEqual(
      "INITIATIVE_TRANSITION_ILLEGAL",
      "INITIATIVE_STATE_CONFLICT",
    );
    const illegal = new DomainError("INITIATIVE_TRANSITION_ILLEGAL", "bug");
    const conflict = new DomainError("INITIATIVE_STATE_CONFLICT", "carrera");
    assert.notEqual(illegal.code, conflict.code);
  });

  it("el catálogo es una unión literal cerrada: un código fuera de ella no compila", () => {
    // La unión es cerrada y la exhaustividad se impone en build por el
    // `Record<DomainErrorCode, ...>` de `toApiError`: un miembro sin mapear o
    // una clave inventada no compilan. Esta línea documenta la propiedad en el
    // propio test: si este fichero llegara a typechequearse, tsc la valida.
    // @ts-expect-error "NOT_A_REAL_CODE" no está en la unión DomainErrorCode
    const invalid: DomainErrorCode = "NOT_A_REAL_CODE";
    void invalid;
  });
});
