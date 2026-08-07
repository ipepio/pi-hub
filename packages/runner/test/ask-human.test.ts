/**
 * Tests de la tool `ask_human` (P3.1).
 *
 * La tool se define en `ask-human.ts` como `defineTool` de pi-coding-agent.
 * Aquí se prueba:
 * - Schema y límites (ASK_HUMAN_QUESTION_MAX, ASK_HUMAN_SUMMARY_MAX).
 * - `terminate: true` en el resultado de ejecución.
 * - Ausencia de emisión en `tool_execution_start`.
 * - Emisión en `tool_execution_end` (después de incorporar el resultado).
 * - Latch: solo un `human_input_required` por prompt (evento único).
 * - Abort del batch mixto (ask_human + tools regulares).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ASK_HUMAN_TOOL_NAME, ASK_HUMAN_QUESTION_MAX, ASK_HUMAN_SUMMARY_MAX } from "@pihub/shared";
import { askHumanTool } from "../src/ask-human.ts";
import { ChatHub } from "../src/hub.ts";
import type { SessionFactory } from "../src/session.js";

/** Evento interno del SDK que el ChatHub.onEvent recibe. */
interface FakeAgentSessionEvent {
  type: string;
  toolName?: string;
  isError?: boolean;
  result?: { question?: string; summary?: string };
  toolCallId?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
}

interface FakeSession {
  isStreaming: boolean;
  subscribe: (cb: (event: FakeAgentSessionEvent) => void) => () => void;
  prompt: (text: string, opts?: unknown) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
}

/** Factory falsa que expone `create` (como SessionFactory) y captura el sink de suscripción. */
function fakeFactory() {
  const state: { aborted: boolean; sink?: (event: FakeAgentSessionEvent) => void } = { aborted: false };
  const factory = {
    sessionType: "human" as string,
    async create() {
      const session: FakeSession = {
        isStreaming: false,
        subscribe(cb) {
          state.sink = cb;
          return () => { state.sink = undefined; };
        },
        async prompt() {},
        async abort() { state.aborted = true; },
        dispose() {},
      };
      return session;
    },
    forSession() { return this; },
    async resolveModel() { return null; },
    config: { model: "test" },
  };
  return { factory: factory as unknown as SessionFactory, state };
}

/** Emite un evento interno directamente al ChatHub (vía el método onEvent). */
function emit(hub: ChatHub, event: FakeAgentSessionEvent): void {
  // ChatHub.onEvent es privado. Accedemos a él forzando el cast para
  // poder probar el comportamiento en aislamiento.
  const anyHub = hub as unknown as { onEvent: (e: FakeAgentSessionEvent) => void };
  anyHub.onEvent(event);
}

// ---------------------------------------------------------------------------
// 1. Schema y límites
// ---------------------------------------------------------------------------

test("askHumanTool tiene el nombre reservado ASK_HUMAN_TOOL_NAME", () => {
  assert.equal(askHumanTool.name, ASK_HUMAN_TOOL_NAME);
  assert.equal(ASK_HUMAN_QUESTION_MAX, 1000);
  assert.equal(ASK_HUMAN_SUMMARY_MAX, 500);
});

test("askHumanTool.parameters define question y summary con límites y sin extras", () => {
  const params = askHumanTool.parameters as Record<string, unknown>;
  assert.equal(params.additionalProperties, false, "no permite propiedades adicionales");

  const properties = params.properties as Record<string, unknown>;
  assert.ok(properties.question, "question es obligatorio");
  assert.ok(properties.summary, "summary es obligatorio");

  const q = properties.question as Record<string, unknown>;
  const s = properties.summary as Record<string, unknown>;
  assert.equal(q.maxLength, ASK_HUMAN_QUESTION_MAX, "question.maxLength");
  assert.equal(s.maxLength, ASK_HUMAN_SUMMARY_MAX, "summary.maxLength");
  assert.equal(q.minLength, 1, "question.minLength");
  assert.equal(s.minLength, 1, "summary.minLength");
});

// ---------------------------------------------------------------------------
// 2. terminate: true
// ---------------------------------------------------------------------------

test("askHumanTool.execute devuelve terminate: true con ack", async () => {
  const result = await askHumanTool.execute("call-1", {
    question: "¿Qué hora es?",
    summary: "Preguntando la hora",
  });
  assert.equal(result.terminate, true, "execute debe devolver terminate: true");
  assert.ok(Array.isArray(result.content) && result.content.length > 0, "execute devuelve content");
});

// ---------------------------------------------------------------------------
// 3. Ausencia de emisión en tool_execution_start
// ---------------------------------------------------------------------------

test("tool_execution_start para ask_human no emite human_input_required", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();
  assert.ok(state.sink, "el sink de suscripción debe estar registrado");

  const messages: Array<{ type: string }> = [];
  hub.subscribe((m) => messages.push(m));

  emit(hub, { type: "tool_execution_start", toolName: ASK_HUMAN_TOOL_NAME });

  assert.deepEqual(messages, [{ type: "tool_start", toolName: ASK_HUMAN_TOOL_NAME }],
    "tool_execution_start solo emite tool_start");
  assert.equal(messages.filter((m) => m.type === "human_input_required").length, 0,
    "no emite human_input_required en start");
});

// ---------------------------------------------------------------------------
// 4. Emisión en tool_execution_end (después de incorporar el resultado)
// ---------------------------------------------------------------------------

test("tool_execution_end de ask_human emite tool_end y luego human_input_required", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();

  const messages: Array<{ type: string; question?: string; summary?: string; toolCallId?: string }> = [];
  hub.subscribe((m) => messages.push(m));

  emit(hub, {
    type: "tool_execution_end",
    toolName: ASK_HUMAN_TOOL_NAME,
    isError: false,
    result: { question: "¿Continúo?", summary: "Resumen de la tarea" },
    toolCallId: "call-42",
  });

  assert.equal(messages.length, 2, "tool_end + human_input_required");
  assert.equal(messages[0].type, "tool_end");
  assert.equal(messages[0].toolName, ASK_HUMAN_TOOL_NAME);
  assert.equal(messages[1].type, "human_input_required");
  assert.equal(messages[1].question, "¿Continúo?");
  assert.equal(messages[1].summary, "Resumen de la tarea");
  assert.equal(messages[1].toolCallId, "call-42");
});

test("tool_execution_end de ask_human con isError no emite human_input_required", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();

  const messages: Array<{ type: string }> = [];
  hub.subscribe((m) => messages.push(m));

  emit(hub, {
    type: "tool_execution_end",
    toolName: ASK_HUMAN_TOOL_NAME,
    isError: true,
    result: { question: "x", summary: "y" },
    toolCallId: "call-err",
  });

  assert.equal(messages.length, 1, "solo tool_end cuando hay error");
  assert.equal(messages[0].type, "tool_end");
  assert.equal(messages[0].isError, true);
});

// ---------------------------------------------------------------------------
// 5. Latch: evento único por prompt
// ---------------------------------------------------------------------------

test("human_input_required se emite una sola vez por prompt (latch)", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();

  const messages: Array<{ type: string; toolCallId?: string }> = [];
  hub.subscribe((m) => messages.push(m));

  // Primer tool_execution_end para ask_human -> emite
  emit(hub, { type: "tool_execution_end", toolName: ASK_HUMAN_TOOL_NAME, isError: false, result: { question: "a", summary: "b" }, toolCallId: "1" });
  // Segundo tool_execution_end para ask_human en el MISMO prompt -> NO emite
  emit(hub, { type: "tool_execution_end", toolName: ASK_HUMAN_TOOL_NAME, isError: false, result: { question: "c", summary: "d" }, toolCallId: "2" });

  const asks = messages.filter((m) => m.type === "human_input_required");
  assert.equal(asks.length, 1, "solo un human_input_required por prompt");
  assert.equal(asks[0].toolCallId, "1", "conserva el primer toolCallId");
});

test("un prompt nuevo resetea el latch y permite otra emisión", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();

  const messages: Array<{ type: string; toolCallId?: string }> = [];
  hub.subscribe((m) => messages.push(m));

  emit(hub, { type: "tool_execution_end", toolName: ASK_HUMAN_TOOL_NAME, isError: false, result: { question: "a", summary: "b" }, toolCallId: "1" });
  await hub.prompt("siguiente");
  emit(hub, { type: "tool_execution_end", toolName: ASK_HUMAN_TOOL_NAME, isError: false, result: { question: "c", summary: "d" }, toolCallId: "2" });

  const asks = messages.filter((m) => m.type === "human_input_required");
  assert.equal(asks.length, 2, "cada prompt puede emitir un human_input_required");
});

// ---------------------------------------------------------------------------
// 6. Abort del batch mixto
// ---------------------------------------------------------------------------

test("ask_human en un batch mixto aborta la sesión tras tool_execution_end", async () => {
  const { factory, state } = fakeFactory();
  const hub = new ChatHub(factory);
  await hub.ensureSession();

  const messages: Array<{ type: string; toolName?: string }> = [];
  hub.subscribe((m) => messages.push(m));

  // Batch mixto: una tool regular y luego ask_human
  emit(hub, { type: "tool_execution_start", toolName: "memoria_leer" });
  emit(hub, { type: "tool_execution_end", toolName: "memoria_leer", isError: false, toolCallId: "t-reg" });
  emit(hub, { type: "tool_execution_start", toolName: ASK_HUMAN_TOOL_NAME });
  emit(hub, { type: "tool_execution_end", toolName: ASK_HUMAN_TOOL_NAME, isError: false, result: { question: "¿Sigo?", summary: "Resumen" }, toolCallId: "t-ask" });

  assert.ok(messages.some((m) => m.type === "human_input_required"), "emite human_input_required");
  assert.equal(state.aborted, true, "la sesión se aborta después de tool_execution_end (cinturón de seguridad)");
});