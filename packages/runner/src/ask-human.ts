/**
 * Tool `ask_human` — P3.1 del plan.
 *
 * Herramienta secuencial que permite a una Initiative pedir respuesta humana.
 * No llama a SQLite, HTTP ni Telegram: solo valida parámetros, devuelve un ack
 * con `terminate:true` y el ChatHub emite `human_input_required` en
 * `tool_execution_end`.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  ASK_HUMAN_QUESTION_MAX,
  ASK_HUMAN_SUMMARY_MAX,
  ASK_HUMAN_TOOL_NAME,
} from "@pihub/shared";

export const askHumanTool = defineTool({
  name: ASK_HUMAN_TOOL_NAME,
  label: "Ask Human",
  description: "Pause the current task and ask the human for input. The human will see your question and respond before you continue.",
  parameters: Type.Object(
    {
      question: Type.String({
        description: "The question to ask the human",
        minLength: 1,
        maxLength: ASK_HUMAN_QUESTION_MAX,
      }),
      summary: Type.String({
        description: "Brief summary of what you were doing",
        minLength: 1,
        maxLength: ASK_HUMAN_SUMMARY_MAX,
      }),
    },
    { additionalProperties: false },
  ),
  executionMode: "sequential",
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text" as const, text: "The human has been notified and will respond shortly." }],
    details: { question: params.question, summary: params.summary },
    terminate: true,
  }),
});