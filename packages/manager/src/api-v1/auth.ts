// packages/manager/src/api-v1/auth.ts

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
