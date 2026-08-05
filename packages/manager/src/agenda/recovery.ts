/**
 * Recuperación al arranque — Fase 2.2 del plan de Fase 2 (`/tmp/f2plan.md` §7).
 *
 * ============================================================================
 * ÚNICO BYPASS AUTORIZADO del contrato de seis pasos (§5.2 del plan; ADR
 * `docs/adr/0007-running-initiatives-fail-on-startup.md`).
 *
 * Toda otra escritura de estado de `agenda/` pasa por la función pura
 * `canTransition` (autoridad declarativa, §5.1). Esta operación no puede: una
 * Initiative `running` durable al arranque es un efecto huérfano —el proceso
 * murió antes del terminal de su turno— y el ADR 0007 manda fallarla en masa,
 * sin un "from" que validar. La red de seguridad de cadena (§7.2 paso 2) sí
 * deriva su `WHERE state IN (...)` de `canTransition` (`legalSourcesFor`), de
 * modo que no hay ningún otro camino que escriba estado sin pasar por la
 * función pura.
 * ============================================================================
 *
 * Una sola `BEGIN IMMEDIATE` aplica los dos `UPDATE` del §7.2 y los confirma
 * juntos: el disco queda en un único punto consistente. Si algo lanza, hace
 * `ROLLBACK` y propaga `STARTUP_RECOVERY_FAILED`: el Manager aborta sin
 * publicar HTTP y systemd reintenta (§7.4).
 */

import type { SqliteDb } from "../storage/sqlite.ts";
import { legalSourcesFor } from "./state.ts";
import { DomainError } from "./errors.ts";

/** Resultado observable de la recuperación (el arranque decide el log, §7.3). */
export interface StartupRecoveryResult {
  /** ids de las Initiatives `running` en disco que pasaron a `failed` (ADR 0007). */
  readonly runningRecovered: readonly string[];
  /** nº de no terminales con `chain_deadline_at` vencido que pasaron a `failed` (§7.2 paso 2). */
  readonly deadlineExpired: number;
}

export function recoverRunningOnStartup(sqlite: SqliteDb, now: number): StartupRecoveryResult {
  const db = sqlite;
  db.exec("BEGIN IMMEDIATE");
  try {
    // (1) ADR 0007 (§7.2 paso 1): `running` durable → `failed` con
    // `failure_reason='startup_recovery'` (§12.3). Lo sirve el índice parcial
    // `initiatives_running_at_startup` (migrations.ts). Se leen los ids dentro
    // de la misma transacción para poder loguear el caso STARTUP_RECOVERY_APPLIED
    // (§7.3). Conserva `summary`, `started_at`, `turn_id`, `bound_model` y la
    // información de cadena; `result` queda NULL (no se observó terminal).
    const running = db
      .prepare("SELECT id FROM initiatives WHERE state = 'running' ORDER BY id")
      .all() as Array<{ id: string }>;
    const runningRecovered = running.map((r) => r.id);
    db.prepare(
      `UPDATE initiatives
          SET state = 'failed', failure_reason = 'startup_recovery',
              finished_at = ?, state_changed_at = ?
        WHERE state = 'running'`,
    ).run(now, now);

    // (2) Red de seguridad de cadena (§7.2 paso 2): deadline vencido en no
    // terminales. El `WHERE state IN (...)` sale de `legalSourcesFor('failed')`
    // — la función pura aplicada en lote, igual que T9.
    const from = legalSourcesFor("failed");
    const placeholders = from.map(() => "?").join(", ");
    const expired = db
      .prepare(
        `UPDATE initiatives
            SET state = 'failed', failure_reason = 'chain_deadline_exceeded',
                finished_at = ?, state_changed_at = ?
          WHERE state IN (${placeholders})
            AND chain_deadline_at IS NOT NULL AND chain_deadline_at <= ?`,
      )
      .run(now, now, ...from, now);

    db.exec("COMMIT");
    return { runningRecovered, deadlineExpired: Number(expired.changes) };
  } catch (error) {
    db.exec("ROLLBACK");
    // §7.4: si la transacción lanza (disco corrupto, busy_timeout, I/O), el
    // Manager aborta antes de `Supervisor.startAll` y de `serve`; el código que
    // propaga al abortar es STARTUP_RECOVERY_FAILED (§9.1).
    throw new DomainError(
      "STARTUP_RECOVERY_FAILED",
      "la recuperación al arranque no pudo completar; el Manager aborta (ADR 0007, §7.4)",
      { cause: error },
    );
  }
}
