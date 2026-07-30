// packages/manager/src/api-v1/auth.ts

import { randomBytes } from "node:crypto";
import { AUTH_COOKIE } from "@pihub/shared";

export const CSRF_COOKIE = "pihub_csrf";

/**
 * Clasifica la credencial de servicio de `/api/v1`.
 *
 * Separada a propósito del guard del panel (`isAuthorized`, que acepta
 * cookie): `/api/v1` es servicio-a-servicio, y una sesión de navegador
 * jamás debe valer ahí. Distinguir "ausente" de "inválida" es el
 * criterio de H01.02 — el dashboard reacciona distinto a cada una.
 */
export function classifyServiceAuth(
  authorizationHeader: string | undefined,
  expectedToken: string,
): "ok" | "MISSING_AUTH" | "INVALID_AUTH" {
  if (!authorizationHeader?.startsWith("Bearer ")) return "MISSING_AUTH";
  const provided = authorizationHeader.slice("Bearer ".length);
  return provided === expectedToken ? "ok" : "INVALID_AUTH";
}

export type ApiV1AuthVerdict =
  | { kind: "service" }
  | { kind: "panel" }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "csrf_invalid" };

export interface ApiV1AuthInput {
  authorizationHeader?: string;
  cookieHeader?: string;
  method: string;
  csrfHeader?: string;
  csrfCookie?: string;
  origin?: string;
  requestOrigin: string;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Lee una cookie concreta sin aceptar coincidencias parciales del nombre. */
export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Token anti-CSRF para una sesión nueva; nunca es el API_TOKEN. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/** Cookie legible por el panel: la defensa CSRF no debe ser HttpOnly. */
export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=2592000`;
}

/**
 * Clasifica Bearer y cookie sin mezclar sus precedencias.
 *
 * Un Bearer presente pero inválido nunca cae a la cookie. La cookie de panel
 * solo autoriza mutaciones cuando el token de header coincide con la cookie
 * anti-CSRF y, si llega Origin, con el origen de la petición.
 */
export function classifyApiV1Auth(
  input: ApiV1AuthInput,
  expectedToken: string,
): ApiV1AuthVerdict {
  const serviceVerdict = classifyServiceAuth(input.authorizationHeader, expectedToken);
  if (serviceVerdict === "ok") return { kind: "service" };
  if (serviceVerdict === "INVALID_AUTH") return { kind: "invalid" };

  const panelToken = cookieValue(input.cookieHeader, AUTH_COOKIE);
  if (panelToken === undefined) return { kind: "missing" };
  if (panelToken !== expectedToken) return { kind: "invalid" };

  if (!MUTATING_METHODS.has(input.method.toUpperCase())) return { kind: "panel" };
  if (!input.csrfHeader || !input.csrfCookie || input.csrfHeader !== input.csrfCookie) {
    return { kind: "csrf_invalid" };
  }
  if (input.origin !== undefined && input.origin !== input.requestOrigin) {
    return { kind: "csrf_invalid" };
  }
  return { kind: "panel" };
}
