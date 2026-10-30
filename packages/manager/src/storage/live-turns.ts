/**
 * LiveTurnRepository — T4-D/1 del seguimiento del ODD `agent-session-workspace`.
 *
 * Espejo DURABLE de la reserva de admisión que `TurnExecution` ya hacía en
 * memoria (S2: «at most one executing turn across web, Telegram and autonomy»).
 * La memoria sigue siendo la fuente del puente; esta tabla es la RESERVA que
 * sobrevive al proceso, para que un Manager recién arrancado no admita un segundo
 * turno del mismo Agent mientras el Runner aún ejecuta el primero.
 *
 * Por qué una tabla propia y no `turns`: `turns` guarda el turno con su
 * idempotencia y su terminal, y una fila con `final_state IS NULL` no distingue
 * «ejecutando ahora» de «el proceso que lo ejecutaba murió» (pendiente 4 de §13
 * del plan de Fase 2). Fabricar esa distinción dentro de `turns` habría cambiado
 * la semántica de un hecho ya publicado; `agent_live_turns` es un hecho nuevo y
 * explícito: «este Agent tiene un turno abierto y todavía no hay terminal».
 *
 * Convenciones (las mismas de `agenda/turns.ts`, a propósito):
 * - `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` INLINE por operación, sin helper
 *   compartido: cada sentencia ve el estado que confirma la anterior.
 * - El driver (`SqliteDb`) es el mismo que recibe la Agenda; esta fachada no
 *   añade SQL al resto del Manager.
 * - `agent_name` es la PRIMARY KEY: la invariante «un turno vivo por Agent» la
 *   sostiene la base, no la convención del llamador. Un segundo `INSERT` choca
 *   y se traduce al MISMO código de dominio que la memoria (`TURN_IN_PROGRESS`),
 *   así que un turno de una vida anterior del Manager bloquea igual que uno vivo
 *   de este proceso (fail-closed).
 */

import type { SqliteDb } from "./sqlite.ts";
import { DomainError } from "../agenda/errors.ts";
import { sqliteErrcode } from "../agenda/turns.ts";

/** Una fila de `agent_live_turns` (la reserva de admisión de un Agent). */
export interface LiveTurnClaim {
  readonly agentName: string;
  readonly turnId: string;
  /** `sessionKey` con la que se despachó el turno; `null` si no hay catálogo. */
  readonly sessionKey: string | null;
  /** Reloj del Manager que hizo la reserva. */
  readonly startedAt: number;
}

/**
 * Superficie del registro durable que consumen el arranque y `TurnExecution`.
 * Estrecha a propósito: quien la use no ve SQL ni el driver.
 */
export interface LiveTurnStore {
  /**
   * Reserva el turno del Agent. Lanza `DomainError` `TURN_IN_PROGRESS` si el
   * Agent ya tiene una fila: indistinguible, para el caller, de la negativa en
   * memoria.
   */
  claimLiveTurn(claim: LiveTurnClaim): void;
  /**
   * Libera la reserva del turno `(agentName, turnId)`. Borrar cero filas NO es
   * un error: la liberación es idempotente (un terminal repetido o una fila que
   * ya limpió otra vía no rompen nada).
   */
  releaseLiveTurn(agentName: string, turnId: string): void;
  /** Todas las reservas vivas, ordenadas por Agent (arranque y observabilidad). */
  listLiveTurns(): LiveTurnClaim[];
}

/** Constructor de código SQLite de violación de unicidad/PK (ver `agenda/turns.ts`). */
const SQLITE_PRIMARY_KEY = 1555;
const SQLITE_UNIQUE = 2067;

export class LiveTurnRepository implements LiveTurnStore {
  private readonly sqlite: SqliteDb;

  constructor(sqlite: SqliteDb) {
    this.sqlite = sqlite;
  }

  /**
   * `INSERT INTO agent_live_turns` en su propia transacción: o la reserva queda
   * confirmada, o no queda nada. El conflicto de PK se traduce a
   * `TURN_IN_PROGRESS`; cualquier otro error se re-propaga tal cual (un almacén
   * roto no debe disfrazarse de «Agent ocupado»).
   */
  claimLiveTurn(claim: LiveTurnClaim): void {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO agent_live_turns (agent_name, turn_id, session_key, started_at)
         VALUES (?,?,?,?)`,
      ).run(claim.agentName, claim.turnId, claim.sessionKey, claim.startedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const errcode = sqliteErrcode(error);
      if (errcode === SQLITE_PRIMARY_KEY || errcode === SQLITE_UNIQUE) {
        throw new DomainError(
          "TURN_IN_PROGRESS",
          `agent "${claim.agentName}" ya tiene un turno vivo registrado (turn_id ${claim.turnId})`,
        );
      }
      throw error;
    }
  }

  /**
   * `DELETE` del turno exacto. El `turn_id` forma parte del WHERE a propósito:
   * liberar la reserva de OTRO turno del mismo Agent (un terminal tardío de un
   * turno ya reemplazado) dejaría el slot libre con un Runner trabajando.
   */
  releaseLiveTurn(agentName: string, turnId: string): void {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "DELETE FROM agent_live_turns WHERE agent_name = ? AND turn_id = ?",
      ).run(agentName, turnId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listLiveTurns(): LiveTurnClaim[] {
    const rows = this.sqlite
      .prepare(
        `SELECT agent_name, turn_id, session_key, started_at
           FROM agent_live_turns ORDER BY agent_name`,
      )
      .all() as Array<{
      agent_name: string;
      turn_id: string;
      session_key: string | null;
      started_at: number;
    }>;
    return rows.map((row) => ({
      agentName: row.agent_name,
      turnId: row.turn_id,
      sessionKey: row.session_key,
      startedAt: Number(row.started_at),
    }));
  }
}

/** Puerta estrecha hermana de `openChannelPersistence`/`openAgentSessionCatalogue`. */
export function openLiveTurnStore(db: SqliteDb): LiveTurnStore {
  return new LiveTurnRepository(db);
}
