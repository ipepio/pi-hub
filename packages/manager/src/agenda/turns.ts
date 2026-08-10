/**
 * TurnRepository — Fase 2.3 del plan de Fase 2 (`/tmp/f2plan.md` §8).
 *
 * Absorbe la idempotencia que hoy vive en un `Map` en memoria
 * (`api-v1/turns.ts`, `routes.ts:108`) en la tabla `turns` ya migrada
 * (`migrations.ts:81-90`): la reserva es durable y global por
 * `idempotency_key UNIQUE` (§8.2). Esta fase solo fija la superficie del
 * repositorio — ninguna ruta se toca todavía; la Fase posterior la conecta.
 *
 * - `reserveIdempotency` (T7): `INSERT INTO turns` en su propia transacción.
 *   Si viola `UNIQUE(idempotency_key)`, devuelve el `turnId` existente como
 *   `{ turnId, duplicate: true }` sin re-ejecutar (§8.1); si la pareja
 *   `(agent_name, turn_id)` ya existe con otra key, `TURN_ID_CONFLICT`.
 * - `findDuplicateTurnId`: consulta `turns.idempotency_key` (global, cruza
 *   Agents, §8.2) — reproduce `isDuplicateTurn` (`api-v1/turns.ts:31`).
 * - `complete` (T6): marca el terminal del turno y el de su Initiative en la
 *   **misma transacción** — si por diseño se separaran en dos tx, una
 *   Initiative `running` con turno `succeeded` quedaría inconsistente (fila
 *   T6). El `WHERE final_state IS NULL` hace el terminal idempotente ante un
 *   doble SSE; el segundo `complete` devuelve `TURN_ALREADY_TERMINAL`. El
 *   UPDATE de la Initiative es una transición y pasa por la función pura
 *   `canTransition('running', finalState)` con CAS `WHERE state='running'`
 *   (§5.1). Mapeo SSE→`final_state` ya fijado (`routes.ts:1060-1062`):
 *   `turn-complete→succeeded`, `turn-error→failed`, `turn-aborted→cancelled`.
 *
 * Pendiente 4 (§13) — no se resuelve aquí: qué `final_state` dar a una
 * reserva cuyo proceso cayó antes del terminal; `complete` no convierte
 * reservas `final_state IS NULL` que no reciben terminal.
 */

import type { SqliteDb } from "../storage/sqlite.ts";
import { canTransition } from "./state.ts";
import { DomainError } from "./errors.ts";

/** Terminal de turno (§8.1): `turn-complete/error/aborted` → `succeeded/failed/cancelled`; P3.2 añade `paused_for_human`. */
export type TurnFinalState = "succeeded" | "failed" | "cancelled" | "paused_for_human";

/**
 * Causa del terminal `failed` (plan de Fase 3 §5.2, Fase 3.2): el catálogo
 * que `turns.complete` acepta sin dividir la transacción de T6. Sustituye el
 * literal `'turn_failed'` de Fase 2:
 * - `turn_failed`: el Runner emitió `turn-error` (`error`).
 * - `runner_unavailable`: cierre del Runner sin terminal, error de conexión
 *   o timeout de despacho.
 * - `dispatch_failed`: el Manager falló al despachar tras el claim.
 * `agent_errored` se escribe **antes** del claim (transición `queued→failed`),
 * no vía T6, y por eso no pertenece a este catálogo (§5.2).
 */
export type FailureCause = "turn_failed" | "runner_unavailable" | "dispatch_failed";

/** Resultado de reservar idempotencia (§8.2): con `duplicate: true`, `turnId` es el original. */
export interface ReserveResult {
  readonly turnId: string;
  readonly duplicate: boolean;
}

/**
 * Extrae el `errcode` SQLite de un error del driver, si lo tiene. `node:sqlite`
 * expone `errcode` (2067 = UNIQUE, 1555 = PRIMARY KEY, 787 = FK, 275 = CHECK).
 * Solo se usa para distinguir los errores de unicidad de `turns`; cualquier
 * otro error se re-propaga tal cual. Exportado para que el claim unificado
 * (Fase 3.4, `index.ts`) reutilice la misma distinción dentro de su tx.
 */
export function sqliteErrcode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === "number" ? errcode : undefined;
}

export class TurnRepository {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  /**
   * T7 (§6) — reserva durable de idempotencia. `INSERT INTO turns` en su
   * propia transacción: o la reserva queda, o no queda nada (rollback). Si la
   * `idempotency_key` ya está en la tabla (global, cruza Agents), devuelve el
   * `turnId` original con `duplicate: true` (§8.2); si la pareja
   * `(agent_name, turn_id)` ya existe con otra key, `TURN_ID_CONFLICT`.
   */
  reserveIdempotency(
    agentName: string,
    turnId: string,
    idempotencyKey: string,
    now: number,
  ): ReserveResult {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO turns (agent_name, turn_id, idempotency_key, claimed_at) VALUES (?,?,?,?)",
      ).run(agentName, turnId, idempotencyKey, now);
      db.exec("COMMIT");
      return { turnId, duplicate: false };
    } catch (error) {
      db.exec("ROLLBACK");
      // Un error de unicidad —`idempotency_key UNIQUE` (2067) o PK
      // `(agent_name, turn_id)` (1555, que es también un índice único)—
      // significa que la reserva ya existe. La key identifica el caso: si está
      // en la tabla es la misma reserva (duplicado) aunque SQLite reportara la
      // PK; si no está, es la misma pareja con otra key (`TURN_ID_CONFLICT`).
      const errcode = sqliteErrcode(error);
      if (errcode === 2067 || errcode === 1555) {
        const existing = this.findDuplicateTurnId(idempotencyKey);
        if (existing !== undefined) {
          return { turnId: existing, duplicate: true };
        }
        throw new DomainError(
          "TURN_ID_CONFLICT",
          `turno (${agentName}, ${turnId}): la pareja ya existe con otra idempotency_key`,
        );
      }
      throw error;
    }
  }

  /**
   * §8.1 — `SELECT turn_id FROM turns WHERE idempotency_key=?`. Global a
   * propósito (cruza Agents), como el `Map` actual (`routes.ts:108`); devuelve
   * `undefined` si la key nunca se reservó.
   */
  findDuplicateTurnId(idempotencyKey: string): string | undefined {
    const row = this.sqlite
      .prepare("SELECT turn_id FROM turns WHERE idempotency_key = ?")
      .get(idempotencyKey) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  /**
   * T6 (§6) — terminal de turno. `UPDATE turns` (CAS `final_state IS NULL`,
   * write-once) + `UPDATE initiatives` (transición `running→finalState` por
   * `canTransition` + CAS `WHERE state='running'`) confirmados juntos.
   *
   * El UPDATE de la Initiative puede afectar 0 filas: cuando el barrido T9 o
   * la recuperación T8 ya fallaron la Initiative antes de que llegara el
   * terminal. El turno queda entonces durablemente terminal (idempotencia,
   * `TURN_ALREADY_TERMINAL` en el siguiente `complete`) y la Initiative ya es
   * terminal por otra vía — no se reabre. `TURN_NOT_FOUND` si el turno nunca
   * se reservó, `TURN_ALREADY_TERMINAL` si ya lo está.
   *
   * Fase 3.2 — el `failure_reason` de un `failed` deja de ser el literal
   * `'turn_failed'`: `complete` acepta una causa del catálogo (`FailureCause`)
   * y la escribe en la misma transacción (fila T6 no dividida). El valor por
   * defecto conserva el comportamiento de Fase 2 para los callers previos.
   */
  complete(
    agentName: string,
    turnId: string,
    finalState: TurnFinalState,
    result: string | null,
    now: number,
    failureCause: FailureCause = "turn_failed",
  ): void {
    // P3.2: `paused_for_human` es un terminal de turno que NO pasa por T6.
    // `pauseRunningForHuman` (human-requests.ts) escribe ambas filas en una
    // transacción separada y nunca llama a `complete`. Si alguien lo intenta,
    // se rechaza explícitamente antes de tocar disco.
    if (finalState === "paused_for_human") {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `turno (${agentName}, ${turnId}): paused_for_human no se escribe por T6 (§1.4)`,
      );
    }
    // Autoridad declarativa (§5.1): el UPDATE de la Initiative es una
    // transición `running → finalState` y pasa por la función pura antes de
    // tocar disco.
    if (!canTransition("running", finalState)) {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `turno (${agentName}, ${turnId}): running -> ${finalState} no es legal (§4.2)`,
      );
    }
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Paso 2: leer la reserva dentro de la transacción para distinguir
      // `TURN_NOT_FOUND` de `TURN_ALREADY_TERMINAL`.
      const turn = db
        .prepare("SELECT final_state FROM turns WHERE agent_name = ? AND turn_id = ?")
        .get(agentName, turnId) as { final_state: TurnFinalState | null } | undefined;
      if (!turn) {
        throw new DomainError("TURN_NOT_FOUND", `turno (${agentName}, ${turnId}) no está reservado`);
      }
      if (turn.final_state !== null) {
        throw new DomainError(
          "TURN_ALREADY_TERMINAL",
          `turno (${agentName}, ${turnId}) ya es ${turn.final_state}`,
        );
      }
      // Paso 5: las dos filas de T6 en la misma transacción.
      const turnUpdate = db
        .prepare(
          `UPDATE turns SET final_state = ?, result = ?, finished_at = ?
            WHERE agent_name = ? AND turn_id = ? AND final_state IS NULL`,
        )
        .run(finalState, result, now, agentName, turnId);
      if (Number(turnUpdate.changes) !== 1) {
        throw new DomainError(
          "TURN_ALREADY_TERMINAL",
          `turno (${agentName}, ${turnId}): el CAS del terminal no cambió exactamente una fila`,
        );
      }
      // `failure_reason` es un dato estable del catálogo (§5.2); la causa
      // viaja como parámetro sin dividir la transacción de T6.
      if (finalState === "failed") {
        db.prepare(
          `UPDATE initiatives
              SET state = 'failed', failure_reason = ?,
                  result = ?, finished_at = ?, state_changed_at = ?
            WHERE agent_name = ? AND turn_id = ? AND state = 'running'`,
        ).run(failureCause, result, now, now, agentName, turnId);
      } else {
        db.prepare(
          `UPDATE initiatives
              SET state = ?, result = ?, finished_at = ?, state_changed_at = ?
            WHERE agent_name = ? AND turn_id = ? AND state = 'running'`,
        ).run(finalState, result, now, now, agentName, turnId);
      }
      db.exec("COMMIT"); // paso 6
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
