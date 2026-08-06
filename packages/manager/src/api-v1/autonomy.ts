/**
 * Módulo de Autonomía HTTP — P2.2. Tipos públicos, schemas estrictos,
 * presenters service/panel y traducción de DomainError.
 *
 * No registra rutas (eso es P2.3). Congela el contrato que sale por la API y
 * la barrera que evita que los objetos internos de P1 se filtren al exterior.
 *
 * Reglas de construcción:
 *   - Allowlist positiva, nunca spread/blacklist/JSON.parse(JSON.stringify(...)).
 *   - `result` no se publica (string arbitrario de dominio).
 *   - `failureReason` solo si pertenece al catálogo cerrado conocido; cualquier
 *     otro valor se convierte en el literal `"unknown"`.
 *   - Service y panel tienen presenters explícitos aunque hoy publiquen lo mismo.
 */

import { z } from "zod";
import type { InitiativeState, InitiativeMode } from "../agenda/state.ts";
import type {
  InternalAutonomySnapshot,
  InternalInitiative,
  InternalTrigger,
  AgendaEntry,
} from "../agenda/autonomy-projection.ts";
import type { CreateTriggerResult } from "../agenda/triggers.ts";
import type {
  CancelInitiativeResult,
  RespondInitiativeResult,
} from "../agenda/autonomy-control.ts";
import type { DomainErrorCode } from "../agenda/errors.ts";
import { toApiError } from "../agenda/errors.ts";
import type { ApiErrorCode } from "./errors.ts";
import { MAX_HUMAN_ANSWER_LENGTH } from "../agenda/initiatives.ts";

// ---------------------------------------------------------------------------
// Tipos públicos (lo que ve el caller)
// ---------------------------------------------------------------------------

/** Ocho estados literales exactos de Initiative. */
type PublicInitiativeStatus = InitiativeState;

/** Modo solo/ask. */
type PublicInitiativeMode = InitiativeMode;

/**
 * FailureReason saneado: solo los literales del catálogo, o `null` si no hubo
 * fallo. Cualquier string arbitrario del dominio se convierte en `"unknown"`.
 */
export type SanitizedFailureReason =
  | "turn_failed"
  | "runner_unavailable"
  | "dispatch_failed"
  | "agent_errored"
  | "chain_deadline_exceeded"
  | "startup_recovery"
  | "unknown"
  | null;

const KNOWN_FAILURE_REASONS = new Set<string>([
  "turn_failed",
  "runner_unavailable",
  "dispatch_failed",
  "agent_errored",
  "chain_deadline_exceeded",
  "startup_recovery",
]);

export function sanitizeFailureReason(raw: string | null): SanitizedFailureReason {
  if (raw === null) return null;
  return KNOWN_FAILURE_REASONS.has(raw) ? (raw as SanitizedFailureReason) : "unknown";
}

/** Initiative pública (allowlist positiva, clave por clave). */
export interface PublicInitiative {
  readonly id: string;
  readonly origin: "trigger" | "callback" | "human";
  readonly triggerId: string | null;
  readonly status: PublicInitiativeStatus;
  readonly mode: PublicInitiativeMode;
  readonly intent: string;
  readonly summary: string | null;
  readonly question: string | null;
  readonly availableAt: number;
  readonly createdAt: number;
  readonly stateChangedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly expiresAt: number | null;
  readonly failureReason: SanitizedFailureReason;
}

/** Schedule v1 de Trigger (read/execute-only, no se crea). */
export interface PublicScheduleV1 {
  readonly version: 1;
  readonly kind: "interval";
  readonly intervalMs: number;
}

/** Schedule v2 daily. */
export interface PublicScheduleV2Daily {
  readonly version: 2;
  readonly kind: "daily";
  readonly timeZone: string;
  readonly at: string;
}

/** Schedule v2 weekly. */
export interface PublicScheduleV2Weekly {
  readonly version: 2;
  readonly kind: "weekly";
  readonly timeZone: string;
  readonly at: string;
  readonly days: readonly string[];
}

export type PublicSchedule =
  | PublicScheduleV1
  | PublicScheduleV2Daily
  | PublicScheduleV2Weekly;

/** Trigger público (allowlist positiva, clave por clave). */
export interface PublicTrigger {
  readonly id: string;
  readonly kind: string;
  readonly definition: PublicSchedule;
  readonly intent: string;
  readonly mode: PublicInitiativeMode;
  readonly suggestedSkill: string | null;
  readonly createdBy: "owner" | "control_plane" | "agent";
  readonly authority: "owner" | "control_plane";
  readonly proposalState: "proposed" | "approved" | null;
  readonly enabled: boolean;
  readonly nextFireAt: number | null;
  readonly lastFiredAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Posición 1-based en la agenda. */
export interface PublicAgendaEntry {
  readonly position: number;
  readonly initiative: PublicInitiative;
}

/** Snapshot público de autonomía. */
export interface PublicAutonomySnapshot {
  readonly asOf: number;
  readonly initiatives: readonly PublicInitiative[];
  readonly agenda: readonly PublicAgendaEntry[];
  readonly inbox: readonly PublicInitiative[];
  readonly triggers: readonly PublicTrigger[];
  readonly historyTruncated: boolean;
}

/** Resultado de create trigger. */
export interface PublicCreateTriggerResult {
  readonly trigger: PublicTrigger;
  readonly replayed: boolean;
}

/** Resultado de revoke trigger. */
export interface PublicRevokeTriggerResult {
  readonly trigger: PublicTrigger;
}

/** Resultado de cancel initiative. */
export interface PublicCancelInitiativeResult {
  readonly status: "cancelled" | "cancellation_requested";
  readonly initiative: PublicInitiative;
}

/** Resultado de respond to initiative. */
export interface PublicRespondInitiativeResult {
  readonly initiative: PublicInitiative;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Schemas strict de entrada (Zod)
// ---------------------------------------------------------------------------

/** `HH:mm` estricto (`00:00`–`23:59`). */
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Día de la semana del catálogo. */
const WEEKDAY_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const scheduleV2DailySchema = z
  .object({
    version: z.literal(2),
    kind: z.literal("daily"),
    timeZone: z.string().min(1),
    at: z.string().regex(AT_PATTERN, "HH:mm required"),
  })
  .strict();

const scheduleV2WeeklySchema = z
  .object({
    version: z.literal(2),
    kind: z.literal("weekly"),
    timeZone: z.string().min(1),
    at: z.string().regex(AT_PATTERN, "HH:mm required"),
    days: z
      .array(z.enum(WEEKDAY_VALUES))
      .min(1)
      .max(7),
  })
  .strict();

/** Schema del `definition` de create trigger (solo v2). */
const scheduleV2Schema = z.discriminatedUnion("kind", [
  scheduleV2DailySchema,
  scheduleV2WeeklySchema,
]);

/** Schema del body de `POST /agents/:name/triggers`. */
export const createTriggerBodySchema = z
  .object({
    definition: scheduleV2Schema,
    intent: z.string().min(1),
    mode: z.enum(["solo", "ask"]),
    suggestedSkill: z.string().min(1).nullable().optional(),
  })
  .strict();

/** Schema del body de `POST /agents/:name/initiatives/:id/respond`. */
export const respondBodySchema = z
  .object({
    answer: z.string().min(1).max(MAX_HUMAN_ANSWER_LENGTH),
  })
  .strict();

// ---------------------------------------------------------------------------
// Presenters — allowlist positiva, nunca spread/blacklist
// ---------------------------------------------------------------------------

function presentInitiative(initiative: InternalInitiative): PublicInitiative {
  return {
    id: initiative.id,
    origin: initiative.origin,
    triggerId: initiative.triggerId,
    status: initiative.state,
    mode: initiative.mode,
    intent: initiative.intent,
    summary: initiative.summary,
    question: initiative.humanQuestion,
    availableAt: initiative.availableAt,
    createdAt: initiative.createdAt,
    stateChangedAt: initiative.stateChangedAt,
    startedAt: initiative.startedAt,
    finishedAt: initiative.finishedAt,
    expiresAt: initiative.humanExpiresAt,
    failureReason: sanitizeFailureReason(initiative.failureReason),
  };
  // Prohibido: { ...initiative }, JSON.parse(JSON.stringify(...)), blacklist
  // No salen: sessionKey, turnId, boundModel, askCorrelation, pendingHumanInput,
  //           result, humanRequestId, humanResponseIdempotencyKey,
  //           humanResponseCommandHash, chainDepth, chainDeadlineAt,
  //           visibleEffectsDeclared
}

function presentSchedule(definition: InternalTrigger["definition"]): PublicSchedule {
  // definition ya es ParsedSchedule (unión discriminada)
  if (definition.version === 1) {
    return {
      version: 1,
      kind: definition.kind,
      intervalMs: definition.intervalMs,
    };
  }
  if (definition.version === 2 && definition.kind === "daily") {
    return {
      version: 2,
      kind: "daily",
      timeZone: definition.timeZone,
      at: definition.at,
    };
  }
  // weekly
  return {
    version: 2,
    kind: "weekly",
    timeZone: definition.timeZone,
    at: definition.at,
    days: [...definition.days],
  };
}

function presentTrigger(trigger: InternalTrigger): PublicTrigger {
  return {
    id: trigger.id,
    kind: trigger.kind,
    definition: presentSchedule(trigger.definition),
    intent: trigger.intent,
    mode: trigger.mode,
    suggestedSkill: trigger.suggestedSkill,
    createdBy: trigger.createdBy,
    authority: trigger.authority,
    proposalState: trigger.proposalState,
    enabled: trigger.enabled,
    nextFireAt: trigger.nextFireAt,
    lastFiredAt: trigger.lastFiredAt,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
  };
  // Prohibido: { ...trigger }, definitionJson, createIdempotencyKey,
  //            createCommandHash, agentName
}

function presentAgendaEntry(entry: AgendaEntry): PublicAgendaEntry {
  return {
    position: entry.position,
    initiative: presentInitiative(entry.initiative),
  };
}

/** Presenta un snapshot interno como snapshot público. */
export function presentSnapshot(snapshot: InternalAutonomySnapshot): PublicAutonomySnapshot {
  return {
    asOf: snapshot.asOf,
    initiatives: snapshot.initiatives.map(presentInitiative),
    agenda: snapshot.agenda.map(presentAgendaEntry),
    inbox: snapshot.inbox.map(presentInitiative),
    triggers: snapshot.triggers.map(presentTrigger),
    historyTruncated: snapshot.historyTruncated,
  };
}

function presentCreateTriggerResult(result: CreateTriggerResult): PublicCreateTriggerResult {
  const trigger: InternalTrigger = result.trigger as unknown as InternalTrigger;
  return {
    trigger: presentTrigger(trigger),
    replayed: result.replayed,
  };
}

function presentCancelInitiativeResult(
  result: CancelInitiativeResult,
): PublicCancelInitiativeResult {
  const initiative = result.initiative as unknown as InternalInitiative;
  return {
    status: result.status,
    initiative: presentInitiative(initiative),
  };
}

function presentRespondInitiativeResult(
  result: RespondInitiativeResult,
): PublicRespondInitiativeResult {
  const initiative = result.initiative as unknown as InternalInitiative;
  return {
    initiative: presentInitiative(initiative),
    replayed: result.replayed,
  };
}

// ---------------------------------------------------------------------------
// Presenters por principal
// ---------------------------------------------------------------------------

/**
 * Presenter para principal `service`. Hoy publica lo mismo que `panel`,
 * pero la selección exige `principal.kind` explícito.
 */
export const SERVICE_AUTONOMY_PRESENTER = {
  presentSnapshot,
  presentCreateTriggerResult,
  presentRevokeTriggerResult(trigger: InternalTrigger): PublicRevokeTriggerResult {
    return { trigger: presentTrigger(trigger) };
  },
  presentCancelInitiativeResult,
  presentRespondInitiativeResult,
} as const;

/**
 * Presenter para principal `panel`. Misma forma hoy, política explícita y
 * testeable por separado.
 */
export const PANEL_AUTONOMY_PRESENTER = {
  presentSnapshot,
  presentCreateTriggerResult,
  presentRevokeTriggerResult(trigger: InternalTrigger): PublicRevokeTriggerResult {
    return { trigger: presentTrigger(trigger) };
  },
  presentCancelInitiativeResult,
  presentRespondInitiativeResult,
} as const;

// ---------------------------------------------------------------------------
// Traducción de DomainError a ApiErrorCode + HTTP
// ---------------------------------------------------------------------------

/**
 * Traduce un `DomainErrorCode` al catálogo HTTP de `api-v1/errors.ts`.
 * Usa el mismo `toApiError` de `agenda/errors.ts` que ya tiene el mapping
 * exhaustivo fijado por P2.2.
 */
export function autonomyErrorCode(code: DomainErrorCode): ApiErrorCode {
  return toApiError(code);
}

/**
 * Mensaje público fijo para cada código HTTP de Autonomía. El detalle real
 * va al log interno, nunca al caller.
 */
export function autonomyErrorMessage(code: ApiErrorCode): string {
  switch (code) {
    case "INITIATIVE_NOT_FOUND":
      return "Initiative not found";
    case "TRIGGER_NOT_FOUND":
      return "Trigger not found";
    case "INITIATIVE_STATE_CONFLICT":
      return "Initiative state conflict";
    case "IDEMPOTENCY_CONFLICT":
      return "Idempotency key conflict";
    case "BAD_REQUEST":
      return "Bad request";
    case "RESOURCE_UNAVAILABLE":
      return "Resource unavailable";
    default:
      return "Internal error";
  }
}