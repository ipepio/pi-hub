/**
 * Módulo de Autonomía HTTP — P2.2/P2.3. Tipos públicos, schemas estrictos,
 * presenters service/panel, traducción de DomainError y registro de rutas.
 *
 * Reglas de construcción:
 *   - Allowlist positiva, nunca spread/blacklist/JSON.parse(JSON.stringify(...)).
 *   - `result` no se publica (string arbitrario de dominio).
 *   - `failureReason` solo si pertenece al catálogo cerrado conocido; cualquier
 *     otro valor se convierte en el literal `"unknown"`.
 *   - Service y panel tienen presenters explícitos aunque hoy publiquen lo mismo.
 */

import { z } from "zod";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { InitiativeState, InitiativeMode } from "../agenda/state.ts";
import type {
  InternalAutonomySnapshot,
  InternalInitiative,
  InternalTrigger,
  AgendaEntry,
  AutonomyProjection,
} from "../agenda/autonomy-projection.ts";
import type {
  CreateTriggerResult,
  EffectiveTriggerAuthority,
} from "../agenda/triggers.ts";
import type {
  AutonomyControl,
  CancelInitiativeResult,
  RespondInitiativeResult,
} from "../agenda/autonomy-control.ts";
import type { DomainErrorCode } from "../agenda/errors.ts";
import { DomainError, toApiError } from "../agenda/errors.ts";
import type { ApiErrorCode } from "./errors.ts";
import { apiError, HTTP_STATUS_BY_CODE } from "./errors.ts";
import { MAX_HUMAN_ANSWER_LENGTH } from "../agenda/initiatives.ts";
import type { TriggerCreationPolicy } from "../agenda/triggers.ts";
import {
  PIHUB_PRINCIPAL_HEADER,
  PIHUB_RUNNER_PRINCIPAL,
  PIHUB_AGENT_HEADER,
} from "@pihub/shared";

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

export function sanitizeFailureReason(
  raw: string | null,
): SanitizedFailureReason {
  if (raw === null) return null;
  return KNOWN_FAILURE_REASONS.has(raw)
    ? (raw as SanitizedFailureReason)
    : "unknown";
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
  readonly notificationStatus: "delivered" | "not_delivered" | null;
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
  readonly authority: "owner" | "control_plane" | "agent";
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
// Admission pública (contrato congelado para P4)
// ---------------------------------------------------------------------------

/** Marca fantasma para frontera de tipos Internal/Public (ver fix P2.4b). */
const __publicBrand: unique symbol = Symbol("__publicBrand");

/** Estado de admisión público (P4 aporta la implementación real). */
export interface PublicAdmissionState {
  readonly [__publicBrand]: true;
  readonly state: "open" | "draining";
  readonly idle: boolean;
  readonly activeTurns: number;
  readonly runningInitiatives: number;
  readonly changedAt: number;
}

/** Estado interno de admisión (P4 aporta la implementación real). */
export interface AdmissionStateInternal {
  readonly state: "open" | "draining";
  readonly idle: boolean;
  readonly activeTurns: number;
  readonly runningInitiatives: number;
  readonly changedAt: number;
}

/**
 * Port contractual de admisión. En P2 producción no existe — las rutas
 * devuelven 503 RESOURCE_UNAVAILABLE. Los tests pasan un fake que satisface
 * este port. P4 aporta el adapter real y cambia las respuestas a 200 sin
 * cambiar ruta, auth, schema, presenter ni envelope.
 */
export interface AdmissionPort {
  getAdmission(): AdmissionStateInternal;
  setAdmission(state: "open" | "draining"): AdmissionStateInternal;
}

// ---------------------------------------------------------------------------
// Schemas strict de entrada (Zod)
// ---------------------------------------------------------------------------

/** `HH:mm` estricto (`00:00`–`23:59`). */
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Día de la semana del catálogo. */
const WEEKDAY_VALUES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

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
    days: z.array(z.enum(WEEKDAY_VALUES)).min(1).max(7),
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
    // P3.2/B1: OPCIONAL y aditivo (no rompe el contrato congelado). Ausente o
    // null = comportamiento actual; el panel (A11) lo envía con el
    // `human_request_id` que muestra y el Manager lo exige solo cuando viene.
    expectedHumanRequestId: z.string().nullable().optional(),
  })
  .strict();

/** Schema del body de `PUT /runtime/admission`. */
export const admissionBodySchema = z
  .object({
    state: z.enum(["open", "draining"]),
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
    notificationStatus:
      initiative.state === "waiting_human"
        ? initiative.notificationStatus
        : null,
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
  //           result, humanRequestId, coordenadas de delivery,
  //           humanResponseIdempotencyKey, humanResponseCommandHash,
  //           chainDepth, chainDeadlineAt, visibleEffectsDeclared
}

function presentSchedule(
  definition: InternalTrigger["definition"],
): PublicSchedule {
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
export function presentSnapshot(
  snapshot: InternalAutonomySnapshot,
): PublicAutonomySnapshot {
  return {
    asOf: snapshot.asOf,
    initiatives: snapshot.initiatives.map(presentInitiative),
    agenda: snapshot.agenda.map(presentAgendaEntry),
    inbox: snapshot.inbox.map(presentInitiative),
    triggers: snapshot.triggers.map(presentTrigger),
    historyTruncated: snapshot.historyTruncated,
  };
}

function presentCreateTriggerResult(
  result: CreateTriggerResult,
): PublicCreateTriggerResult {
  // SAFETY: CreateTriggerResult.trigger y InternalTrigger son el mismo objeto de
  // dominio Trigger; los campos internos de idempotencia se descartan en
  // `presentTrigger` (allowlist), nunca se exponen.
  const trigger: InternalTrigger = result.trigger as unknown as InternalTrigger;
  return {
    trigger: presentTrigger(trigger),
    replayed: result.replayed,
  };
}

function presentCancelInitiativeResult(
  result: CancelInitiativeResult,
): PublicCancelInitiativeResult {
  // SAFETY: CancelInitiativeResult.initiative es el mismo objeto de dominio
  // Initiative; los campos internos se filtran en `presentInitiative`.
  const initiative = result.initiative as unknown as InternalInitiative;
  return {
    status: result.status,
    initiative: presentInitiative(initiative),
  };
}

function presentRespondInitiativeResult(
  result: RespondInitiativeResult,
): PublicRespondInitiativeResult {
  // SAFETY: RespondInitiativeResult.initiative es el mismo objeto de dominio
  // Initiative; los campos internos se filtran en `presentInitiative`.
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
  presentRevokeTriggerResult(
    trigger: InternalTrigger,
  ): PublicRevokeTriggerResult {
    return { trigger: presentTrigger(trigger) };
  },
  presentCancelInitiativeResult,
  presentRespondInitiativeResult,
  presentAdmission: presentAdmissionState,
} as const;

/**
 * Presenter para principal `panel`. Misma forma hoy, política explícita y
 * testeable por separado.
 */
export const PANEL_AUTONOMY_PRESENTER = {
  presentSnapshot,
  presentCreateTriggerResult,
  presentRevokeTriggerResult(
    trigger: InternalTrigger,
  ): PublicRevokeTriggerResult {
    return { trigger: presentTrigger(trigger) };
  },
  presentCancelInitiativeResult,
  presentRespondInitiativeResult,
  presentAdmission: presentAdmissionState,
} as const;

// ---------------------------------------------------------------------------
// Presenter de admisión
// ---------------------------------------------------------------------------

function presentAdmissionState(
  state: AdmissionStateInternal,
): PublicAdmissionState {
  return {
    [__publicBrand]: true as const,
    state: state.state,
    idle: state.idle,
    activeTurns: state.activeTurns,
    runningInitiatives: state.runningInitiatives,
    changedAt: state.changedAt,
  };
  // Prohibido: { ...state }, spread, blacklist
}

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
    case "FORBIDDEN":
      return "Operation not permitted";
    case "AUTONOMY_DISABLED":
      return "Autonomous trigger creation is disabled";
    case "TRIGGER_LIMIT_REACHED":
      return "Active agent trigger limit reached";
    case "TRIGGER_AUTHORITY_CONFLICT":
      return "Trigger authority conflict";
    case "BAD_REQUEST":
      return "Bad request";
    case "RESOURCE_UNAVAILABLE":
      return "Resource unavailable";
    default:
      return "Internal error";
  }
}

// ---------------------------------------------------------------------------
// Type para el tipo ApiV1Env que routes.ts define
// ---------------------------------------------------------------------------

interface AuthEnv {
  Variables: {
    correlationId: string;
    principal: { kind: "service" | "panel" };
  };
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function fail(c: Context<AuthEnv>, code: ApiErrorCode, message: string) {
  return c.json(
    apiError(code, message, c.get("correlationId")),
    HTTP_STATUS_BY_CODE[code] as ContentfulStatusCode,
  );
}

/** Recupera el presenter según el principal autenticado. */
function presenterFor(c: Context<AuthEnv>) {
  const principal = c.get("principal");
  return principal.kind === "panel"
    ? PANEL_AUTONOMY_PRESENTER
    : SERVICE_AUTONOMY_PRESENTER;
}

/**
 * Autoridad efectiva del Trigger derivada del principal autenticado (pihub step
 * 2a): sesión de panel (cookie) → `owner`; Bearer de servicio sin header de
 * principal → `control_plane`; Bearer de servicio con `PIHUB_PRINCIPAL_HEADER:
 * PIHUB_RUNNER_PRINCIPAL` (runner) → `agent`. Nunca se deduce del body: la capa
 * `api-v1/auth.ts` ya garantizó que la petición trae una credencial válida.
 * El valor del header se compara EXACTAMENTE con `PIHUB_RUNNER_PRINCIPAL`
 * ("runner"): "Runner", "agent" o vacío → `control_plane` (R3-005).
 */
function effectiveAuthorityFor(c: Context<AuthEnv>): EffectiveTriggerAuthority {
  const principal = c.get("principal");
  if (principal.kind === "panel") return "owner";
  return c.req.header(PIHUB_PRINCIPAL_HEADER) === PIHUB_RUNNER_PRINCIPAL
    ? "agent"
    : "control_plane";
}

/**
 * Liga el principal Runner al Agent sobre el que opera (R1-008): cuando la
 * petición declara `PIHUB_PRINCIPAL_HEADER: runner`, el header
 * `PIHUB_AGENT_HEADER` debe coincidir con el `:name` de la ruta; si falta o no
 * coincide (un Runner intentando operar sobre otro Agent) → `FORBIDDEN`.
 * `runtime-agent tools` solo pasan por aquí; nunca se deduce el principal del
 * body. Suplantar la identidad exige la credencial de servicio, ya borrada del
 * env alcanzable por el agente (R1-001).
 */
function assertRunnerBinding(c: Context<AuthEnv>, agentName: string): void {
  if (c.req.header(PIHUB_PRINCIPAL_HEADER) !== PIHUB_RUNNER_PRINCIPAL) return;
  const declared = c.req.header(PIHUB_AGENT_HEADER);
  if (declared !== agentName) {
    throw new DomainError(
      "FORBIDDEN",
      `runner declarado ${String(declared ?? "(sin X-Pihub-Agent)")} no puede operar sobre el agente ${agentName}`,
    );
  }
}

/** Parámetro de ruta obligatorio; missing = 400. */
function requiredParam(c: Context<AuthEnv>, name: string): string {
  const val = c.req.param(name);
  if (val === undefined || val === "") {
    throw fail(c, "BAD_REQUEST", `Missing required parameter: ${name}`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Dependencias del módulo de rutas
// ---------------------------------------------------------------------------

/** Dependencias necesarias para registrar las rutas de autonomía. */
export interface AutonomyRouteDeps {
  readonly projection: Pick<AutonomyProjection, "snapshotForAgent">;
  readonly control: AutonomyControl;
  readonly agentExists: (name: string) => Promise<boolean>;
  readonly now: () => number;
  /**
   * Lee la política de Triggers de un Agent (`AgentConfig.autonomy.triggers`,
   * aditiva) para el gate de la autoridad `agent`. Ausente si el Agent no la
   * declara (el repositorio aplica los defaults del Manager). Solo se consulta
   * cuando la autoridad efectiva es `agent`. Si la lectura falla con un error
   * distinto de `ENOENT` debe lanzar `AUTONOMY_DISABLED` (fail-closed, R4-004),
   * no devolver defaults silenciosos.
   */
  readonly readAgentTriggerPolicy?: (
    name: string,
  ) => Promise<TriggerCreationPolicy | undefined>;
  /**
   * Port opcional de admisión. En producción P2 no está presente → las rutas
   * devuelven 503 RESOURCE_UNAVAILABLE. P4 aporta el adapter real.
   */
  readonly admission?: AdmissionPort;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetAutonomy(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Response | Promise<Response> {
  const agentName = requiredParam(c, "name");
  return handleAgentNotFound(c, deps, agentName, async () => {
    const now = deps.now();
    const snapshot = deps.projection.snapshotForAgent(agentName, now);
    const presenter = presenterFor(c);
    const publicSnapshot = presenter.presentSnapshot(snapshot);
    return c.json(publicSnapshot);
  });
}

async function handleCreateTrigger(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Promise<Response> {
  const agentName = requiredParam(c, "name");
  return handleAgentNotFound(c, deps, agentName, async () => {
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      return fail(c, "BAD_REQUEST", "Idempotency-Key header is required");
    }
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) {
      return fail(c, "BAD_REQUEST", "Invalid JSON body");
    }
    const parsed = createTriggerBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, "BAD_REQUEST", "Invalid trigger payload");
    }
    const { definition, intent, mode, suggestedSkill } = parsed.data;
    const now = deps.now();
    try {
      // P2.4a: la autoridad efectiva se resuelve por request desde el principal
      // autenticado (panel→owner, service→control_plane, service+header→agent).
      // Solo para `agent` se consulta la política (config del agente) para el gate.
      assertRunnerBinding(c, agentName);
      const authority = effectiveAuthorityFor(c);
      const policy =
        authority === "agent"
          ? await deps.readAgentTriggerPolicy?.(agentName)
          : undefined;
      const result = deps.control.createTrigger(
        {
          agentName,
          definition: definition as never,
          intent,
          mode,
          suggestedSkill: suggestedSkill ?? null,
          idempotencyKey: idempotencyKey.trim(),
          now,
        },
        { authority, policy },
      );
      const presenter = presenterFor(c);
      const publicResult = presenter.presentCreateTriggerResult(result);
      return c.json(publicResult, result.replayed ? 200 : 201);
    } catch (error) {
      return handleDomainError(c, error);
    }
  });
}

async function handleRevokeTrigger(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Promise<Response> {
  const agentName = requiredParam(c, "name");
  const triggerId = requiredParam(c, "id");
  return handleAgentNotFound(c, deps, agentName, async () => {
    const now = deps.now();
    try {
      // P2.4a: igual que create — la autoridad efectiva se resuelve por request.
      assertRunnerBinding(c, agentName);
      const trigger = deps.control.revokeTrigger(
        { agentName, triggerId, now },
        { authority: effectiveAuthorityFor(c) },
      );
      const presenter = presenterFor(c);
      // SAFETY: Trigger devuelto por revokeTrigger es el mismo objeto de dominio;
      // los campos internos se filtran en `presentTrigger` (allowlist).
      const publicResult = presenter.presentRevokeTriggerResult(
        trigger as unknown as InternalTrigger,
      );
      return c.json(publicResult, 200);
    } catch (error) {
      return handleDomainError(c, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Handlers P2.4 — cancel/respond y admisión
// ---------------------------------------------------------------------------

async function handleCancelInitiative(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Promise<Response> {
  const agentName = requiredParam(c, "name");
  const initiativeId = requiredParam(c, "id");
  return handleAgentNotFound(c, deps, agentName, async () => {
    const now = deps.now();
    try {
      const result = deps.control.cancelInitiative({
        agentName,
        initiativeId,
        now,
      });
      const presenter = presenterFor(c);
      const publicResult = presenter.presentCancelInitiativeResult(result);
      // running → 202 cancellation_requested; resto → 200 cancelled
      const status = result.status === "cancellation_requested" ? 202 : 200;
      return c.json(publicResult, status);
    } catch (error) {
      return handleDomainError(c, error);
    }
  });
}

async function handleRespondInitiative(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Promise<Response> {
  const agentName = requiredParam(c, "name");
  const initiativeId = requiredParam(c, "id");
  return handleAgentNotFound(c, deps, agentName, async () => {
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      return fail(c, "BAD_REQUEST", "Idempotency-Key header is required");
    }
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) {
      return fail(c, "BAD_REQUEST", "Invalid JSON body");
    }
    const parsed = respondBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, "BAD_REQUEST", "Invalid respond payload");
    }
    const { answer, expectedHumanRequestId } = parsed.data;
    const now = deps.now();
    try {
      const result = deps.control.respondToInitiative({
        agentName,
        initiativeId,
        answer,
        idempotencyKey: idempotencyKey.trim(),
        now,
        expectedHumanRequestId: expectedHumanRequestId ?? null,
      });
      const presenter = presenterFor(c);
      const publicResult = presenter.presentRespondInitiativeResult(result);
      return c.json(publicResult, 200);
    } catch (error) {
      return handleDomainError(c, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Handlers de admisión (P2.4 shell contractual)
// ---------------------------------------------------------------------------

function handleGetAdmission(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Response {
  if (!deps.admission) {
    return fail(c, "RESOURCE_UNAVAILABLE", "Admission not yet available (P4)");
  }
  const state = deps.admission.getAdmission();
  const presenter = presenterFor(c);
  return c.json(presenter.presentAdmission(state));
}

async function handlePutAdmission(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
): Promise<Response> {
  if (!deps.admission) {
    return fail(c, "RESOURCE_UNAVAILABLE", "Admission not yet available (P4)");
  }
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) {
    return fail(c, "BAD_REQUEST", "Invalid JSON body");
  }
  const parsed = admissionBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, "BAD_REQUEST", "Invalid admission payload");
  }
  const state = deps.admission.setAdmission(parsed.data.state);
  const presenter = presenterFor(c);
  return c.json(presenter.presentAdmission(state));
}

// ---------------------------------------------------------------------------
// Helpers de handler
// ---------------------------------------------------------------------------

async function handleAgentNotFound(
  c: Context<AuthEnv>,
  deps: AutonomyRouteDeps,
  agentName: string,
  fn: () => Response | Promise<Response>,
): Promise<Response> {
  if (!(await deps.agentExists(agentName))) {
    return fail(c, "AGENT_NOT_FOUND", "Agent not found");
  }
  return fn();
}

function handleDomainError(c: Context<AuthEnv>, error: unknown): Response {
  if (error instanceof Error && (error as DomainError).code !== undefined) {
    const code = (error as DomainError).code;
    const apiCode = toApiError(code as DomainErrorCode);
    // Loggear el detalle interno con correlationId
    console.error(
      `[api-v1] autonomy error: ${apiCode} correlationId=${c.get("correlationId")} detail=${(error as Error).message}`,
    );
    return fail(c, apiCode, autonomyErrorMessage(apiCode));
  }
  console.error(
    `[api-v1] autonomy unexpected error: correlationId=${c.get("correlationId")} detail=${(error as Error).message ?? error}`,
  );
  return fail(c, "INTERNAL_ERROR", "Internal error");
}

// ---------------------------------------------------------------------------
// Registro de rutas (P2.3)
// ---------------------------------------------------------------------------

/**
 * Registra las rutas de autonomía (GET snapshot, POST create trigger,
 * POST revoke trigger, POST cancel, POST respond y GET/PUT admission)
 * en la aplicación Hono.
 *
 * La autorización del Agent (agentExists) corre antes de validar el body
 * o el comando: un Agent inexistente debe dar 404 aunque el body sea basura.
 *
 * Las rutas de admisión usan un port opcional: si no está presente (producción
 * P2), responden 503 RESOURCE_UNAVAILABLE. P4 aporta el adapter real.
 */
export function registerAutonomyRoutes(
  app: {
    get: (
      path: string,
      handler: (c: Context<AuthEnv>) => Response | Promise<Response>,
    ) => void;
    post: (
      path: string,
      handler: (c: Context<AuthEnv>) => Response | Promise<Response>,
    ) => void;
    put: (
      path: string,
      handler: (c: Context<AuthEnv>) => Response | Promise<Response>,
    ) => void;
  },
  deps: AutonomyRouteDeps,
): void {
  // GET /agents/:name/autonomy — snapshot público
  app.get("/agents/:name/autonomy", (c) => handleGetAutonomy(c, deps));

  // POST /agents/:name/triggers — create trigger
  app.post("/agents/:name/triggers", (c) => handleCreateTrigger(c, deps));

  // POST /agents/:name/triggers/:id/revoke — revoke trigger
  app.post("/agents/:name/triggers/:id/revoke", (c) =>
    handleRevokeTrigger(c, deps),
  );

  // POST /agents/:name/initiatives/:id/cancel — cancel initiative
  app.post("/agents/:name/initiatives/:id/cancel", (c) =>
    handleCancelInitiative(c, deps),
  );

  // POST /agents/:name/initiatives/:id/respond — respond to initiative
  app.post("/agents/:name/initiatives/:id/respond", (c) =>
    handleRespondInitiative(c, deps),
  );

  // GET /runtime/admission — shell contractual (P2: 503 sin port; P4: real)
  app.get("/runtime/admission", (c) => handleGetAdmission(c, deps));

  // PUT /runtime/admission — shell contractual (P2: 503 sin port; P4: real)
  app.put("/runtime/admission", (c) => handlePutAdmission(c, deps));
}
