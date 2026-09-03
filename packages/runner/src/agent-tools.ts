/**
 * Tools `schedule_trigger` y `revoke_trigger` (pihub step 2b).
 *
 * Son herramientas secuenciales que un agente autoridad (Initiative) usa para
 * gobernar sus propios Triggers de autonomía contra el Manager. Siguen el patrón
 * de `ask-human.ts` (defineTool de pi-coding-agent + schemas typebox), pero se
 * construyen en una factory porque necesitan los valores CAPTURADOS del entorno
 * (`managerPort`, `apiToken`) y el nombre del agente — nunca `process.env`, que
 * el scrub ya limpió (R1-001).
 *
 * La identidad se declara vía los headers de principal ligados al agente
 * (`PIHUB_PRINCIPAL_HEADER`/`PIHUB_RUNNER_PRINCIPAL` y `PIHUB_AGENT_HEADER`),
 * y la idempotencia via el header `Idempotency-Key` (el Manager no lo acepta en
 * el body: su schema de entrada es `.strict()` y rechazaría la clave extra).
 */

import { Type } from "typebox";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  PIHUB_PRINCIPAL_HEADER,
  PIHUB_RUNNER_PRINCIPAL,
  PIHUB_AGENT_HEADER,
  SCHEDULE_TRIGGER_TOOL_NAME,
  REVOKE_TRIGGER_TOOL_NAME,
  ASK_HUMAN_TOOL_NAME,
} from "@pihub/shared";
import type { PihubEnv } from "@pihub/shared";

import { askHumanTool } from "./ask-human.ts";

/** `HH:mm` estricto (`00:00`–`23:59`), igual que el Manager. */
const AT_PATTERN = "^([01]\\d|2[0-3]):([0-5]\\d)$";

/** Día de la semana del catálogo (valores exactos que valida el Manager). */
const WEEKDAY_VALUES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

/**
 * Miembro privado para el resultado de una llamada HTTP al Manager. `ok` refleja
 * el status 2xx; `status` y `data` se conservan para traducción de errores.
 */
interface ManagerCall {
  readonly ok: boolean;
  readonly status: number;
  readonly data: Record<string, unknown>;
}

/**
 * POST al Manager con la identidad de principal ligada al agente y los valores
 * de entorno capturados (jamás process.env). Distintos del helper
 * `forwardToManager` de server.ts porque aquí la identidad Runner y la
 * idempotencia son obligatorias y no hay cookie de sesión.
 */
async function postToManager(
  env: PihubEnv,
  agentName: string,
  route: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ManagerCall> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-correlation-id": randomUUID(),
    [PIHUB_PRINCIPAL_HEADER]: PIHUB_RUNNER_PRINCIPAL,
    [PIHUB_AGENT_HEADER]: agentName,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (env.apiToken) headers.authorization = `Bearer ${env.apiToken}`;
  try {
    const response = await fetch(
      `http://127.0.0.1:${env.managerPort}${route}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      data: {
        code: "INTERNAL_ERROR",
        message: `Manager inaccesible: ${(error as Error).message}`,
      },
    };
  }
}

/** Texto legible para el modelo de un error del Manager (code + message verbatim). */
function errorText(data: Record<string, unknown>): string {
  const code = typeof data.code === "string" ? data.code : "INTERNAL_ERROR";
  const message =
    typeof data.message === "string" ? data.message : "unknown error";
  return `${code}: ${message}`;
}

/** Extrae id y próxima ejecución leída del Trigger devuelto por el Manager. */
function triggerId(data: Record<string, unknown>): string {
  const trigger = data.trigger as Record<string, unknown> | undefined;
  return typeof trigger?.id === "string" ? trigger.id : "unknown";
}

function nextFireText(data: Record<string, unknown>): string {
  const trigger = data.trigger as Record<string, unknown> | undefined;
  const nextFireAt = trigger?.nextFireAt;
  if (typeof nextFireAt === "number") return new Date(nextFireAt).toISOString();
  if (typeof nextFireAt === "string") return nextFireAt;
  return "unknown";
}

/**
 * Crea el conjunto de herramientas del agente para sesiones de Initiative:
 * las tres tools (ask_human + schedule_trigger + revoke_trigger). Las sesiones
 * human NO las reciben (son `customTools`, solo se inyectan cuando la sesión es
 * initiative).
 */
export function createAgentTools(
  env: PihubEnv,
  agentName: string,
): ToolDefinition[] {
  const scheduleTriggerTool = defineTool({
    name: SCHEDULE_TRIGGER_TOOL_NAME,
    label: "Schedule Trigger",
    description:
      "Schedule a recurring agent trigger. Each time it fires, you will be asked to execute the described intent. Use a stable idempotencyKey to retry safely without creating duplicates.",
    parameters: Type.Object(
      {
        schedule: Type.Object(
          {
            version: Type.Literal(2, {
              description:
                "Current scheduled-trigger format version. Always 2.",
            }),
            kind: Type.Union([Type.Literal("daily"), Type.Literal("weekly")], {
              description:
                "Repeat daily, or on the given weekday(s) of a weekly cycle.",
            }),
            timeZone: Type.String({
              description:
                'IANA time zone (e.g. "America/New_York", "UTC") that anchors the scheduled time.',
              minLength: 1,
            }),
            at: Type.String({
              description:
                'Civil clock time in "HH:MM" 24-hour format (00:00–23:59) within the given time zone.',
              pattern: AT_PATTERN,
            }),
            days: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Literal("mon"),
                  Type.Literal("tue"),
                  Type.Literal("wed"),
                  Type.Literal("thu"),
                  Type.Literal("fri"),
                  Type.Literal("sat"),
                  Type.Literal("sun"),
                ]),
                {
                  description:
                    "Weekday(s) to fire on (required only for kind=weekly).",
                },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        intent: Type.String({
          description:
            "Natural-language description of what you must do each time this trigger fires.",
          minLength: 1,
        }),
        mode: Type.Optional(
          Type.Union([Type.Literal("solo"), Type.Literal("ask")], {
            description:
              'How the fired initiative runs: "solo" (autonomous, default) or "ask" (pause for human input).',
          }),
        ),
        suggestedSkill: Type.Optional(
          Type.String({
            description:
              "Optional skill name to seed the fired initiative with.",
          }),
        ),
        idempotencyKey: Type.Optional(
          Type.String({
            description:
              "Optional stable key. Pass the SAME key when retrying to guarantee exactly-once creation; if omitted the tool generates a fresh identifier.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const idempotencyKey =
        params.idempotencyKey && params.idempotencyKey.trim() !== ""
          ? params.idempotencyKey.trim()
          : randomUUID();
      const body: Record<string, unknown> = {
        definition: params.schedule,
        intent: params.intent,
        mode: params.mode ?? "solo",
        suggestedSkill: params.suggestedSkill ?? null,
      };
      const result = await postToManager(
        env,
        agentName,
        `/api/v1/agents/${encodeURIComponent(agentName)}/triggers`,
        body,
        idempotencyKey,
      );
      // Un único objeto `details` (misma forma en éxito y error) para que el
      // generic TDetails de defineTool quede estable.
      const details = {
        idempotencyKey,
        status: result.status,
        triggerId: (result.ok ? triggerId(result.data) : null) as string | null,
      };
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: errorText(result.data) }],
          details,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Trigger scheduled (id: ${details.triggerId}, next fire: ${nextFireText(result.data)})`,
          },
        ],
        details,
      };
    },
  });

  const revokeTriggerTool = defineTool({
    name: REVOKE_TRIGGER_TOOL_NAME,
    label: "Revoke Trigger",
    description:
      "Revoke a previously scheduled agent trigger by its id so it stops firing. Use the id that schedule_trigger returned.",
    parameters: Type.Object(
      {
        triggerId: Type.String({
          description: "Id of the scheduled trigger to revoke.",
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      // El handler de revoke del Manager no exige Idempotency-Key (solo requiera
      // identidad de principal + el id de ruta), así que no se envía clave.
      const result = await postToManager(
        env,
        agentName,
        `/api/v1/agents/${encodeURIComponent(agentName)}/triggers/${encodeURIComponent(params.triggerId)}/revoke`,
        {},
      );
      const details = { status: result.status };
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: errorText(result.data) }],
          details,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Trigger ${params.triggerId} revoked`,
          },
        ],
        details,
      };
    },
  });

  return [askHumanTool, scheduleTriggerTool, revokeTriggerTool];
}
