import { PanelApiError, errorFromResponse } from "./panel-api.js";

const TURN_EVENT_PROFILE = "verbose";

/**
 * Transport adapter for one panel turn. A turn is an independent HTTP/SSE
 * request; the panel owns the sessionKey and may rotate it without a server
 * session endpoint.
 */
export function createPanelTurns({ fetchImpl = globalThis.fetch, csrfToken = "", idFactory = randomId } = {}) {
  let currentCsrfToken = csrfToken;

  function setCsrfToken(token) {
    currentCsrfToken = token || "";
  }

  function createSessionKey() {
    return idFactory();
  }

  function startTurn({ agentName, sessionKey, message }) {
    const turnId = idFactory();
    const idempotencyKey = idFactory();
    const correlationId = idFactory();
    const path = `/api/v1/agents/${encodeURIComponent(agentName)}/turns?eventProfile=${TURN_EVENT_PROFILE}`;

    async function* events() {
      const response = await fetchImpl(path, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "X-CSRF-Token": currentCsrfToken,
        },
        credentials: "same-origin",
        body: JSON.stringify({ sessionKey, turnId, idempotencyKey, correlationId, message }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      if (!response.body) {
        throw new PanelApiError({
          status: response.status,
          code: "RESOURCE_UNAVAILABLE",
          message: "El Manager cerró el stream sin respuesta",
          correlationId,
        });
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        throw new PanelApiError({
          status: response.status,
          code: "RESOURCE_UNAVAILABLE",
          message: "El Manager no devolvió un stream SSE",
          correlationId,
        });
      }
      yield* parseSseEvents(response.body);
    }

    return { turnId, idempotencyKey, correlationId, events: events() };
  }

  return { setCsrfToken, createSessionKey, startTurn };
}

/**
 * SSE parser that keeps framing separate from network chunks. A chunk may
 * end in the middle of an event name, JSON value, or line ending.
 */
export async function* parseSseEvents(body) {
  if (!body || typeof body.getReader !== "function") {
    throw new Error("SSE response body is not readable");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) {
      eventName = "";
      return undefined;
    }
    const dataText = dataLines.join("\n");
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      throw new Error("Manager devolvió un evento SSE inválido");
    }
    const event = { event: eventName || "message", data };
    eventName = "";
    dataLines = [];
    return event;
  };

  const processLine = (line) => {
    if (line === "") return flush();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return undefined;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd;
    while ((lineEnd = findLineEnd(buffer)) !== -1) {
      const { line, consumed } = lineEnd;
      buffer = buffer.slice(consumed);
      const event = processLine(line);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const event = processLine(buffer.replace(/\r$/, ""));
    if (event) yield event;
  }
  const finalEvent = flush();
  if (finalEvent) yield finalEvent;
}

function findLineEnd(buffer) {
  const newline = buffer.indexOf("\n");
  if (newline === -1) return -1;
  const line = buffer.slice(0, newline).replace(/\r$/, "");
  return { line, consumed: newline + 1 };
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
