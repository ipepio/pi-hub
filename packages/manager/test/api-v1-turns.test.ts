// H01.04 — idempotencia y traducción de eventos del turno.
//
// El Runner solo acepta prompts por WebSocket (`/ws`) y responde con su
// propio vocabulario (`agent_start`, `text_delta`, `agent_end`…). La
// spec §7 prohíbe exponer WebSockets al dashboard, así que el Manager
// hace de puente: WS del Runner → SSE de `/api/v1`. Aquí se prueban las
// dos piezas puras de ese puente, sin red.

import { describe, it } from "node:test";
import assert from "node:assert";
import { MAX_REMEMBERED_TURNS, isDuplicateTurn, rememberTurn, toTurnEvent } from "../src/api-v1/turns.ts";

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

  it("el registro no crece sin limite: al superar el maximo expulsa las entradas mas antiguas", () => {
    // El Map vive lo que el router: sin tope, un Manager de larga vida
    // acumularia entradas sin cota. Con maxEntries 3 y 4 claves, la mas
    // antigua (la primera insertada) debe salir del registro.
    const visto = new Map<string, string>();
    rememberTurn(visto, "idem-1", "turn-1", 3);
    assert.ok(visto.size <= 3);
    rememberTurn(visto, "idem-2", "turn-2", 3);
    assert.ok(visto.size <= 3);
    rememberTurn(visto, "idem-3", "turn-3", 3);
    assert.ok(visto.size <= 3);
    rememberTurn(visto, "idem-4", "turn-4", 3);
    assert.ok(visto.size <= 3);

    // La primera clave insertada ya no se detecta como duplicada...
    assert.strictEqual(isDuplicateTurn(visto, "idem-1"), undefined);
    // ...y la ultima si, con su turnId correcto.
    assert.strictEqual(isDuplicateTurn(visto, "idem-4"), "turn-4");
  });

  it("las entradas dentro del limite se conservan intactas", () => {
    // Guarda contra una expulsión de mas: con maxEntries 3 y 3 claves,
    // ninguna debe salir del registro.
    const visto = new Map<string, string>();
    rememberTurn(visto, "idem-1", "turn-1", 3);
    rememberTurn(visto, "idem-2", "turn-2", 3);
    rememberTurn(visto, "idem-3", "turn-3", 3);
    assert.strictEqual(visto.size, 3);
    assert.strictEqual(isDuplicateTurn(visto, "idem-1"), "turn-1");
    assert.strictEqual(isDuplicateTurn(visto, "idem-2"), "turn-2");
    assert.strictEqual(isDuplicateTurn(visto, "idem-3"), "turn-3");
  });

  it("el limite por defecto esta acotado y es el exportado", () => {
    // Contrato: existe un limite por defecto, finito y positivo. El valor
    // concreto no es sagrado; la existencia del tope si.
    assert.ok(
      Number.isFinite(MAX_REMEMBERED_TURNS),
      "MAX_REMEMBERED_TURNS debe ser un numero finito",
    );
    assert.ok(MAX_REMEMBERED_TURNS > 0, "MAX_REMEMBERED_TURNS debe ser mayor que cero");
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

  it("agent_end cierra el turno en basic, también si el perfil se omite", () => {
    const traducido = toTurnEvent({ type: "agent_end" }, TURN, "basic");
    assert.deepStrictEqual(traducido, {
      event: "turn-complete",
      data: { turnId: TURN, totalTokens: 0 },
    });
    assert.deepStrictEqual(toTurnEvent({ type: "agent_end" }, TURN), traducido);
  });

  it("un error del Runner se traduce sin filtrar su texto crudo", () => {
    // El mensaje del Runner puede llevar paths internos; el dashboard
    // recibe un código estable (spec §7).
    const traducido = toTurnEvent({ type: "error", message: "ENOENT /data/agents/x" }, TURN);
    assert.strictEqual(traducido?.event, "turn-error");
    assert.strictEqual((traducido?.data as { code: string }).code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(traducido?.data), /\/data/);
  });

  it("el razonamiento y las tools se omiten en basic", () => {
    // Mapearlos a `chunk` mezclaría razonamiento con respuesta, que es
    // peor que omitirlos. `basic` conserva explícitamente ese comportamiento.
    assert.strictEqual(toTurnEvent({ type: "thinking_delta", delta: "mmm" }, TURN, "basic"), undefined);
    assert.strictEqual(toTurnEvent({ type: "tool_start", toolName: "x" }, TURN, "basic"), undefined);
    assert.strictEqual(toTurnEvent({ type: "tool_end", toolName: "x", isError: false }, TURN, "basic"), undefined);
    assert.strictEqual(toTurnEvent({ type: "ready", agent: "a", sessionId: "s" }, TURN), undefined);
  });

  it("verbose traduce thinking_delta al evento público thinking-delta", () => {
    assert.deepStrictEqual(toTurnEvent({ type: "thinking_delta", delta: "mmm" }, TURN, "verbose"), {
      event: "thinking-delta",
      data: { turnId: TURN, delta: "mmm" },
    });
  });

  it("verbose traduce tool_start y tool_end con los campos del Runner", () => {
    assert.deepStrictEqual(toTurnEvent({ type: "tool_start", toolName: "read" }, TURN, "verbose"), {
      event: "tool-start",
      data: { turnId: TURN, toolName: "read" },
    });
    assert.deepStrictEqual(
      toTurnEvent({ type: "tool_end", toolName: "read", isError: true }, TURN, "verbose"),
      {
        event: "tool-end",
        data: { turnId: TURN, toolName: "read", isError: true },
      },
    );
  });

  it("toolName no expone paths ni argumentos del Runner", () => {
    assert.deepStrictEqual(
      toTurnEvent({ type: "tool_start", toolName: "read /data/agents/a --secret" }, TURN, "verbose"),
      {
        event: "tool-start",
        data: { turnId: TURN, toolName: "read" },
      },
    );
    assert.deepStrictEqual(
      toTurnEvent({ type: "tool_end", toolName: "/data/agents/a", isError: false }, TURN, "verbose"),
      {
        event: "tool-end",
        data: { turnId: TURN, toolName: "tool", isError: false },
      },
    );
  });

  it("agent_end se traduce a turn-aborted si el turno fue abortado", () => {
    for (const profile of ["basic", "verbose"] as const) {
      assert.deepStrictEqual(toTurnEvent({ type: "agent_end" }, TURN, profile, true), {
        event: "turn-aborted",
        data: { turnId: TURN },
      });
    }
  });

  it("un tipo desconocido se ignora en vez de romper el turno", () => {
    // El Runner puede ganar eventos nuevos sin que el Manager se entere:
    // ignorarlos es preferible a cortar un turno en curso.
    assert.strictEqual(toTurnEvent({ type: "inventado-mañana" }, TURN), undefined);
  });
});
