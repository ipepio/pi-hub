/**
 * Registro de idempotencia en memoria (spec §5). En memoria a
 * propósito: un turno es efímero y el Manager es el único que los
 * despacha; persistirlo exigiría un almacén que hoy no aporta nada. Si
 * el Manager reinicia, un reintento posterior ejecuta de nuevo —
 * aceptable y documentado.
 *
 * El registro está además acotado a `MAX_REMEMBERED_TURNS` entradas, con
 * expulsión de las más antiguas (FIFO por orden de inserción): sin esa
 * cota el Map crecería sin límite en un proceso de vida larga. La
 * consecuencia honesta es que una key expulsada por antigüedad se
 * comporta como una key nueva, igual que tras un reinicio.
 */
export const MAX_REMEMBERED_TURNS = 10_000;

export function rememberTurn(
  seen: Map<string, string>,
  idempotencyKey: string,
  turnId: string,
  maxEntries: number = MAX_REMEMBERED_TURNS,
): void {
  if (seen.has(idempotencyKey)) return;
  seen.set(idempotencyKey, turnId);
  while (seen.size > maxEntries) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

export function isDuplicateTurn(
  seen: Map<string, string>,
  idempotencyKey: string,
): string | undefined {
  return seen.get(idempotencyKey);
}

/** Perfil de diagnóstico de los eventos SSE del turno. */
export type TurnEventProfile = "basic" | "verbose";

/** Un evento SSE ya traducido al vocabulario de la spec §4.5. */
export interface TurnSseEvent {
  event:
    | "turn-start"
    | "chunk"
    | "thinking-delta"
    | "tool-start"
    | "tool-end"
    | "turn-complete"
    | "turn-aborted"
    | "turn-error";
  data: Record<string, unknown>;
}

/** Lo que llega por el WebSocket del Runner (`ServerWsMessage` de `@pihub/shared`). */
interface MensajeRunner {
  type: string;
  delta?: unknown;
  message?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

/**
 * Traduce un mensaje del Runner al vocabulario público de `/api/v1`.
 *
 * El Runner habla su propio protocolo por WebSocket (`agent_start`,
 * `text_delta`, `thinking_delta`, `tool_start`, `agent_end`, `error`) y
 * la spec §7 prohíbe exponer WebSockets al dashboard: el Manager es el
 * puente, y esta función es su única tabla de equivalencias.
 *
 * Devuelve `undefined` para lo que NO se reenvía:
 * - `thinking_delta` y las tools se omiten en `basic`, para no mezclar
 *   razonamiento con respuesta ni cambiar el stream actual del dashboard.
 * - `ready`, `session_new`, `model_changed` son ruido de conexión, no
 *   del turno.
 * - Cualquier tipo desconocido: el Runner puede ganar eventos nuevos sin
 *   que el Manager se entere, e ignorarlos es preferible a cortar un
 *   turno en curso.
 */
export function toTurnEvent(
  mensaje: MensajeRunner,
  turnId: string,
  eventProfile: TurnEventProfile = "basic",
  abortRequested = false,
): TurnSseEvent | undefined {
  switch (mensaje.type) {
    case "agent_start":
      return { event: "turn-start", data: { turnId } };

    case "text_delta":
      return { event: "chunk", data: { turnId, delta: textValue(mensaje.delta) } };

    case "thinking_delta":
      if (eventProfile !== "verbose") return undefined;
      return { event: "thinking-delta", data: { turnId, delta: textValue(mensaje.delta) } };

    case "tool_start":
      if (eventProfile !== "verbose") return undefined;
      return {
        event: "tool-start",
        data: { turnId, toolName: safeToolName(mensaje.toolName) },
      };

    case "tool_end":
      if (eventProfile !== "verbose") return undefined;
      return {
        event: "tool-end",
        data: {
          turnId,
          toolName: safeToolName(mensaje.toolName),
          isError: mensaje.isError === true,
        },
      };

    case "agent_end":
      if (abortRequested) return { event: "turn-aborted", data: { turnId } };
      // El Runner no reporta consumo de tokens hoy, así que se manda 0
      // en vez de inventar una cifra: un número falso sería peor que un
      // cero honesto para cualquier cálculo de coste aguas arriba.
      return { event: "turn-complete", data: { turnId, totalTokens: 0 } };

    case "error":
      // El texto del Runner puede llevar paths internos (spec §7): el
      // dashboard recibe el código estable, nunca el mensaje crudo.
      return {
        event: "turn-error",
        data: { turnId, code: "INTERNAL_ERROR", message: "Runner error" },
      };

    default:
      return undefined;
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Los nombres vienen del Runner, no de un input del caller. Solo se
 * conserva un identificador corto sin rutas, separadores ni argumentos;
 * cualquier otro formato cae en el nombre neutro para no publicar paths o
 * datos adjuntos por el protocolo interno.
 */
function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "tool";
  const firstToken = value.trim().split(/\s+/, 1)[0] ?? "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(firstToken) ||
    firstToken.includes("..")
  ) {
    return "tool";
  }
  return firstToken;
}
