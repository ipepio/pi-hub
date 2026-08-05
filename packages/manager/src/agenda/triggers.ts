/**
 * TriggerRepository — Fase 2.3 del plan de Fase 2 (`/tmp/f2plan.md`).
 *
 * `fireTrigger(...)` es la operación **T1** del §6: dispara un Trigger
 * `schedule` creando la Initiative `queued` con `origin='trigger'` y
 * avanzando el Trigger (`next_fire_at`, `last_fired_at`, `updated_at`) en la
 * **misma transacción**. Si el proceso muere antes del `COMMIT`, el WAL hace
 * `ROLLBACK`: no queda Initiative huérfana ni `next_fire_at` avanzado sin su
 * Initiative — la fila T1 lo fija así ("Avanzar `next_fire_at` sin crear la
 * Initiative es imposible: misma tx").
 *
 * El repositorio encapsula el índice parcial `schedule_triggers_due`
 * (`migrations.ts:32`) y la forma de `definition_json` (pendiente 1 del
 * diseño: el versionado completo del schedule —zona horaria, recurrencia,
 * saltos— no está fijado). v1 dispara solo Triggers `kind='schedule'` con una
 * recurrencia por intervalo:
 *
 *   { "version": 1, "kind": "interval", "intervalMs": 3_600_000 }
 *
 * `next_fire_at` avanza a `now + intervalMs` (resincroniza desde `now`: no
 * encola disparos atrasados; cada `fireTrigger` crea exactamente una
 * Initiative). Cuando el pendiente 1 se resuelva, solo cambia este módulo: la
 * frontera transaccional de T1 no se mueve.
 *
 * Nota de contrato: `fireTrigger` no pasa por `canTransition` porque no es una
 * transición de estado — es el *nacimiento* de una Initiative en `queued` y el
 * avance de un Trigger; no hay `from` que validar (§5 solo aplica a comandos
 * de transición). Ningún camino escribe un estado de Initiative sin pasar por
 * la función pura: la Initiative nace `queued` y todo movimiento posterior es
 * una transición de `initiatives.ts`. La disparabilidad se valida con el
 * catálogo §9.1 (`TRIGGER_NOT_DISPARABLE`: `proposed`/`disabled` o
 * `next_fire_at IS NULL`; v1 solo dispara `kind='schedule'`).
 */

import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../storage/sqlite.ts";
import { InitiativeRepository, type Initiative } from "./initiatives.ts";
import { DomainError } from "./errors.ts";

/** Fila cruda de `triggers` con lo que `fireTrigger` necesita (snake_case). */
interface TriggerRow {
  id: string;
  agent_name: string;
  kind: string;
  definition_json: string;
  intent: string;
  mode: "solo" | "ask";
  proposal_state: "proposed" | "approved" | null;
  enabled: number;
  next_fire_at: number | null;
}

/** Forma mínima de `definition_json` que v1 dispara (pendiente 1, ver docstring). */
interface IntervalSchedule {
  readonly version: 1;
  readonly kind: "interval";
  readonly intervalMs: number;
}

/** ¿Es `value` un schedule de intervalo v1 (`{ version: 1, kind: "interval", intervalMs }`)? */
function isIntervalSchedule(value: unknown): value is IntervalSchedule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.kind === "interval" &&
    typeof candidate.intervalMs === "number" &&
    Number.isFinite(candidate.intervalMs) &&
    candidate.intervalMs > 0
  );
}

/**
 * Calcula el próximo `next_fire_at` desde la definición del Trigger. El repo
 * encapsula la forma de `definition_json` (pendiente 1): si la definición no
 * es la que v1 sabe planificar, el Trigger no es disparable — mejor rechazar
 * el disparo que crear una Initiative sin poder avanzar el Trigger.
 */
function nextFireAtFromDefinition(definitionJson: string, now: number): number {
  let definition: unknown;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    throw new DomainError(
      "TRIGGER_NOT_DISPARABLE",
      "definition_json no es JSON válido (la forma de `definition_json` es el pendiente 1 del diseño)",
    );
  }
  if (!isIntervalSchedule(definition)) {
    throw new DomainError(
      "TRIGGER_NOT_DISPARABLE",
      `definition_json no tiene la forma de intervalo que v1 dispara (pendiente 1)`,
    );
  }
  return now + definition.intervalMs;
}

export class TriggerRepository {
  private readonly sqlite: SqliteDb;
  private readonly initiatives: InitiativeRepository;

  constructor(sqlite: SqliteDb, initiatives: InitiativeRepository) {
    this.sqlite = sqlite;
    this.initiatives = initiatives;
  }

  /**
   * T1 (§6) — dispara un Trigger `schedule`: crea la Initiative `queued` con
   * `origin='trigger'` y avanza el Trigger en la misma transacción. Devuelve
   * la Initiative creada. Lanza `TRIGGER_NOT_FOUND` si no existe,
   * `TRIGGER_NOT_DISPARABLE` si está `proposed`/`disabled`, no tiene
   * `next_fire_at` o no es un `schedule` que v1 sepa planificar (§9.1).
   *
   * No se valida `next_fire_at <= now`: el caller (Loop, Fase 3) es quien
   * decide qué disparar (índice `schedule_triggers_due`); este comando
   * dispara el Trigger indicado y reprograma desde `now`.
   */
  fireTrigger(triggerId: string, now: number): Initiative {
    const db = this.sqlite;
    db.exec("BEGIN IMMEDIATE"); // paso 1 del contrato (§5), donde aplica
    try {
      // Paso 2: leer el Trigger dentro de la transacción.
      const row = db
        .prepare(
          `SELECT id, agent_name, kind, definition_json, intent, mode,
                  proposal_state, enabled, next_fire_at
             FROM triggers WHERE id = ?`,
        )
        .get(triggerId) as TriggerRow | undefined;
      if (!row) {
        throw new DomainError("TRIGGER_NOT_FOUND", `trigger ${triggerId} no existe`);
      }
      // Paso 3-4: disparabilidad (§9.1 — TRIGGER_NOT_DISPARABLE para
      // `proposed`/`disabled` o `next_fire_at IS NULL`; v1 solo dispara
      // `kind='schedule'`, el conjunto del índice `schedule_triggers_due`).
      if (
        row.enabled !== 1 ||
        row.proposal_state === "proposed" ||
        row.next_fire_at === null ||
        row.kind !== "schedule"
      ) {
        throw new DomainError(
          "TRIGGER_NOT_DISPARABLE",
          `trigger ${triggerId} no es disparable (enabled=${row.enabled}, ` +
            `proposal_state=${String(row.proposal_state)}, next_fire_at=${String(row.next_fire_at)}, kind=${row.kind})`,
        );
      }
      const nextFireAt = nextFireAtFromDefinition(row.definition_json, now);
      // Paso 5: las dos filas de T1 en la misma transacción — la Initiative y
      // el avance del Trigger se confirman juntos o ninguno.
      const initiativeId = randomUUID();
      const sessionKey = randomUUID(); // sessionKey aislada propia de la Initiative (§1.2)
      db.prepare(
        `INSERT INTO initiatives
           (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
            available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
            visible_effects_declared, summary, ask_correlation, failure_reason,
            result, created_at, state_changed_at, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        initiativeId, row.agent_name, "queued", "trigger", triggerId, row.intent,
        row.mode, sessionKey, now, null, null, 0, null, 0, null, null, null,
        null, now, now, null, null,
      );
      const update = db
        .prepare(
          `UPDATE triggers SET next_fire_at = ?, last_fired_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(nextFireAt, now, now, triggerId);
      // Dentro de `BEGIN IMMEDIATE` el Trigger no puede haber cambiado entre
      // la lectura y el UPDATE; el guard es defensivo (contrato §5 paso 5).
      if (Number(update.changes) !== 1) {
        throw new DomainError(
          "TRIGGER_NOT_FOUND",
          `trigger ${triggerId}: el avance no cambió exactamente una fila (${String(update.changes)})`,
        );
      }
      db.exec("COMMIT"); // paso 6
      return this.initiatives.get(initiativeId);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
