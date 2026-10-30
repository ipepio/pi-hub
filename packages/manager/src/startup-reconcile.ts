/**
 * Reconciliación al arranque de las reservas de admisión DURABLES (T4-D/2).
 *
 * T4-D/1 dejó la admisión «un turno por Agent» (S2) en `agent_live_turns` y el
 * arranque carga esas filas como «no verificadas»: el Agent queda bloqueado
 * (fail-closed) porque el Runner puede seguir ejecutando ese turno o haberse muerto
 * con el Manager anterior. Verificar es lo que faltaba — una fila huérfana bloquea al
 * Agent para siempre si nadie la cierra.
 *
 * Este módulo hace la PREGUNTA y `TurnExecution.reconcileUnverified` aplica la
 * respuesta: la política vive en un solo sitio y el registro nunca queda a medias
 * entre dos `await`. Orden del arranque: `startAll` (los Runners existen) →
 * `createTurns` (`loadUnverified`) → esto → `createApp`.
 *
 * POLÍTICA (fail-closed, NUNCA adopta el turno):
 *  1. Runner en marcha + gate ocupada + titular == identidad de la fila → CONFIRMADO.
 *  2. Runner en marcha + gate libre                                    → HUÉRFANO.
 *  3. Runner parado/errored/sin puerto                                 → HUÉRFANO.
 *  4. Runner en marcha + gate ocupada por OTRA identidad, o `/api/status` ilegible o
 *     sin el campo `execution`                                         → NO RESUELTO.
 *
 * IDENTIDAD del titular: `ExecutionGate` la toma con el `label` de la hub, y
 * `SessionHubRegistry.forKey` etiqueta cada hub keyed con la `sessionKey` de la URL
 * (`default` cuando viene vacía). El Manager abre el turno con
 * `…/ws?sessionKey=<sessionKey>`, así que el titular es la `sessionKey` del turno: la
 * MISMA columna (`session_key`) que guardó la fila durable. No se compara el `turnId`
 * porque la gate no lo conoce. Una fila sin `session_key` no se puede comparar con
 * nada y queda NO RESUELTA.
 *
 * Se documenta a propósito el límite conocido: un turno CONFIRMADO puede terminar en
 * el Runner, pero su terminal viaja por el socket del Manager anterior (muerto). Esta
 * reconciliación no re-engancha el SSE ni adopta el WS; la fila se libera en un
 * arranque posterior. Es fail-closed por diseño, no un olvido.
 *
 * NUNCA lanza: un `fetch`/parseo que falla para un Agent es NO RESUELTO para ese
 * Agent (se conserva todo y se loguea). Un fallo del almacén devuelve el resultado
 * vacío sin tocar nada.
 */

import type { LiveTurnStore } from "./storage/live-turns.ts";

/**
 * Vista mínima del Supervisor: estado del proceso del Agent y puerto del Runner.
 * Estructural y no la clase, para que el llamador (arranque) y los tests usen la
 * misma costura.
 */
export interface SupervisorRuntimeView {
  state(name: string): { readonly state: string };
  runnerPortOf(name: string): number | undefined;
}

/** Respuesta HTTP mínima del Runner (`fetch` real o doble de test). */
export interface StatusResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** `fetch` inyectable: el test observa la URL y el header sin abrir sockets. */
export type StatusFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<StatusResponseLike>;

/** Aplicador de la reconciliación (`TurnExecution.reconcileUnverified`). */
export interface LiveTurnReconcileTarget {
  reconcileUnverified(
    resolutions: ReadonlyArray<{
      readonly agentName: string;
      readonly turnId: string;
      readonly outcome: "confirmed" | "orphaned";
    }>,
  ): { confirmed: number; orphaned: number; deferred: number };
}

export interface ReconcileLiveTurnsDeps {
  /** Reservas durables que sobrevivieron al proceso anterior (`listLiveTurns`). */
  readonly liveTurns: Pick<LiveTurnStore, "listLiveTurns">;
  readonly supervisor: SupervisorRuntimeView;
  readonly turns: LiveTurnReconcileTarget;
  /** HTTP del Runner. Por defecto el `fetch` global; el test lo sustituye. */
  readonly fetchImpl?: StatusFetch;
  /**
   * Token de servicio para `Bearer`. El `GET /api/status` del Runner vive detrás de
   * `/api/*`, así que con `API_TOKEN` configurado exige autenticación; vacío = sin
   * cabecera (Runner sin token). El endpoint sigue siendo loopback-only.
   */
  readonly apiToken?: string;
  /** Reloj del Manager (edad de la reserva en el log; tests sin tiempo real). */
  readonly now?: () => number;
  /** Log estructurado; el arranque pasa el suyo. */
  readonly log?: (line: string) => void;
  /** Cota por Agent para no colgar el arranque en un Runner mudo (default 2 s). */
  readonly timeoutMs?: number;
}

/** Resultado observable del arranque (§ log). */
export interface LiveTurnReconcileOutcome {
  /** Turnos que el Runner sigue ejecutando: se conservan (Agent bloqueado). */
  readonly confirmed: number;
  /** Turnos liberados: fila borrada + `failed`/`turn_orphaned` + admisión libre. */
  readonly orphaned: number;
  /** Turnos sin evidencia suficiente: se conservan (fail-closed). */
  readonly unresolved: number;
  /** Huérfanos cuya escritura durable falló: se conservan (fail-closed). */
  readonly deferred: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * `fetch` global visto por la costura estrecha: `Response` ya cumple
 * `StatusResponseLike` (`ok`, `status`, `json`), así que no hace falta ningún cast.
 */
const DEFAULT_FETCH: StatusFetch = async (url, init) => fetch(url, init);

/**
 * Identidad de la hub que ejecuta, derivada de la `sessionKey` del turno: la misma
 * regla que `SessionHubRegistry.forKey` (recorte y `default` cuando está vacía).
 * `undefined` = la fila no tiene sesión y no hay nada con lo que comparar.
 */
export function hubLabelOf(sessionKey: string | null): string | undefined {
  if (sessionKey === null) return undefined;
  return sessionKey.trim() || "default";
}

/** `execution` del `/api/status`; `undefined` si la respuesta no lo trae o no encaja. */
function parseExecution(payload: unknown): { busy: boolean; holder: string | null } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const execution = (payload as { execution?: unknown }).execution;
  if (typeof execution !== "object" || execution === null) return undefined;
  const { busy, holder } = execution as { busy?: unknown; holder?: unknown };
  if (typeof busy !== "boolean") return undefined;
  if (holder !== null && typeof holder !== "string") return undefined;
  return { busy, holder };
}

/**
 * Resuelve cada reserva durable contra el Runner y aplica el resultado.
 *
 * No lanza nunca: cualquier fallo (almacén, HTTP, JSON) deja ese turno como estaba y
 * se cuenta como `unresolved`; solo una escritura durable fallida de un huérfano se
 * cuenta como `deferred`, porque ahí la decisión ya está tomada y lo que falló fue
 * publicarla.
 */
export async function reconcileLiveTurns(
  deps: ReconcileLiveTurnsDeps,
): Promise<LiveTurnReconcileOutcome> {
  const log = deps.log ?? ((line: string) => console.error(`[pihub] ${line}`));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? DEFAULT_FETCH;

  let rows: ReturnType<LiveTurnStore["listLiveTurns"]> = [];
  try {
    rows = deps.liveTurns.listLiveTurns();
  } catch (error) {
    // Sin la lista no hay nada que reconciliar: las filas siguen en disco y el
    // próximo arranque lo intenta. Leer mal el registro no puede tumbar el arranque.
    log(`LIVE_TURNS_RECONCILE_FAILED reason=store detail=${String(error)}`);
    return { confirmed: 0, orphaned: 0, unresolved: 0, deferred: 0 };
  }

  const resolutions: Array<{
    agentName: string;
    turnId: string;
    outcome: "confirmed" | "orphaned";
  }> = [];
  let unresolved = 0;

  for (const row of rows) {
    const label = `agent=${row.agentName} turn=${row.turnId} age_ms=${Math.max(0, now() - row.startedAt)}`;
    const { state } = deps.supervisor.state(row.agentName);

    if (state !== "running") {
      log(`LIVE_TURN_ORPHANED ${label} reason=runner_${state}`);
      resolutions.push({ agentName: row.agentName, turnId: row.turnId, outcome: "orphaned" });
      continue;
    }

    const port = deps.supervisor.runnerPortOf(row.agentName);
    if (port === undefined) {
      // El Supervisor dice «en marcha» pero no hay puerto: sin Runner alcanzable no
      // hay ejecución que conservar (y sin puerto no hay nada que preguntar).
      log(`LIVE_TURN_ORPHANED ${label} reason=no_runner_port`);
      resolutions.push({ agentName: row.agentName, turnId: row.turnId, outcome: "orphaned" });
      continue;
    }

    let execution: { busy: boolean; holder: string | null } | undefined;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/status`, {
        headers: deps.apiToken ? { authorization: `Bearer ${deps.apiToken}` } : {},
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (response.ok) execution = parseExecution(await response.json());
    } catch (error) {
      log(`LIVE_TURN_UNRESOLVED ${label} reason=status_unreadable detail=${String(error)}`);
      unresolved += 1;
      continue;
    }

    if (execution === undefined) {
      // Runner anterior al campo `execution`, JSON inesperado o 401/5xx: no hay
      // evidencia de que el turno muriera, así que no se libera nada.
      log(`LIVE_TURN_UNRESOLVED ${label} reason=status_without_execution`);
      unresolved += 1;
      continue;
    }

    if (!execution.busy) {
      log(`LIVE_TURN_ORPHANED ${label} reason=gate_idle`);
      resolutions.push({ agentName: row.agentName, turnId: row.turnId, outcome: "orphaned" });
      continue;
    }

    const expected = hubLabelOf(row.sessionKey);
    if (expected !== undefined && execution.holder === expected) {
      // El Runner sigue ejecutando ESTE turno. Se conserva la reserva: el Agent no
      // puede admitir un segundo turno mientras el primero corre.
      log(`LIVE_TURN_CONFIRMED ${label} holder=${execution.holder}`);
      resolutions.push({ agentName: row.agentName, turnId: row.turnId, outcome: "confirmed" });
      continue;
    }

    // Gate ocupada por otra ejecución (o por una identidad que no se puede comparar):
    // sin prueba de identidad no se libera nada. El siguiente arranque reconcilia.
    log(
      `LIVE_TURN_UNRESOLVED ${label} reason=holder_mismatch expected=${expected ?? "unknown"} holder=${execution.holder ?? "null"}`,
    );
    unresolved += 1;
  }

  try {
    const applied = deps.turns.reconcileUnverified(resolutions);
    return {
      confirmed: applied.confirmed,
      orphaned: applied.orphaned,
      unresolved,
      deferred: applied.deferred,
    };
  } catch (error) {
    log(`LIVE_TURNS_RECONCILE_FAILED reason=apply detail=${String(error)}`);
    return { confirmed: 0, orphaned: 0, unresolved, deferred: 0 };
  }
}
