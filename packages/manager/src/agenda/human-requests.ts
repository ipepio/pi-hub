/**
 * HumanRequestRepository — P3.2 del plan de Fase 3 (`/tmp/plan-p3.md` §1.4, §2).
 *
 * Operación durable de pausa: `pauseRunningForHuman` escribe turno e Initiative
 * en **una sola** `BEGIN IMMEDIATE`/`COMMIT`. La garantía es que nunca hay una
 * media pausa: un turno marcado `paused_for_human` con la Initiative aún
 * `running`, o al revés.
 *
 * La transacción (plan §1.4):
 * 1. `BEGIN IMMEDIATE`
 * 2. Lee el turno `(agent_name, turn_id)` y exige `final_state IS NULL`
 * 3. Lee la Initiative por `(id, agent_name, turn_id)` y exige `state='running'`
 * 4. Valida `canTransition('running','waiting_human')` y las cotas
 * 5. CAS del turno a `final_state='paused_for_human', finished_at=now`
 * 6. CAS de la Initiative a `waiting_human`, `mode='ask'`, y fija en el mismo
 *    UPDATE `summary`, `human_question`, `human_expires_at=now+expiryMs`,
 *    `human_request_id=requestId`, `ask_correlation=toolCallId`,
 *    `state_changed_at=now` y `pending_human_input=NULL`
 * 7. COMMIT; cualquier fallo revierte ambas filas.
 *
 * Se conserva `session_key`, `bound_model`, `intent`, `started_at` y las
 * keys/hash de la respuesta anterior. Conservar estas últimas es deliberado:
 * un replay de una respuesta de la pregunta anterior no debe contestar una
 * pregunta nueva.
 */

import type { SqliteDb } from "../storage/sqlite.ts";
import { canTransition, canChangeMode } from "./state.ts";
import { DomainError } from "./errors.ts";

/** Resultado de `pauseRunningForHuman`: la Initiative ya en `waiting_human`. */
export interface HumanRequest {
  readonly initiativeId: string;
  readonly agentName: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly question: string;
  readonly summary: string;
  readonly toolCallId: string;
  readonly expiresAt: number;
}

/** Comando de `pauseRunningForHuman`: todo lo que el Manager necesita para pausar. */
export interface PauseRunningForHumanCommand {
  readonly agentName: string;
  readonly initiativeId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly question: string;
  readonly summary: string;
  readonly now: number;
  readonly expiryMs: number;
}

export class HumanRequestRepository {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  /**
   * Pausa atómica de un turno `running` + Initiative (plan §1.4, §2 P3.2).
   * Una sola `BEGIN IMMEDIATE`: o ambas filas cambian, o ninguna.
   *
   * Lanza `INITIATIVE_TRANSITION_ILLEGAL` si `running→waiting_human` no es legal
   * (bug del caller), `INITIATIVE_NOT_FOUND` si la Initiative no existe,
   * `INITIATIVE_STATE_CONFLICT` si ya no está `running` (carrera perdida),
   * `TURN_ALREADY_TERMINAL` si el turno ya tiene `final_state` (terminal
   * previo que ganó la carrera), o `TURN_NOT_FOUND` si el turno no existe.
   */
  pauseRunningForHuman(command: PauseRunningForHumanCommand): HumanRequest {
    const { agentName, initiativeId, turnId, requestId, toolCallId, question, summary, now, expiryMs } = command;

    // Validación tipada antes de abrir tx: cotas de la tool (plan §1.3).
    if (typeof question !== "string" || question.length === 0 || question.length > 1000) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: question vacía o fuera de límite (1..1000)`,
      );
    }
    if (typeof summary !== "string" || summary.length === 0 || summary.length > 500) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: summary vacío o fuera de límite (1..500)`,
      );
    }

    // Autoridad declarativa: `running→waiting_human` debe ser legal.
    if (!canTransition("running", "waiting_human")) {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `initiative ${initiativeId}: running -> waiting_human no es legal (§4.2)`,
      );
    }

    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer el turno dentro de la tx, exigir `final_state IS NULL`.
      const turn = db
        .prepare("SELECT final_state FROM turns WHERE agent_name = ? AND turn_id = ?")
        .get(agentName, turnId) as { final_state: string | null } | undefined;
      if (!turn) {
        throw new DomainError("TURN_NOT_FOUND", `turno (${agentName}, ${turnId}) no está reservado`);
      }
      if (turn.final_state !== null) {
        throw new DomainError(
          "TURN_ALREADY_TERMINAL",
          `turno (${agentName}, ${turnId}) ya es ${turn.final_state}`,
        );
      }

      // Paso 3: leer la Initiative scoped por `(id, agent_name, turn_id)`.
      const row = db
        .prepare(
          `SELECT state FROM initiatives WHERE id = ? AND agent_name = ? AND turn_id = ?`,
        )
        .get(initiativeId, agentName, turnId) as { state: string } | undefined;
      if (!row) {
        throw new DomainError(
          "INITIATIVE_NOT_FOUND",
          `initiative ${initiativeId} del agent ${agentName} con turno ${turnId} no existe`,
        );
      }
      if (row.state !== "running") {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${initiativeId}: esperaba running, durable es ${row.state}`,
        );
      }

      // Paso 5: CAS del turno a `paused_for_human`.
      const turnResult = db
        .prepare(
          `UPDATE turns SET final_state = 'paused_for_human', finished_at = ?
            WHERE agent_name = ? AND turn_id = ? AND final_state IS NULL`,
        )
        .run(now, agentName, turnId);
      if (Number(turnResult.changes) !== 1) {
        throw new DomainError(
          "TURN_ALREADY_TERMINAL",
          `turno (${agentName}, ${turnId}): el CAS del terminal no cambió exactamente una fila`,
        );
      }

      // Paso 6: CAS de la Initiative a `waiting_human` con todos los campos.
      // `human_expires_at = now + expiryMs` captura el deadline por fila.
      // `mode` se escala a `ask` si era `solo` (canChangeMode).
      // `pending_human_input` se limpia: una pregunta nueva no puede ser
      // respondida por un pending anterior.
      const initiativeResult = db
        .prepare(
          `UPDATE initiatives
              SET state = 'waiting_human',
                  state_changed_at = ?,
                  summary = ?,
                  human_question = ?,
                  human_expires_at = ?,
                  human_request_id = ?,
                  ask_correlation = ?,
                  mode = CASE WHEN mode = 'solo' THEN 'ask' ELSE mode END,
                  pending_human_input = NULL
            WHERE id = ? AND agent_name = ? AND turn_id = ? AND state = 'running'`,
        )
        .run(now, summary, question, now + expiryMs, requestId, toolCallId, initiativeId, agentName, turnId);
      if (Number(initiativeResult.changes) !== 1) {
        // Si el CAS de la Initiative falla, el turno ya se marcó `paused_for_human`;
        // el ROLLBACK revierte ambas filas (paso 6 del contrato).
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${initiativeId}: el CAS de pausa no cambió exactamente una fila (${String(initiativeResult.changes)})`,
        );
      }

      db.exec("COMMIT"); // paso 7: ambas filas se confirman juntas.
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      initiativeId,
      agentName,
      turnId,
      requestId,
      question,
      summary,
      toolCallId,
      expiresAt: now + expiryMs,
    };
  }
}