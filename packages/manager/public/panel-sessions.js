/*
 * Browser adapter del catálogo de sesiones del Manager (S2/S3).
 *
 * El panel deja de inventarse la sesión: la identidad y el puntero por superficie
 * viven en el catálogo durable de `/api/v1/agents/:name/sessions*`, y esta capa es lo
 * único que sabe de HTTP, cookies, CSRF y envelopes — el mismo reparto que
 * `panel-api.js`, con las mismas convenciones:
 *   * `credentials: "same-origin"` en todas las llamadas,
 *   * `X-CSRF-Token` en TODA mutación (el token se puede actualizar con
 *     `setCsrfToken`, igual que en `createPanelApi`),
 *   * `encodeURIComponent` en cada segmento de ruta (nombre de Agent e id de sesión),
 *   * un envelope de error se convierte en `PanelApiError` con `code` y
 *     `correlationId`, para que el panel distinga CSRF de 404 o de 500.
 *
 * Lo que NO hace: generar claves de sesión. `panel-turns.js` conserva
 * `createSessionKey` por compatibilidad, pero este módulo nunca la usa: una key
 * inventada por el cliente es exactamente la sesión huérfana que el catálogo cierra.
 */
import { errorFromResponse } from "./panel-api.js";

export function createPanelSessions({ fetchImpl = globalThis.fetch, csrfToken = "" } = {}) {
  let currentCsrfToken = csrfToken;

  function setCsrfToken(token) {
    currentCsrfToken = token || "";
  }

  async function request(path, { method = "GET", body } = {}) {
    const headers = { accept: "application/json" };
    if (method !== "GET") headers["X-CSRF-Token"] = currentCsrfToken;
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await fetchImpl(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    return readResponseBody(response);
  }

  const sessionsPath = (agentName) => `/api/v1/agents/${encodeURIComponent(agentName)}/sessions`;

  return {
    setCsrfToken,

    /** Catálogo + puntero por superficie: `{agent, sessions, selection}`. */
    list: (agentName) => request(sessionsPath(agentName)),

    /**
     * Alta en el catálogo. La identidad la decide el servidor: el body solo lleva un
     * nombre humano opcional y nunca un `sessionKey`.
     */
    create: (agentName, { name } = {}) =>
      request(sessionsPath(agentName), {
        method: "POST",
        body: name ? { name } : {},
      }),

    /** Selección POR SUPERFICIE: mover `web` no toca la de Telegram (S3). */
    select: (agentName, sessionId, channel = "web") =>
      request(`${sessionsPath(agentName)}/${encodeURIComponent(sessionId)}/select`, {
        method: "POST",
        body: { channel },
      }),
  };
}

/**
 * Mismo lector tolerante que usa `panel-api.js`: 204/200 sin cuerpo devuelven
 * `undefined` en vez de reventar, y un cuerpo que no es JSON se expone como
 * `{message}` para que el caller pueda enseñar algo verdadero.
 */
async function readResponseBody(response) {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
