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
import { ASK_HUMAN_QUESTION_MAX, ASK_HUMAN_SUMMARY_MAX } from "@pihub/shared";

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

    // Validación tipada ANTES de abrir la tx (plan §1.3): IDs no vacíos, cotas
    // de la tool reutilizadas de @pihub/shared (no literales duplicados) y
    // aritmética de deadline sin desbordar.
    for (const [name, value] of Object.entries({ agentName, initiativeId, turnId, requestId, toolCallId })) {
      if (typeof value !== "string" || value.length === 0) {
        throw new DomainError(
          "INITIATIVE_INVARIANT_VIOLATION",
          `pauseRunningForHuman: ${name} vacío o ausente`,
        );
      }
    }
    if (typeof expiryMs !== "number" || !Number.isSafeInteger(expiryMs) || expiryMs <= 0) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: expiryMs debe ser un entero positivo (${String(expiryMs)})`,
      );
    }
    // La suma no debe desbordar: `human_expires_at = now + expiryMs` debe seguir
    // siendo un entero seguro (un `now`/`expiryMs` absurdo no lo es).
    if (!Number.isSafeInteger(now + expiryMs)) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: now + expiryMs desborda (${String(now)} + ${String(expiryMs)})`,
      );
    }
    if (typeof question !== "string" || question.length === 0 || question.length > ASK_HUMAN_QUESTION_MAX) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: question vacía o fuera de límite (1..${ASK_HUMAN_QUESTION_MAX})`,
      );
    }
    if (typeof summary !== "string" || summary.length === 0 || summary.length > ASK_HUMAN_SUMMARY_MAX) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `pauseRunningForHuman: summary vacío o fuera de límite (1..${ASK_HUMAN_SUMMARY_MAX})`,
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
// ---------------------------------------------------------------------------
// P3.4 — HumanRequestDeliveries (tabla v2 `human_request_deliveries`, A10).
//
// Seam durable de entrega de preguntas humanas al canal primario (Telegram).
// La spec A10 congela la interfaz `HumanRequestDeliveries`: `lookupDelivery`
// hace SIEMPRE el SQL exacto agent-scoped
// `WHERE agent_name = ? AND channel = ? AND external_chat_id = ? AND
// external_message_id = ?` — nunca un lookup global + filtro JS — y los IDs
// externos se normalizan con `String()`. `markDelivered` incluye TODOS los
// campos de scope y el placeholder en el `WHERE`, para que un retry tardío no
// sobrescriba otra fila.
//
// Semántica at-least-once: la reserva `external_message_id = pending:<requestId>`
// cuenta como **not_delivered** (nunca como delivered); el placeholder solo se
// sustituye por el `message_id` real tras un `sendMessage` confirmado.
// ---------------------------------------------------------------------------

/** Canal de entrega soportado (solo Telegram en schema v2). */
export type DeliveryChannel = "telegram";

/** Fila durable de `human_request_deliveries` (tabla v2, P1 §2). */
export interface HumanRequestDeliveryRow {
  readonly humanRequestId: string;
  readonly agentName: string;
  readonly initiativeId: string;
  readonly channel: DeliveryChannel;
  readonly externalChatId: string;
  readonly externalMessageId: string;
  readonly createdAt: number;
}

/**
 * Pending reconstruido: la fila de deliveries sola no basta para reintentar
 * (A10 §"Si el proceso cae entre send y update"), así que `listPendingDeliveries`
 * une agent-scoped con `initiatives` por `initiative_id` **y request actual**
 * para recuperar question/summary/expiresAt originales.
 */
export interface PendingHumanRequestDelivery extends HumanRequestDeliveryRow {
  readonly question: string;
  readonly summary: string;
  readonly expiresAt: number;
}

/** Seam durable de entregas que A10 expone (interfaz congelada por la spec). */
export interface HumanRequestDeliveries {
  recordDelivery(row: HumanRequestDeliveryRow): void;
  lookupDelivery(
    agentName: string,
    channel: DeliveryChannel,
    externalChatId: string,
    externalMessageId: string,
  ): HumanRequestDeliveryRow | null;
  markDelivered(
    agentName: string,
    humanRequestId: string,
    channel: DeliveryChannel,
    externalChatId: string,
    pendingExternalMessageId: string,
    deliveredExternalMessageId: string,
  ): void;
  listPendingDeliveries(agentName: string): readonly PendingHumanRequestDelivery[];
}

interface RawDeliveryRow {
  human_request_id: string;
  agent_name: string;
  initiative_id: string;
  channel: string;
  external_chat_id: string;
  external_message_id: string;
  created_at: number;
}

interface RawPendingRow extends RawDeliveryRow {
  question: string | null;
  summary: string | null;
  expires_at: number | null;
}

export class HumanRequestDeliveriesRepository implements HumanRequestDeliveries {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  recordDelivery(row: HumanRequestDeliveryRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO human_request_deliveries
           (human_request_id, agent_name, initiative_id, channel,
            external_chat_id, external_message_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.humanRequestId,
        row.agentName,
        row.initiativeId,
        row.channel,
        String(row.externalChatId),
        String(row.externalMessageId),
        row.createdAt,
      );
  }

  lookupDelivery(
    agentName: string,
    channel: DeliveryChannel,
    externalChatId: string,
    externalMessageId: string,
  ): HumanRequestDeliveryRow | null {
    // SQL exacto de la spec: scope completo por agent_name + channel + coords.
    // NUNCA un lookup global seguido de filtro JS (A10).
    const raw = this.sqlite
      .prepare(
        `SELECT human_request_id, agent_name, initiative_id, channel,
                external_chat_id, external_message_id, created_at
           FROM human_request_deliveries
          WHERE agent_name = ? AND channel = ? AND external_chat_id = ?
            AND external_message_id = ?`,
      )
      .get(agentName, channel, String(externalChatId), String(externalMessageId)) as
      | RawDeliveryRow
      | undefined;
    if (!raw) return null;
    return {
      humanRequestId: raw.human_request_id,
      agentName: raw.agent_name,
      initiativeId: raw.initiative_id,
      channel: raw.channel as DeliveryChannel,
      externalChatId: raw.external_chat_id,
      externalMessageId: raw.external_message_id,
      createdAt: raw.created_at,
    };
  }

  markDelivered(
    agentName: string,
    humanRequestId: string,
    channel: DeliveryChannel,
    externalChatId: string,
    pendingExternalMessageId: string,
    deliveredExternalMessageId: string,
  ): void {
    // El WHERE lleva todos los campos de scope MÁS el placeholder: un retry
    // tardío solo sustituye la fila pending exacta, nunca una ya entregada.
    this.sqlite
      .prepare(
        `UPDATE human_request_deliveries
            SET external_message_id = ?
          WHERE agent_name = ? AND human_request_id = ? AND channel = ?
            AND external_chat_id = ? AND external_message_id = ?`,
      )
      .run(
        String(deliveredExternalMessageId),
        agentName,
        humanRequestId,
        channel,
        String(externalChatId),
        String(pendingExternalMessageId),
      );
  }

  listPendingDeliveries(agentName: string): readonly PendingHumanRequestDelivery[] {
    // Join agent-scoped con initiatives por initiative_id Y request actual
    // (i.human_request_id = d.human_request_id): una pregunta nueva sobre la
    // misma Initiative no reconstruye el contenido de un pending viejo.
    const rows = this.sqlite
      .prepare(
        `SELECT d.human_request_id, d.agent_name, d.initiative_id, d.channel,
                d.external_chat_id, d.external_message_id, d.created_at,
                i.human_question AS question, i.summary AS summary,
                i.human_expires_at AS expires_at
           FROM human_request_deliveries d
           JOIN initiatives i
             ON i.id = d.initiative_id AND i.agent_name = d.agent_name
            AND i.human_request_id = d.human_request_id
          WHERE d.agent_name = ? AND d.channel = 'telegram'
            AND d.external_message_id LIKE 'pending:%'
          ORDER BY d.created_at, d.external_message_id`,
      )
      .all(agentName) as RawPendingRow[];
    return rows.map((raw) => ({
      humanRequestId: raw.human_request_id,
      agentName: raw.agent_name,
      initiativeId: raw.initiative_id,
      channel: raw.channel as DeliveryChannel,
      externalChatId: raw.external_chat_id,
      externalMessageId: raw.external_message_id,
      createdAt: raw.created_at,
      question: raw.question ?? "",
      summary: raw.summary ?? "",
      expiresAt: raw.expires_at ?? 0,
    }));
  }
}
