// H01.04 — idempotencia y traducción de eventos del turno.
//
// El Runner solo acepta prompts por WebSocket (`/ws`) y responde con su
// propio vocabulario (`agent_start`, `text_delta`, `agent_end`…). La
// spec §7 prohíbe exponer WebSockets al dashboard, así que el Manager
// hace de puente: WS del Runner → SSE de `/api/v1`. Aquí se prueban las
// dos piezas puras de ese puente, sin red.

import { describe, it } from "node:test";
import assert from "node:assert";
import { isDuplicateTurn, rememberTurn, toTurnEvent } from "../src/api-v1/turns.ts";

describe("idempotencia de turnos (spec §5)", () => {
  it("una idempotencyKey ya vista se detecta como duplicada", () => {
    const visto = new Map<string, string>();
    rememberTurn(visto, "idem-1", "turn-1");
    assert.strictEqual(isDuplicateTurn(visto, "idem-1"), "turn-1");
  });

  it("una key nueva no es duplicada", () => {
    const visto = new Map<string, string>();
    assert.strictEqual(isDuplicateTurn(visto, "idem-nueva"), undefined);
  });

  it("un reintento con la MISMA key devuelve el turnId original, no crea otro turno", () => {
    // Es el punto de la idempotencia: el dashboard reintenta tras un
    // corte de red y no debe duplicar la ejecución.
    const visto = new Map<string, string>();
    rememberTurn(visto, "idem-1", "turn-1");
    rememberTurn(visto, "idem-1", "turn-2");
    assert.strictEqual(isDuplicateTurn(visto, "idem-1"), "turn-1");
  });
});

describe("traducción del vocabulario del Runner al de la spec §4.5", () => {
  const TURN = "turn-1";

  it("agent_start abre el turno", () => {
    assert.deepStrictEqual(toTurnEvent({ type: "agent_start" }, TURN), {
      event: "turn-start",
      data: { turnId: TURN },
    });
  });

  it("text_delta es el contenido de la respuesta", () => {
    assert.deepStrictEqual(toTurnEvent({ type: "text_delta", delta: "Hola" }, TURN), {
      event: "chunk",
      data: { turnId: TURN, delta: "Hola" },
    });
  });

  it("agent_end cierra el turno", () => {
    const traducido = toTurnEvent({ type: "agent_end" }, TURN);
    assert.strictEqual(traducido?.event, "turn-complete");
    assert.strictEqual((traducido?.data as { turnId: string }).turnId, TURN);
  });

  it("un error del Runner se traduce sin filtrar su texto crudo", () => {
    // El mensaje del Runner puede llevar paths internos; el dashboard
    // recibe un código estable (spec §7).
    const traducido = toTurnEvent({ type: "error", message: "ENOENT /data/agents/x" }, TURN);
    assert.strictEqual(traducido?.event, "turn-error");
    assert.strictEqual((traducido?.data as { code: string }).code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(traducido?.data), /\/data/);
  });

  it("el razonamiento y las tools NO se reenvían: no están en el vocabulario del dashboard", () => {
    // Mapearlos a `chunk` mezclaría razonamiento con respuesta, que es
    // peor que omitirlos. Se descartan explícitamente, no por descuido.
    assert.strictEqual(toTurnEvent({ type: "thinking_delta", delta: "mmm" }, TURN), undefined);
    assert.strictEqual(toTurnEvent({ type: "tool_start", toolName: "x" }, TURN), undefined);
    assert.strictEqual(toTurnEvent({ type: "ready", agent: "a", sessionId: "s" }, TURN), undefined);
  });

  it("un tipo desconocido se ignora en vez de romper el turno", () => {
    // El Runner puede ganar eventos nuevos sin que el Manager se entere:
    // ignorarlos es preferible a cortar un turno en curso.
    assert.strictEqual(toTurnEvent({ type: "inventado-mañana" }, TURN), undefined);
  });
});
