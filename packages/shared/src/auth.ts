export const AUTH_COOKIE = "pihub_token";

/** Valida Bearer header o cookie contra el token compartido. Token vacío = auth desactivada. */
export function isAuthorized(
  token: string,
  authorizationHeader: string | undefined,
  cookieHeader: string | undefined,
): boolean {
  if (!token) return true;
  if (authorizationHeader === `Bearer ${token}`) return true;
  const cookies = (cookieHeader ?? "").split(";").map((c) => c.trim());
  return cookies.includes(`${AUTH_COOKIE}=${token}`);
}

export function sessionCookie(token: string): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}
