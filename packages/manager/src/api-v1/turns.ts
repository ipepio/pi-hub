/**
 * Registro de idempotencia en memoria (spec §5). En memoria a
 * propósito: un turno es efímero y el Manager es el único que los
 * despacha; persistirlo exigiría un almacén que hoy no aporta nada. Si
 * el Manager reinicia, un reintento posterior ejecuta de nuevo —
 * aceptable y documentado.
 */
export function rememberTurn(
  seen: Map<string, string>,
  idempotencyKey: string,
  turnId: string,
): void {
  if (!seen.has(idempotencyKey)) seen.set(idempotencyKey, turnId);
}

export function isDuplicateTurn(
  seen: Map<string, string>,
  idempotencyKey: string,
): string | undefined {
  return seen.get(idempotencyKey);
}

/** Un evento SSE ya traducido al vocabulario de la spec §4.5. */
export interface TurnSseEvent {
  event: "turn-start" | "chunk" | "turn-complete" | "turn-error";
  data: Record<string, unknown>;
}

/** Lo que llega por el WebSocket del Runner (`ServerWsMessage` de `@pihub/shared`). */
interface MensajeRunner {
  type: string;
  delta?: string;
  message?: string;
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
 * - `thinking_delta` y las tools no están en el vocabulario del
 *   dashboard. Mapearlos a `chunk` mezclaría razonamiento con respuesta,
 *   que es peor que omitirlos.
 * - `ready`, `session_new`, `model_changed` son ruido de conexión, no
 *   del turno.
 * - Cualquier tipo desconocido: el Runner puede ganar eventos nuevos sin
 *   que el Manager se entere, e ignorarlos es preferible a cortar un
 *   turno en curso.
 */
export function toTurnEvent(mensaje: MensajeRunner, turnId: string): TurnSseEvent | undefined {
  switch (mensaje.type) {
    case "agent_start":
      return { event: "turn-start", data: { turnId } };

    case "text_delta":
      return { event: "chunk", data: { turnId, delta: mensaje.delta ?? "" } };

    case "agent_end":
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
