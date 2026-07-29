/** Catálogo cerrado de la spec §4.1. Un código fuera de aquí es un bug, no un caso nuevo. */
export type ApiErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "TURN_NOT_FOUND"
  | "TURN_IN_PROGRESS"
  | "MODEL_FORBIDDEN"
  | "RESOURCE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "MISSING_AUTH"
  | "INVALID_AUTH"
  | "ROTATED_AUTH"
  | "BAD_REQUEST"
  | "PAYLOAD_TOO_LARGE";

export const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  MISSING_AUTH: 401,
  INVALID_AUTH: 401,
  ROTATED_AUTH: 401,
  MODEL_FORBIDDEN: 403,
  AGENT_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 410,
  TURN_NOT_FOUND: 404,
  AGENT_ALREADY_EXISTS: 409,
  TURN_IN_PROGRESS: 409,
  RESOURCE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Mensaje fijo para el error interno: el detalle real va al log del Manager, nunca al caller (spec §4.1, §7). */
const INTERNAL_MESSAGE = "Internal error";

export interface ApiErrorEnvelope {
  code: ApiErrorCode;
  message: string;
  correlationId: string;
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  correlationId: string,
): ApiErrorEnvelope {
  return {
    code,
    message: code === "INTERNAL_ERROR" ? INTERNAL_MESSAGE : message,
    correlationId,
  };
}
