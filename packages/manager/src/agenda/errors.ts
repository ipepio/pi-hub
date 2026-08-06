/**
 * Catálogo cerrado de errores de la capa de dominio Agenda — Fase 2.1.
 *
 * El Manager es la frontera (`CONTRIBUTING.md:80-90`): los callers reciben un
 * código del catálogo, nunca texto crudo. `DomainErrorCode` es una unión
 * literal cerrada (§9.1); un código fuera de ella es un bug. La exhaustividad
 * se verifica en build: `toApiError` usa un `Record<DomainErrorCode, ...>`, así
 * que añadir un miembro a la unión sin mapearlo (o usar una clave inexistente)
 * no compila.
 *
 * Dos códigos se distinguen a propósito (§12.4): `INITIATIVE_TRANSITION_ILLEGAL`
 * (el caller pidió una transición que `canTransition` rechaza — bug del caller,
 * se lanza antes de tocar disco) y `INITIATIVE_STATE_CONFLICT` (el CAS
 * `WHERE state=:expected_from` perdió la carrera — estado válido al leer, otro
 * escritor ganó; §5.1). No se unifican.
 */

import type { ApiErrorCode } from "../api-v1/errors.ts";

/**
 * Catálogo cerrado de errores de dominio (§9.1 del plan). Un código fuera de
 * esta unión no compila en ningún punto que la use.
 */
export type DomainErrorCode =
  | "INITIATIVE_NOT_FOUND"
  | "TRIGGER_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INITIATIVE_TRANSITION_ILLEGAL"
  | "INITIATIVE_STATE_CONFLICT"
  | "INITIATIVE_ALREADY_TERMINAL"
  | "INITIATIVE_INVARIANT_VIOLATION"
  | "TRIGGER_NOT_DISPARABLE"
  | "CHAIN_DEPTH_EXCEEDED"
  | "CHAIN_DEADLINE_EXCEEDED"
  | "CALLBACK_NOT_FOUND"
  | "CALLBACK_PARENT_MISMATCH"
  | "CALLBACK_PARENT_TERMINAL"
  | "CALLBACK_ALREADY_PENDING"
  | "IDEMPOTENCY_DUPLICATE"
  | "TURN_NOT_FOUND"
  | "TURN_ALREADY_TERMINAL"
  | "TURN_ID_CONFLICT"
  | "STARTUP_RECOVERY_FAILED"
  | "STORAGE_BUSY"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CORRUPT"
  | "SCHEMA_UNSUPPORTED";

/**
 * Error tipado de la capa de dominio Agenda. Lleva un código del catálogo y un
 * mensaje interno (para log del Manager); el texto crudo nunca sale hacia el
 * caller, que recibe el envelope versionado de la capa API (`api-v1/errors.ts`).
 * El `cause` se conserva solo para log interno (§10.5).
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
  }
}

/**
 * Traducción al catálogo HTTP existente (`api-v1/errors.ts`), tabla §9.2.
 *
 * Códigos sin fila en §9.2 —`CALLBACK_NOT_FOUND`, `CHAIN_DEADLINE_EXCEEDED`
 * (info del barrido, no error de caller) e `IDEMPOTENCY_DUPLICATE` ("no es
 * error"; devuelve `{turnId, duplicate:true}`)— mapean a `INTERNAL_ERROR`:
 * son códigos que en Fase 2 no deben llegar a la frontera HTTP, y si llegan
 * es un bug del Manager que debe verse en logs. El §9.2 deja "no determinada"
 * la traducción pública de `INITIATIVE_*`/`CALLBACK_*` hasta la fase que toque
 * `routes.ts`; esta tabla es la especificación vigente para Fase 2 y no toca
 * `api-v1/` (decisión §9.2: opción 1, sin añadir `STATE_CONFLICT` 409).
 *
 * P1 (plan P1 §4) añade `IDEMPOTENCY_CONFLICT`,
 * error de caller; su traducción pública la fija P2, así que aquí
 * mapean provisionalmente a `BAD_REQUEST` para mantener `toApiError` exhaustivo
 * sin introducir rutas.
 */
const API_CODE_BY_DOMAIN: Readonly<Record<DomainErrorCode, ApiErrorCode>> = {
  INITIATIVE_NOT_FOUND: "TURN_NOT_FOUND",
  TRIGGER_NOT_FOUND: "BAD_REQUEST",
  IDEMPOTENCY_CONFLICT: "BAD_REQUEST",
  INITIATIVE_TRANSITION_ILLEGAL: "BAD_REQUEST",
  INITIATIVE_STATE_CONFLICT: "BAD_REQUEST",
  INITIATIVE_ALREADY_TERMINAL: "BAD_REQUEST",
  INITIATIVE_INVARIANT_VIOLATION: "BAD_REQUEST",
  TRIGGER_NOT_DISPARABLE: "BAD_REQUEST",
  CHAIN_DEPTH_EXCEEDED: "BAD_REQUEST",
  CHAIN_DEADLINE_EXCEEDED: "INTERNAL_ERROR",
  CALLBACK_NOT_FOUND: "INTERNAL_ERROR",
  CALLBACK_PARENT_MISMATCH: "BAD_REQUEST",
  CALLBACK_PARENT_TERMINAL: "BAD_REQUEST",
  CALLBACK_ALREADY_PENDING: "BAD_REQUEST",
  IDEMPOTENCY_DUPLICATE: "INTERNAL_ERROR",
  TURN_NOT_FOUND: "TURN_NOT_FOUND",
  TURN_ALREADY_TERMINAL: "BAD_REQUEST",
  TURN_ID_CONFLICT: "BAD_REQUEST",
  STARTUP_RECOVERY_FAILED: "INTERNAL_ERROR",
  STORAGE_BUSY: "RESOURCE_UNAVAILABLE",
  STORAGE_UNAVAILABLE: "RESOURCE_UNAVAILABLE",
  STORAGE_CORRUPT: "INTERNAL_ERROR",
  SCHEMA_UNSUPPORTED: "INTERNAL_ERROR",
};

/** Traduce un código de dominio al catálogo HTTP existente (`api-v1/errors.ts`). */
export function toApiError(code: DomainErrorCode): ApiErrorCode {
  return API_CODE_BY_DOMAIN[code];
}
