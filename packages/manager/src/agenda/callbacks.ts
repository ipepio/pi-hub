/**
 * CallbackRepository — Fase 2.3 del plan de Fase 2 (`/tmp/f2plan.md`).
 *
 * `deliver(...)` es la operación **T5** del §6: entrega un Callback a la
 * Agenda del Agent de `parent` creando la Initiative Callback
 * (`origin='callback'`, `queued`), insertando la fila de `callbacks` y
 * reactivando el `parent` — **las tres en la misma transacción** (invariante
 * 5, `migrations.ts:73-80`: un Callback sin su Initiative sería un estado
 * imposible; el `INSERT` de `callbacks` corre siempre en la misma transacción
 * que el de su Initiative, §1.3).
 *
 * La reactivación lleva el `parent` de `waiting_agent` a **`queued`**, no a
 * `running` — resolución §12.1: el Loop es el dispatcher único (ADR 0004) y
 * reanudar a `queued` recoloca el despacho bajo su control de concurrencia,
 * en vez de saltárselo. La frontera transaccional de la fila T5 (qué filas van
 * en qué transacción) no cambia por ello; solo cambia el estado destino.
 *
 * La reactivación es una transición de Initiative: pasa por la función pura
 * `canTransition('waiting_agent', 'queued')` antes del `UPDATE`, y el `UPDATE`
 * es un CAS `WHERE id=? AND state='waiting_agent'` — si otro escritor ganó la
 * carrera, `INITIATIVE_STATE_CONFLICT` (§5.1). El modelo v1 es un-delegado-a-la-
 * vez (§1.3): a lo sumo un Callback pendiente/entregado por `parent`, servido
 * por el índice `callbacks_by_parent` (`migrations.ts:80`).
 */

import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../storage/sqlite.ts";
import { InitiativeRepository, type Initiative } from "./initiatives.ts";
import { canTransition, isTerminal } from "./state.ts";
import { DomainError } from "./errors.ts";

export class CallbackRepository {
  private readonly sqlite: SqliteDb;
  private readonly initiatives: InitiativeRepository;

  constructor(sqlite: SqliteDb, initiatives: InitiativeRepository) {
    this.sqlite = sqlite;
    this.initiatives = initiatives;
  }

  /**
   * T5 (§6) — entrega válida de un Callback: Initiative Callback + fila
   * `callbacks` + reactivación del `parent`, en la misma transacción.
   *
   * // TODO(pendiente 10)
   * Este método es el punto de costura donde un Callback toca a la vez memoria
   * del Agent y Agenda (`docs/design-autonomia-agenda-sqlite.md:264`, §3 y §6
   * del plan). La transacción SQLite de esta entrega es atómica; la escritura
   * al índice de memoria del Agent no lo es con ella. El orden
   * lock-de-memoria ↔ SQLite no está definido y **no se resuelve en la Fase
   * 2.3** (§13): cuando se cierre el pendiente 10, el lock de memoria se
   * tomará en este punto, sin ampliar ningún lock para simular atomicidad.
   *
   * Lanza `INITIATIVE_NOT_FOUND` si el `parent` no existe,
   * `CALLBACK_PARENT_MISMATCH` si no es del mismo Agent (M5),
   * `CALLBACK_PARENT_TERMINAL` si está terminal, `CALLBACK_ALREADY_PENDING`
   * si ya no está `waiting_agent` o ya hay un Callback para él
   * (un-delegado-a-la-vez, §1.3) e `INITIATIVE_STATE_CONFLICT` si el CAS de
   * la reactivación pierde la carrera. Devuelve la Initiative Callback creada.
   */
  deliver(agentName: string, parentId: string, result: string, now: number): Initiative {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1 del contrato (§5)
    try {
      // Paso 2: leer el `parent` dentro de la transacción. `initiatives.get`
      // no abre transacción propia: solo lee la fila que la transacción abierta
      // ve, y lanza `INITIATIVE_NOT_FOUND` si el `parent` no existe.
      const parent = this.initiatives.get(parentId);

      // Paso 4: invariantes multi-fila de la entrega.
      // M5 (§1.3): el `parent` pertenece al mismo Agent que la Initiative
      // Callback — la reactivación reutiliza la `session_key` aislada de ese
      // Agent, así que apuntar a otro Agent sería mezclar sesiones.
      if (parent.agentName !== agentName) {
        throw new DomainError(
          "CALLBACK_PARENT_MISMATCH",
          `callback para ${parentId}: parent.agent_name=${parent.agentName} <> ${agentName} (M5)`,
        );
      }
      // Un Callback tardío sobre un `parent` terminal no puede reactivarlo.
      if (isTerminal(parent.state)) {
        throw new DomainError(
          "CALLBACK_PARENT_TERMINAL",
          `callback para ${parentId}: parent está ${parent.state}`,
        );
      }
      // Un-delegado-a-la-vez (§1.3): el `parent` solo recibe la entrega
      // estando `waiting_agent`. Si ya no lo está (otra entrega lo reanudó,
      // o nunca delegó), o ya existe una fila `callbacks` para él (índice
      // `callbacks_by_parent`), el modelo v1 lo rechaza con
      // `CALLBACK_ALREADY_PENDING` (§10.5).
      if (parent.state !== "waiting_agent") {
        throw new DomainError(
          "CALLBACK_ALREADY_PENDING",
          `callback para ${parentId}: parent está ${parent.state}, no waiting_agent (un-delegado-a-la-vez)`,
        );
      }
      const pending = db
        .prepare("SELECT id FROM callbacks WHERE parent_id = ?")
        .get(parentId) as { id: string } | undefined;
      if (pending !== undefined) {
        throw new DomainError(
          "CALLBACK_ALREADY_PENDING",
          `callback para ${parentId}: ya hay una fila callbacks (${pending.id}) — un-delegado-a-la-vez`,
        );
      }

      // Paso 5: las tres filas de T5 en la misma transacción.
      const id = randomUUID();
      db.prepare(
        `INSERT INTO initiatives
           (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
            available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
            visible_effects_declared, summary, ask_correlation, failure_reason,
            result, created_at, state_changed_at, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, parent.agentName, "queued", "callback", null, parent.intent,
        parent.mode, parent.sessionKey, now, null, null, parent.chainDepth + 1,
        parent.chainDeadlineAt, parent.visibleEffectsDeclared ? 1 : 0, null,
        null, null, null, now, now, null, null,
      );
      db.prepare(
        "INSERT INTO callbacks (id, parent_id, result, created_at) VALUES (?,?,?,?)",
      ).run(id, parentId, result, now);
      // Reactivación del `parent`: waiting_agent → queued (§12.1), por la
      // función pura + CAS con optimistic locking (§5.1).
      if (!canTransition("waiting_agent", "queued")) {
        throw new DomainError(
          "INITIATIVE_TRANSITION_ILLEGAL",
          `deliver ${parentId}: waiting_agent -> queued no es legal (§4.2)`,
        );
      }
      const resume = db
        .prepare(
          `UPDATE initiatives
              SET state = 'queued', available_at = ?, state_changed_at = ?
            WHERE id = ? AND state = 'waiting_agent'`,
        )
        .run(now, now, parentId);
      if (Number(resume.changes) !== 1) {
        throw new DomainError(
          "INITIATIVE_STATE_CONFLICT",
          `deliver ${parentId}: el CAS de reactivación no cambió exactamente una fila (${String(resume.changes)})`,
        );
      }
      db.exec("COMMIT"); // paso 6
      return this.initiatives.get(id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
