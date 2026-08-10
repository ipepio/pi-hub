/**
 * InitiativeRepository — Fase 2.2 del plan de Fase 2 (`/tmp/f2plan.md`).
 *
 * Todo comando de escritura sigue el contrato de seis pasos del §5, sin
 * excepción:
 *   1. `BEGIN IMMEDIATE`
 *   2. leer la Initiative dentro de la transacción
 *   3. `canTransition` (autoridad declarativa, §5.1) decide antes de tocar
 *      disco — o `INITIATIVE_TRANSITION_ILLEGAL`
 *   4. validar invariantes multi-fila (4 y 6 del esquema; los `CHECK` de fila
 *      ya los cubre el motor)
 *   5. escribir por CAS: `UPDATE ... WHERE id=:id AND state=:expected_from`;
 *      si no cambia **exactamente una fila** → `INITIATIVE_STATE_CONFLICT` y
 *      rollback
 *   6. confirmar todas las filas relacionadas en el mismo `COMMIT`
 *
 * `canTransition` es la autoridad declarativa (qué es legal); el `WHERE
 * state=:expected_from` es la autoridad operativa (quién gana la carrera,
 * §5.1). La legalidad se juzga sobre el `from` **declarado por el caller**:
 * si el estado durable ya no es ese, no es un bug sino una carrera
 * (`INITIATIVE_STATE_CONFLICT`, distinto de `INITIATIVE_TRANSITION_ILLEGAL`,
 * §12.4).
 *
 * El único bypass del contrato es `recoverRunningOnStartup` (ADR 0007, §5.2),
 * que vive en `recovery.ts`. No hay ningún otro camino que escriba estado sin
 * pasar por la función pura: los barridos T9/T10 solo tocan filas cuyo estado
 * está en `legalSourcesFor(...)` — la propia `canTransition` aplicada en lote.
 */

import { createHash } from "node:crypto";
import type { SqliteDb } from "../storage/sqlite.ts";
import {
  canTransition,
  canChangeMode,
  isTerminal,
  legalSourcesFor,
  type InitiativeMode,
  type InitiativeState,
} from "./state.ts";
import { DomainError } from "./errors.ts";

/**
 * Límite interno tipado de `answer` (plan P1 §6.3): una respuesta humana se
 * acepta no vacía y con esta cota; P2 la reutilizará en el borde HTTP sin
 * reabrir el dominio.
 */
export const MAX_HUMAN_ANSWER_LENGTH = 4000;

/** Initiative tal y como la expone el repositorio (columnas en camelCase). */
export interface Initiative {
  readonly id: string;
  readonly agentName: string;
  readonly state: InitiativeState;
  readonly origin: "trigger" | "callback" | "human";
  readonly triggerId: string | null;
  readonly intent: string;
  readonly mode: InitiativeMode;
  readonly sessionKey: string;
  readonly availableAt: number;
  readonly boundModel: string | null;
  readonly turnId: string | null;
  readonly chainDepth: number;
  readonly chainDeadlineAt: number | null;
  readonly visibleEffectsDeclared: boolean;
  readonly summary: string | null;
  readonly askCorrelation: string | null;
  readonly failureReason: string | null;
  readonly result: string | null;
  readonly createdAt: number;
  readonly stateChangedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** P3.2: pregunta, deadline y request ID de la espera humana actual. */
  readonly humanQuestion: string | null;
  readonly humanExpiresAt: number | null;
  readonly humanRequestId: string | null;
}

/**
 * Comando de `respondForAgent` (plan P1 §6.3): la persona responde a una
 * Initiative en `waiting_human` con `answer` y una `idempotencyKey` de
 * respuesta. No crea Conversation ni despacha al Runner; el Loop sigue siendo
 * el dispatcher único.
 */
export interface RespondForAgentCommand {
  readonly id: string;
  readonly agentName: string;
  readonly answer: string;
  readonly idempotencyKey: string;
  readonly now: number;
  /**
   * P3.2/B1: request humano que el respondedor declara estar contestando.
   * Cuando no es null, el CAS exige `human_request_id = expected`; un valor
   * viejo no contesta la pregunta nueva. `null`/ausente = comportamiento
   * actual (retrocompatible). A14 lo envía desde la delivery de Telegram;
   * el panel (A11) lo envía con el `human_request_id` que muestra.
   */
  readonly expectedHumanRequestId?: string | null;
}

/**
 * Resultado de `respondForAgent`: la Initiative tras el comando y si fue un
 * replay idempotente (`replayed:true` no reencola ni vuelve a tocar disco).
 */
export interface RespondForAgentResult {
  readonly initiative: Initiative;
  readonly replayed: boolean;
}

function respondCommandHash(initiativeId: string, humanRequestId: string | null, answer: string): string {
  const canonical = JSON.stringify({ initiativeId, humanRequestId, answer });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Comando tipado de transición (§5 paso 3). `from` es el estado que el caller
 * leyó; `to`, el destino. Los campos opcionales se interpretan según el par
 * (`from`,`to`) — ver `buildPatch`. Un campo obligatorio ausente para esa
 * transición lanza `INITIATIVE_INVARIANT_VIOLATION` (§5 paso 4).
 */
export interface TransitionCommand {
  readonly id: string;
  readonly from: InitiativeState;
  readonly to: InitiativeState;
  readonly now: number;
  /** `running→waiting_human` — obligatorio (el `CHECK` del motor lo respalda). */
  readonly summary?: string;
  /** `running→waiting_human` — se conserva si llega (forma: pendiente 11). */
  readonly askCorrelation?: string;
  /** `running→waiting_agent` — obligatorio (invariante 6). */
  readonly chainDeadlineAt?: number;
  /** `waiting_human|waiting_agent→queued` (reanudación) — obligatorio. */
  readonly availableAt?: number;
  /** `queued→running` — enlaza el turno despachado. */
  readonly turnId?: string;
  /** `queued→running` — solo se fija si `bound_model` era NULL (invariante 4). */
  readonly boundModel?: string;
  /** `running→succeeded` — el resultado observado en el terminal. */
  readonly result?: string;
  /** `→failed` — obligatorio; `failure_reason` es un dato estable (§9.1). */
  readonly failureReason?: string;
}

/** Fila cruda de `initiatives` (snake_case, tal y como la devuelve el driver). */
interface InitiativeRow {
  id: string;
  agent_name: string;
  state: InitiativeState;
  origin: "trigger" | "callback" | "human";
  trigger_id: string | null;
  intent: string;
  mode: InitiativeMode;
  session_key: string;
  available_at: number;
  bound_model: string | null;
  turn_id: string | null;
  chain_depth: number;
  chain_deadline_at: number | null;
  visible_effects_declared: number;
  summary: string | null;
  ask_correlation: string | null;
  failure_reason: string | null;
  result: string | null;
  created_at: number;
  state_changed_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** Columnas v2 de reserva de P3 (plan P1 §2.3); leídas por respond/claim. */
  pending_human_input: string | null;
  human_response_idempotency_key: string | null;
  human_response_command_hash: string | null;
  /** Columnas v2 de espera humana (P3.2): cuestión, deadline, request ID. */
  human_question: string | null;
  human_expires_at: number | null;
  human_request_id: string | null;
}

const SELECT_INITIATIVE = `
  SELECT id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at,
         pending_human_input, human_response_idempotency_key,
         human_response_command_hash,
         human_question, human_expires_at, human_request_id
    FROM initiatives
`;

function mapRow(row: InitiativeRow): Initiative {
  return {
    id: row.id,
    agentName: row.agent_name,
    state: row.state,
    origin: row.origin,
    triggerId: row.trigger_id,
    intent: row.intent,
    mode: row.mode,
    sessionKey: row.session_key,
    availableAt: row.available_at,
    boundModel: row.bound_model,
    turnId: row.turn_id,
    chainDepth: row.chain_depth,
    chainDeadlineAt: row.chain_deadline_at,
    visibleEffectsDeclared: row.visible_effects_declared === 1,
    summary: row.summary,
    askCorrelation: row.ask_correlation,
    humanQuestion: row.human_question,
    humanExpiresAt: row.human_expires_at,
    humanRequestId: row.human_request_id,
    failureReason: row.failure_reason,
    result: row.result,
    createdAt: row.created_at,
    stateChangedAt: row.state_changed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class InitiativeRepository {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  /** Lee una Initiative por `id`; `INITIATIVE_NOT_FOUND` si no existe (§9.1). */
  get(id: string): Initiative {
    const row = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE id = ?`)
      .get(id) as InitiativeRow | undefined;
    if (!row) {
      throw new DomainError("INITIATIVE_NOT_FOUND", `initiative ${id} no existe`);
    }
    return mapRow(row);
  }

  /**
   * Lectura agent-scoped (plan P1 §6.1): toda la superficie de autonomía
   * cualifica por `(id, agent_name)`. Un ID de otra Agenda es exactamente
   * `INITIATIVE_NOT_FOUND`, indistinguible de uno inexistente; está prohibido
   * el `get(id)` global seguido de comparación en JS.
   */
  getForAgent(id: string, agentName: string): Initiative {
    const row = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE id = ? AND agent_name = ?`)
      .get(id, agentName) as InitiativeRow | undefined;
    if (!row) {
      throw new DomainError(
        "INITIATIVE_NOT_FOUND",
        `initiative ${id} del agent ${agentName} no existe`,
      );
    }
    return mapRow(row);
  }

  /**
   * Cancelación de los estados **en reposo** (plan P1 §6.2): `queued`,
   * `waiting_human` y `waiting_agent` → `cancelled` por CAS agent-scoped
   * (`UPDATE ... WHERE id=? AND agent_name=? AND state=?`), con
   * `finished_at=state_changed_at=now` y limpieza de `pending_human_input`
   * (una Initiative cancelada no conserva respuesta pendiente). Sigue el
   * contrato de seis pasos: `canTransition(from,"cancelled")` antes de tocar
   * disco y cero filas del CAS es `INITIATIVE_STATE_CONFLICT`.
   *
   * `running` **nunca** se escribe aquí: Control la detecta antes y va por
   * `TurnExecution.abort`; si una carrera la deja `running` entre la lectura
   * de Control y este CAS, es conflicto de estado, no cancelación.
   * `cancelled` repetido es éxito idempotente sin escritura; cualquier otro
   * terminal (`succeeded|failed|expired`) es `INITIATIVE_STATE_CONFLICT`.
   */
  cancelForAgent(id: string, agentName: string, now: number): Initiative {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer dentro de la transacción, scoped por `(id, agent_name)`.
      const row = db
        .prepare(`${SELECT_INITIATIVE} WHERE id = ? AND agent_name = ?`)
        .get(id, agentName) as InitiativeRow | undefined;
      if (!row) {
        throw new DomainError(
          "INITIATIVE_NOT_FOUND",
          `initiative ${id} del agent ${agentName} no existe`,
        );
      }
      // Terminales: `cancelled` repetido es éxito idempotente (sin escritura);
      // cualquier otro terminal es conflicto — el caller lee el durable y no
      // puede des-cancelar historia.
      if (row.state === "cancelled") {
        db.exec("COMMIT");
        return mapRow(row);
      }
      if (isTerminal(row.state) || row.state === "running") {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${id}: no se puede cancelar desde ${row.state}`,
        );
      }
      // Paso 3: `canTransition` como autoridad declarativa, antes del write.
      if (!canTransition(row.state, "cancelled")) {
        throw new DomainError(
          "INITIATIVE_TRANSITION_ILLEGAL",
          `initiative ${id}: transición ${row.state} -> cancelled no es legal (§4.2)`,
        );
      }
      // Paso 4/5: CAS agent-scoped. `pending_human_input` se limpia en la
      // misma tx: una Initiative cancelada no conserva respuesta pendiente.
      const patch: Record<string, string | number | null> = {
        state: "cancelled",
        state_changed_at: now,
        finished_at: now,
        pending_human_input: null,
      };
      const columns = Object.keys(patch);
      const sets = columns.map((c) => `${c} = ?`).join(", ");
      const values = columns.map((c) => patch[c]);
      const result = db
        .prepare(
          `UPDATE initiatives SET ${sets} WHERE id = ? AND agent_name = ? AND state = ?`,
        )
        .run(...values, id, agentName, row.state);
      if (Number(result.changes) !== 1) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${id}: el CAS de cancelación no cambió exactamente una fila (${String(result.changes)})`,
        );
      }
      db.exec("COMMIT"); // paso 6
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.getForAgent(id, agentName);
  }

  /**
   * Responde a una Initiative en `waiting_human` (plan P1 §6.3, P3.2): la vuelve a
   * `queued` con `available_at=state_changed_at=now`, deposita la `answer` en
   * `pending_human_input` y fija la key/hash de respuesta, todo en **una sola**
   * `BEGIN IMMEDIATE`. El Loop sigue siendo el dispatcher único: Control no
   * despacha nada y no se crea Conversation — la Initiative conserva su
   * `session_key`, `bound_model`, `intent`, pregunta/resumen/correlación y
   * deadline para historia.
   *
   * P3.2: el hash incluye `human_request_id` actual para que una respuesta a
   * una pregunta vieja no conteste la nueva (caso real: preguntas dos veces
   * seguidas y el dueño responde tarde a la primera).
   *
   * Idempotencia de respuesta (primera key gana):
   *
   * - misma `idempotencyKey` y mismo hash → replay exitoso **sea cual sea el
   *   estado actual** (`replayed:true`, sin reencolar ni tocar disco otra vez);
   *   así un replay que llegue *después* del claim sigue siendo idempotente
   *   porque el claim conserva key/hash al consumir el pending;
   * - misma key y hash distinto → `IDEMPOTENCY_CONFLICT`;
   * - key nueva cuando el estado durable ya no es `waiting_human` →
   *   `INITIATIVE_STATE_CONFLICT` (otro respondedor o el Loop ya ganaron);
   * - `canTransition("waiting_human","queued")` se comprueba antes del CAS y el
   *   `WHERE state='waiting_human'` es la autoridad operativa: cero filas es
   *   `INITIATIVE_STATE_CONFLICT` y el ROLLBACK conserva el pending ganador.
   *
   * La `answer` no se loguea; el hash es sobre la forma canónica
   * `{initiativeId, humanRequestId, answer}`.
   */
  respondForAgent(command: RespondForAgentCommand): RespondForAgentResult {
    // Validación tipada antes de abrir tx (plan P1 §6.3): `answer` no vacía y
    // con límite interno; P2 reutilizará la misma cota en el borde.
    if (
      typeof command.answer !== "string" ||
      command.answer.length === 0 ||
      command.answer.length > MAX_HUMAN_ANSWER_LENGTH
    ) {
      throw new DomainError(
        "INITIATIVE_INVARIANT_VIOLATION",
        `initiative ${command.id}: answer vacía o fuera del límite interno (§6.3)`,
      );
    }
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer dentro de la transacción, scoped por `(id, agent_name)`.
      const row = db
        .prepare(`${SELECT_INITIATIVE} WHERE id = ? AND agent_name = ?`)
        .get(command.id, command.agentName) as InitiativeRow | undefined;
      if (!row) {
        throw new DomainError(
          "INITIATIVE_NOT_FOUND",
          `initiative ${command.id} del agent ${command.agentName} no existe`,
        );
      }
      // P3.2: el hash incluye el `human_request_id` actual, para que una
      // respuesta a una pregunta vieja no conteste la nueva.
      const commandHash = respondCommandHash(command.id, row.human_request_id, command.answer);
      // Replay: la misma key de respuesta se absorbe sea cual sea el estado
      // actual — el claim ya pudo consumir el pending y dejar `running`.
      if (row.human_response_idempotency_key === command.idempotencyKey) {
        if (row.human_response_command_hash === commandHash) {
          db.exec("COMMIT");
          return { initiative: mapRow(row), replayed: true };
        }
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          `initiative ${command.id}: misma key de respuesta, answer distinta`,
        );
      }
      // Paso 3: primera key gana — solo se responde una Initiative que SIGUE
      // en `waiting_human`; una key nueva tras salir de ahí es conflicto de
      // estado, no un segundo intento.
      if (row.state !== "waiting_human") {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: esperaba waiting_human, durable es ${row.state}`,
        );
      }
      // Autoridad declarativa (paso 3 del contrato), antes de tocar disco.
      if (!canTransition("waiting_human", "queued")) {
        throw new DomainError(
          "INITIATIVE_TRANSITION_ILLEGAL",
          `initiative ${command.id}: reanudar waiting_human -> queued no es legal (§4.2)`,
        );
      }
      // P3.2/B3: la guarda de deadline va DESPUÉS del short-circuit de replay
      // (un replay idempotente de una respuesta ya aceptada no se ve afectado
      // por el deadline: queda absorbido antes de esta guarda) y ANTES del CAS.
      // En el límite exacto manda el deadline: `now >= human_expires_at`
      // rechaza aunque el sweep no haya corrido — el respond no hace autoridad
      // al tick, `human_expires_at` es la autoridad por fila. El sweep marca
      // `expired`; el respond devuelve conflicto público.
      if (row.human_expires_at !== null && command.now >= row.human_expires_at) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: la espera humana caducó (human_expires_at=${row.human_expires_at}, now=${command.now})`,
        );
      }
      // P3.2/B1: cuando el respondedor declara qué request humano contesta, el
      // CAS lo exige explícitamente. El hash sigue dando idempotencia (rama de
      // replay), pero deja de ser el sustituto del CAS: una answer de la
      // pregunta anterior con key nueva ya no contesta la pregunta actual.
      const expectedRequestClause =
        command.expectedHumanRequestId != null ? " AND human_request_id = ?" : "";
      const result = db
        .prepare(
          `UPDATE initiatives
              SET state = 'queued', available_at = ?, state_changed_at = ?,
                  pending_human_input = ?, human_response_idempotency_key = ?,
                  human_response_command_hash = ?
            WHERE id = ? AND agent_name = ? AND state = 'waiting_human'${expectedRequestClause}`,
        )
        .run(
          command.now,
          command.now,
          command.answer,
          command.idempotencyKey,
          commandHash,
          command.id,
          command.agentName,
          ...(command.expectedHumanRequestId != null ? [command.expectedHumanRequestId] : []),
        );
      if (Number(result.changes) !== 1) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          command.expectedHumanRequestId != null
            ? `initiative ${command.id}: el human_request_id esperado ${command.expectedHumanRequestId} ya no es el actual — el CAS de respuesta no cambió exactamente una fila`
            : `initiative ${command.id}: el CAS de respuesta no cambió exactamente una fila (${String(result.changes)})`,
        );
      }
      db.exec("COMMIT"); // paso 6
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { initiative: this.getForAgent(command.id, command.agentName), replayed: false };
  }

  /** `queued` con `available_at` vencido, por orden de disponibilidad (índice `initiatives_due`). */
  listDue(now: number): readonly Initiative[] {
    const rows = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE state = 'queued' AND available_at <= ? ORDER BY available_at, id`)
      .all(now) as InitiativeRow[];
    return rows.map(mapRow);
  }

  /** Todas las Initiatives `running` (índice parcial `initiatives_running_at_startup`). */
  listRunning(): readonly Initiative[] {
    const rows = this.sqlite
      .prepare(`${SELECT_INITIATIVE} WHERE state = 'running' ORDER BY id`)
      .all() as InitiativeRow[];
    return rows.map(mapRow);
  }

  /**
   * Contrato de seis pasos (§5) para una transición. Devuelve la Initiative ya
   * confirmada. Lanza `INITIATIVE_TRANSITION_ILLEGAL` antes de tocar disco
   * (bug del caller), `INITIATIVE_NOT_FOUND` si no existe, `INITIATIVE_STATE_CONFLICT`
   * si la carrera se perdió y `INITIATIVE_INVARIANT_VIOLATION` si falta un
   * campo obligatorio de la transición.
   */
  transition(command: TransitionCommand): Initiative {
    // Paso 3 del contrato (§5.1): `canTransition` es la autoridad declarativa,
    // se llama **antes** del `UPDATE` y sin tocar disco. Un comando ilegal es
    // un bug del caller: se rechaza incluso antes de tomar el lock de
    // escritura. La legalidad se juzga sobre el `from` declarado — si el
    // estado durable ya no es ese, es una carrera, no un bug (§12.4).
    if (!canTransition(command.from, command.to)) {
      throw new DomainError(
        "INITIATIVE_TRANSITION_ILLEGAL",
        `initiative ${command.id}: transición ${command.from} -> ${command.to} no es legal (§4.2)`,
      );
    }

    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1
    try {
      // Paso 2: leer la Initiative dentro de la transacción.
      const row = db
        .prepare(`${SELECT_INITIATIVE} WHERE id = ?`)
        .get(command.id) as InitiativeRow | undefined;
      if (!row) {
        throw new DomainError("INITIATIVE_NOT_FOUND", `initiative ${command.id} no existe`);
      }
      // El estado durable ya no es el que el caller declaró: otro escritor
      // ganó la carrera (el `from` era válido al leer, §5.1).
      if (row.state !== command.from) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: esperaba ${command.from}, durable es ${row.state}`,
        );
      }
      // Paso 4: invariantes multi-fila de la transición (4, 6 y campos
      // obligatorios del comando). Los `CHECK` de fila los cubre el motor.
      const patch = this.buildPatch(command, row);
      // Paso 5: CAS con optimistic locking (`WHERE state = :expected_from`).
      const changes = this.applyPatch(db, command.id, command.from, patch);
      if (changes !== 1) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `initiative ${command.id}: el CAS no cambió exactamente una fila (${changes})`,
        );
      }
      db.exec("COMMIT"); // paso 6
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.get(command.id);
  }

  /**
   * T9 (§6): red de seguridad de cadena. Pasa a `failed` con
   * `failure_reason='chain_deadline_exceeded'` toda Initiative no terminal con
   * `chain_deadline_at` vencido. Devuelve el nº de filas afectadas.
   *
   * El `WHERE state IN (...)` se deriva de `legalSourcesFor('failed')`: solo se
   * tocan filas donde la propia `canTransition` dice que la transición a
   * `failed` es legal — la función pura aplicada en lote (§5.2).
   */
  sweepChainDeadline(now: number): number {
    const from = legalSourcesFor("failed");
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = from.map(() => "?").join(", ");
      const result = db
        .prepare(
          `UPDATE initiatives
              SET state = 'failed', failure_reason = 'chain_deadline_exceeded',
                  finished_at = ?, state_changed_at = ?
            WHERE state IN (${placeholders})
              AND chain_deadline_at IS NOT NULL AND chain_deadline_at <= ?`,
        )
        .run(now, now, ...from, now);
      db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * T10 (§6, P3.2): caducidad de Agent Policy. Pasa a `expired` toda Initiative
   * `waiting_human` cuyo `human_expires_at` venció. Devuelve el nº de filas.
   *
   * P3.2: la autoridad pasa de `state_changed_at` a `human_expires_at` por fila.
   * El parámetro **es `now`** (no `now - expiryMs`): el caller pasa el instante
   * actual y la comparación usa `human_expires_at <= now`. Una fila con
   * `human_expires_at IS NULL` **no caduca nunca** (backfill de la migración v2
   * fija un deadline para las filas legacy; si una fila no tiene deadline, no
   * se expira).
   *
   * Cambiar `PIHUB_WAITING_HUMAN_EXPIRY_MS` después de crear una espera **no
   * mueve** su deadline: el plazo se capturó por fila al pausar.
   *
   * El `WHERE state IN (...)` se deriva de `legalSourcesFor('expired')` — solo
   * `waiting_human` caduca (`CONTEXT.md:40`); de nuevo, la función pura
   * aplicada en lote, nunca un hardcode aparte.
   */
  sweepWaitingHumanExpiry(now: number): number {
    const from = legalSourcesFor("expired");
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = from.map(() => "?").join(", ");
      const result = db
        .prepare(
          `UPDATE initiatives
              SET state = 'expired', finished_at = ?, state_changed_at = ?
            WHERE state IN (${placeholders})
              AND human_expires_at IS NOT NULL
              AND human_expires_at <= ?`,
        )
        .run(now, now, ...from, now);
      db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Patch SQL de la transición (paso 4: invariantes y campos obligatorios). */
  private buildPatch(
    command: TransitionCommand,
    row: InitiativeRow,
  ): Record<string, string | number | null> {
    const patch: Record<string, string | number | null> = {
      state: command.to,
      state_changed_at: command.now,
    };
    switch (command.to) {
      case "running": {
        // T2 (queued→running): `started_at` y `bound_model` solo si eran NULL
        // (invariante 4); el turno despachado se enlaza.
        if (row.started_at === null) patch.started_at = command.now;
        if (row.bound_model === null && command.boundModel !== undefined) {
          patch.bound_model = command.boundModel;
        }
        if (command.turnId !== undefined) patch.turn_id = command.turnId;
        break;
      }
      case "waiting_human": {
        // §4.1: el `CHECK state<>'waiting_human' OR summary IS NOT NULL` exige
        // summary en la misma tx; el escalado es solo→ask (nunca ask→solo).
        if (typeof command.summary !== "string" || command.summary.length === 0) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: waiting_human exige summary (CHECK del esquema)`,
          );
        }
        patch.summary = command.summary;
        if (command.askCorrelation !== undefined) patch.ask_correlation = command.askCorrelation;
        if (canChangeMode(row.mode, "ask")) patch.mode = "ask";
        break;
      }
      case "waiting_agent": {
        // Invariante 6: delegar fija `chain_deadline_at`.
        if (command.chainDeadlineAt === undefined) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: delegar exige chain_deadline_at (invariante 6)`,
          );
        }
        patch.chain_deadline_at = command.chainDeadlineAt;
        break;
      }
      case "queued": {
        // Reanudación (waiting_human/waiting_agent → queued, §4.1): fija
        // `available_at`; `session_key` y `bound_model` se conservan porque no
        // se tocan. El Loop recoloca el despacho bajo su control (ADR 0004).
        if (command.availableAt === undefined) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: reanudar exige available_at`,
          );
        }
        patch.available_at = command.availableAt;
        break;
      }
      case "succeeded": {
        patch.finished_at = command.now;
        if (command.result !== undefined) patch.result = command.result;
        break;
      }
      case "failed": {
        // `failure_reason` es un dato estable (§9.1), nunca NULL en una fila
        // `failed` creada por una transición.
        if (command.failureReason === undefined || command.failureReason.length === 0) {
          throw new DomainError(
            "INITIATIVE_INVARIANT_VIOLATION",
            `initiative ${command.id}: failed exige failure_reason`,
          );
        }
        patch.failure_reason = command.failureReason;
        patch.finished_at = command.now;
        break;
      }
      case "expired":
      case "cancelled": {
        patch.finished_at = command.now;
        break;
      }
    }
    return patch;
  }

  /**
   * CAS del paso 5: `UPDATE ... WHERE id=:id AND state=:expected_from`. El
   * retorno es el nº de filas cambiadas (debe ser exactamente 1).
   */
  private applyPatch(
    db: SqliteDb,
    id: string,
    expectedFrom: InitiativeState,
    patch: Record<string, string | number | null>,
  ): number {
    const columns = Object.keys(patch);
    const sets = columns.map((c) => `${c} = ?`).join(", ");
    const values = columns.map((c) => patch[c]);
    const result = db
      .prepare(`UPDATE initiatives SET ${sets} WHERE id = ? AND state = ?`)
      .run(...values, id, expectedFrom);
    return Number(result.changes);
  }
}
