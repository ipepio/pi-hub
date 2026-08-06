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
 * (`migrations.ts:32`) y la forma versionada de `definition_json` (Fase 3.6):
 * el `ScheduleCalculator` de este módulo la valida y materializa el siguiente
 * vencimiento. Tres formas, sin migración de datos (`version: 1` sigue
 * vigente tal cual, sin `timeZone`):
 *
 *   { "version": 1, "kind": "interval", "intervalMs": 3_600_000 }
 *   { "version": 2, "kind": "daily",  "timeZone": "Europe/Madrid", "at": "09:00" }
 *   { "version": 2, "kind": "weekly", "timeZone": "Europe/Madrid", "at": "09:00",
 *     "days": ["mon", "wed", "fri"] }
 *
 * `next_fire_at` avanza a la primera ocurrencia posterior a `now` en la zona
 * (resincroniza desde `now`: no encola disparos atrasados; cada `fireTrigger`
 * crea exactamente una Initiative). Para v1 es `now + intervalMs`; para v2 es
 * la primera ocurrencia civil posterior según la política DST de §3.3. Cuando
 * el planificador no sabe planificar la definición, el Trigger no es
 * disparable y T1 hace ROLLBACK (cero Initiative, fechas intactas).
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
import { Temporal } from "@js-temporal/polyfill";
import type { SqliteDb } from "../storage/sqlite.ts";
import { InitiativeRepository, type Initiative } from "./initiatives.ts";
import { DomainError } from "./errors.ts";

/** Catálogo de días de la semana (`mon`…`sun`), §3.3. */
const WEEKDAY_NAMES: ReadonlySet<string> = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** `PlainDate.dayOfWeek` ISO (mon=1 … sun=7) → nombre del día. */
const WEEKDAY_BY_ISO: Readonly<Record<number, Weekday>> = {
  1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 7: "sun",
};

/** `HH:mm` estricto (`00:00`–`23:59`): se rechazan `9:00` y formas con segundos. */
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Forma versionada de `definition_json` que el repo sabe planificar (Fase 3.6;
 * cierra el pendiente 1). `version: 1` sigue vigente tal cual, sin `timeZone`;
 * no hay migración de datos.
 */
type ParsedSchedule =
  | { version: 1; kind: "interval"; intervalMs: number }
  | { version: 2; kind: "daily"; timeZone: string; at: string }
  | { version: 2; kind: "weekly"; timeZone: string; at: string; days: readonly Weekday[] };

/** Todo rechazo de schedule es `TRIGGER_NOT_DISPARABLE` (§3); el motivo es interno. */
function notDisposableSchedule(reason: "json" | "shape" | "timeZone" | "calendar"): DomainError {
  return new DomainError(
    "TRIGGER_NOT_DISPARABLE",
    `definition_json no es un schedule planificable (${reason})`,
  );
}

/** Fail-closed: el conjunto de claves debe ser exactamente `expected`, sin extra. */
function hasExactlyKeys(obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj);
  if (keys.length !== expected.length) return false;
  const sortedKeys = [...keys].sort();
  const sortedExpected = [...expected].sort();
  return sortedKeys.every((key, index) => key === sortedExpected[index]);
}

/** Valida `days` de `weekly`: 1–7 valores del catálogo, sin duplicados. */
function parseWeekdays(value: unknown): readonly Weekday[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    throw notDisposableSchedule("shape");
  }
  const seen = new Set<string>();
  const days: Weekday[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !WEEKDAY_NAMES.has(entry) || seen.has(entry)) {
      throw notDisposableSchedule("shape");
    }
    seen.add(entry);
    days.push(entry as Weekday);
  }
  return days;
}

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

/** Fila cruda del barrido `schedule_triggers_due` (snake_case). */
interface DueScheduleRow {
  id: string;
  agent_name: string;
  next_fire_at: number;
}

/** Trigger `schedule` vencido ahora, tal y como lo expone `listDueSchedule`. */
export interface DueScheduleTrigger {
  readonly id: string;
  readonly agentName: string;
  readonly nextFireAt: number;
}

/**
 * Semántica DST de calendario (Fase 3.6). `parse` valida la forma versionada de
 * `definition_json`; `nextFireAt` materializa el siguiente vencimiento en la
 * zona IANA del Trigger. Vive encapsulado en este módulo y no se exporta: el
 * repo lo consume dentro de la transacción de T1 (si lanza, el `catch` de
 * `fireTrigger` hace ROLLBACK y no nace Initiative ni avanza el Trigger).
 */
class ScheduleCalculator {
  parse(definitionJson: string): ParsedSchedule {
    let raw: unknown;
    try {
      raw = JSON.parse(definitionJson);
    } catch {
      throw notDisposableSchedule("json");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw notDisposableSchedule("shape");
    }
    const obj = raw as Record<string, unknown>;
    if (obj.version === 1 && obj.kind === "interval") {
      if (!hasExactlyKeys(obj, ["version", "kind", "intervalMs"])) {
        throw notDisposableSchedule("shape");
      }
      if (!Number.isSafeInteger(obj.intervalMs) || (obj.intervalMs as number) <= 0) {
        throw notDisposableSchedule("shape");
      }
      return { version: 1, kind: "interval", intervalMs: obj.intervalMs as number };
    }
    if (obj.version === 2 && (obj.kind === "daily" || obj.kind === "weekly")) {
      if (typeof obj.at !== "string" || !AT_PATTERN.test(obj.at)) {
        throw notDisposableSchedule("shape");
      }
      const timeZone = this.validateTimeZone(obj.timeZone);
      if (obj.kind === "daily") {
        if (!hasExactlyKeys(obj, ["version", "kind", "timeZone", "at"])) {
          throw notDisposableSchedule("shape");
        }
        return { version: 2, kind: "daily", timeZone, at: obj.at };
      }
      if (!hasExactlyKeys(obj, ["version", "kind", "timeZone", "at", "days"])) {
        throw notDisposableSchedule("shape");
      }
      return { version: 2, kind: "weekly", timeZone, at: obj.at, days: parseWeekdays(obj.days) };
    }
    throw notDisposableSchedule("shape");
  }

  nextFireAt(parsed: ParsedSchedule, now: number): number {
    if (parsed.kind === "interval") {
      const next = now + parsed.intervalMs;
      if (!Number.isSafeInteger(next)) {
        throw notDisposableSchedule("shape");
      }
      return next;
    }
    const hour = Number(parsed.at.slice(0, 2));
    const minute = Number(parsed.at.slice(3, 5));
    // Convierte `now` a fecha civil en la zona y recorre fechas civiles — nunca
    // suma 24 h en ms (arruinaría los saltos de reloj). `daily` prueba hoy y
    // mañana; `weekly` prueba como máximo hoy + 7 días.
    const civilToday = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(parsed.timeZone)
      .toPlainDate();
    const maxOffset = parsed.kind === "weekly" ? 7 : 1;
    for (let offset = 0; offset <= maxOffset; offset++) {
      const day = offset === 0 ? civilToday : civilToday.add({ days: offset });
      if (parsed.kind === "weekly" && !parsed.days.includes(WEEKDAY_BY_ISO[day.dayOfWeek])) {
        continue;
      }
      const candidate = this.materialize(parsed.timeZone, day, hour, minute);
      if (candidate.epochMilliseconds > now) {
        return candidate.epochMilliseconds;
      }
    }
    throw notDisposableSchedule("calendar");
  }

  /**
   * Valida la zona IANA. `Temporal.TimeZone` NO existe en el polyfill 0.5.1
   * (`typeof` da `undefined`), así que se valida construyendo un ZonedDateTime
   * y convirtiendo el `RangeError` (§3.1). Temporal acepta offsets fijos, que
   * este diseño rechaza expresamente: la zona debe tener reglas civiles.
   */
  private validateTimeZone(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
      throw notDisposableSchedule("timeZone");
    }
    if (value.startsWith("+") || value.startsWith("-")) {
      throw notDisposableSchedule("timeZone");
    }
    try {
      Temporal.ZonedDateTime.from({ timeZone: value, year: 2024, month: 1, day: 1, hour: 12 });
    } catch {
      throw notDisposableSchedule("timeZone");
    }
    return value;
  }

  /**
   * Materializa el candidato civil con `disambiguation: "compatible"`, que
   * desplaza hacia delante por la duración del hueco (verificado en 0.5.1); no
   * se escribe un clamp propio: eso exigiría aritmética DST manual, prohibida.
   */
  private materialize(
    timeZone: string,
    day: Temporal.PlainDate,
    hour: number,
    minute: number,
  ): Temporal.ZonedDateTime {
    try {
      return Temporal.ZonedDateTime.from(
        { timeZone, year: day.year, month: day.month, day: day.day, hour, minute },
        { disambiguation: "compatible", overflow: "reject" },
      );
    } catch {
      throw notDisposableSchedule("calendar");
    }
  }
}

/** Instancia module-privada; no se exporta ni entra en el barrel. */
const CALC = new ScheduleCalculator();

/**
 * Calcula el próximo `next_fire_at` desde la definición del Trigger. Conserva
 * firma, retorno y sincronía (import estático, no `import()`): `fireTrigger`
 * sigue siendo síncrono dentro de su transacción. Si la definición no es
 * planificable, el Trigger no es disparable — mejor rechazar el disparo que
 * crear una Initiative sin poder avanzar el Trigger.
 */
function nextFireAtFromDefinition(definitionJson: string, now: number): number {
  return CALC.nextFireAt(CALC.parse(definitionJson), now);
}

export class TriggerRepository {
  private readonly sqlite: SqliteDb;
  private readonly initiatives: InitiativeRepository;

  constructor(sqlite: SqliteDb, initiatives: InitiativeRepository) {
    this.sqlite = sqlite;
    this.initiatives = initiatives;
  }

  /**
   * Fase 3.3 (§3.1 del plan) — qué Triggers `schedule` vencen en `now`. Es el
   * predicado literal del índice parcial `schedule_triggers_due`
   * (`migrations.ts:32-33`): `enabled`, `kind='schedule'`, no `proposed` y
   * `next_fire_at <= now`. **Frontera: lectura** — no abre transacción de
   * escritura; el disparo (`fireTrigger`) es quien escribe, en su propia tx.
   * Devuelto por `(next_fire_at, id)`.
   */
  listDueSchedule(now: number): readonly DueScheduleTrigger[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, agent_name, next_fire_at FROM triggers
          WHERE enabled = 1 AND kind = 'schedule'
            AND (proposal_state IS NULL OR proposal_state = 'approved')
            AND next_fire_at IS NOT NULL AND next_fire_at <= ?
          ORDER BY next_fire_at, id`,
      )
      .all(now) as DueScheduleRow[];
    return rows.map((row) => ({
      id: row.id,
      agentName: row.agent_name,
      nextFireAt: row.next_fire_at,
    }));
  }

  /**
   * T1 (§6) — dispara un Trigger `schedule`: crea la Initiative `queued` con
   * `origin='trigger'` y avanza el Trigger en la misma transacción. Devuelve
   * la Initiative creada. Lanza `TRIGGER_NOT_FOUND` si no existe,
   * `TRIGGER_NOT_DISPARABLE` si está `proposed`/`disabled`, no tiene
   * `next_fire_at` o no es un `schedule` que el repo sepa planificar (§9.1).
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
