import test from "node:test";
import assert from "node:assert/strict";
import { createPanelTurns } from "../public/panel-turns.js";
import { PanelApiError } from "../public/panel-api.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("panel turns solicita verbose y recompone SSE aunque los chunks corten líneas", async () => {
  let request;
  const turns = createPanelTurns({
    csrfToken: "csrf-real",
    idFactory: (() => {
      const ids = ["turn-1", "idem-1", "corr-1"];
      return () => ids.shift();
    })(),
    fetchImpl: async (input, init = {}) => {
      request = { url: String(input), init };
      return sseResponse([
        'event: turn-start\ndata: {"turnId":"turn-1"}\n\n',
        'event: chunk\ndata: {"turnId":"turn-1","delta":"ho',
        'la"}\n\n',
        'event: thinking-delta\ndata: {"turnId":"turn-1","delta":"plan"}\n\n',
        'event: tool-start\ndata: {"turnId":"turn-1","toolName":"read"}\n\n',
        'event: tool-end\ndata: {"turnId":"turn-1","toolName":"read","isError":false}\n\n',
        'event: turn-complete\ndata: {"turnId":"turn-1","totalTokens":0}\n\n',
      ]);
    },
  });

  const turn = turns.startTurn({ agentName: "linus", sessionKey: "session-1", message: "hola" });
  const events = [];
  for await (const event of turn.events) events.push(event);

  assert.equal(request.url, "/api/v1/agents/linus/turns?eventProfile=verbose");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.credentials, "same-origin");
  assert.equal(request.init.headers["X-CSRF-Token"], "csrf-real");
  assert.deepEqual(JSON.parse(request.init.body), {
    sessionKey: "session-1",
    turnId: "turn-1",
    idempotencyKey: "idem-1",
    correlationId: "corr-1",
    message: "hola",
  });
  assert.deepEqual(events, [
    { event: "turn-start", data: { turnId: "turn-1" } },
    { event: "chunk", data: { turnId: "turn-1", delta: "hola" } },
    { event: "thinking-delta", data: { turnId: "turn-1", delta: "plan" } },
    { event: "tool-start", data: { turnId: "turn-1", toolName: "read" } },
    { event: "tool-end", data: { turnId: "turn-1", toolName: "read", isError: false } },
    { event: "turn-complete", data: { turnId: "turn-1", totalTokens: 0 } },
  ]);
});

test("panel turns expone errores tipados del envelope v1", async () => {
  const turns = createPanelTurns({
    fetchImpl: async () => new Response(
      JSON.stringify({ code: "TURN_IN_PROGRESS", message: "busy", correlationId: "corr-2" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
  });
  const turn = turns.startTurn({ agentName: "linus", sessionKey: "session-1", message: "hola" });

  await assert.rejects(
    async () => {
      for await (const _event of turn.events) {
        // El error debe producirse antes del primer evento SSE.
      }
    },
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "TURN_IN_PROGRESS");
      assert.equal(error.message, "busy");
      return true;
    },
  );
});

test("rotar sesión genera una clave nueva sin llamar al endpoint de sesiones", () => {
  const turns = createPanelTurns({
    idFactory: (() => {
      const ids = ["session-1", "session-2"];
      return () => ids.shift();
    })(),
    fetchImpl: async () => { throw new Error("no debe hacer fetch"); },
  });

  assert.equal(turns.createSessionKey(), "session-1");
  assert.equal(turns.createSessionKey(), "session-2");
});
