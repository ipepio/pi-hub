/**
 * Tests de presenters de autonomía — P2.2 (§3.2 del plan).
 *
 * Dos guards complementarios:
 *   1. Shape exacta recursiva para service y panel.
 *   2. Taint automática de todo lo no permitido.
 *
 * El test de taint es resistente: recorre claves reales de objetos internos,
 * sustituye por `LEAK::<path>` todo valor cuyo path no esté en la allowlist,
 * y afirma que ningún `LEAK::` aparece tras presentar y serializar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  presentSnapshot,
  SERVICE_AUTONOMY_PRESENTER,
  PANEL_AUTONOMY_PRESENTER,
  sanitizeFailureReason,
  createTriggerBodySchema,
  respondBodySchema,
} from "../src/api-v1/autonomy.ts";
import type {
  InternalAutonomySnapshot,
  InternalInitiative,
  InternalTrigger,
  AgendaEntry,
} from "../src/agenda/autonomy-projection.ts";
import type { CreateTriggerResult, Trigger } from "../src/agenda/triggers.ts";
import type { Initiative } from "../src/agenda/initiatives.ts";
import type { CancelInitiativeResult, RespondInitiativeResult } from "../src/agenda/autonomy-control.ts";
import { MAX_HUMAN_ANSWER_LENGTH } from "../src/agenda/initiatives.ts";

// ---------------------------------------------------------------------------
// Helpers: construir objetos internos mínimos para los tests
// ---------------------------------------------------------------------------

function makeInternalInitiative(overrides?: Partial<InternalInitiative>): InternalInitiative {
  const base: InternalInitiative = {
    id: "ini-1",
    agentName: "test-agent",
    state: "queued",
    origin: "trigger",
    triggerId: "trg-1",
    intent: "test intent",
    mode: "solo",
    sessionKey: "sk_test_123",
    availableAt: 1_700_000_000_000,
    boundModel: "gpt-4",
    turnId: "turn-1",
    chainDepth: 0,
    chainDeadlineAt: null,
    visibleEffectsDeclared: false,
    summary: "a test summary",
    askCorrelation: null,
    failureReason: null,
    result: "some result text",
    createdAt: 1_700_000_000_000,
    stateChangedAt: 1_700_000_000_000,
    startedAt: null,
    finishedAt: null,
    humanQuestion: null,
    humanExpiresAt: null,
    humanRequestId: null,
    pendingHumanInput: null,
    humanResponseIdempotencyKey: null,
    humanResponseCommandHash: null,
  };
  return { ...base, ...overrides };
}

function makeInternalTrigger(overrides?: Partial<InternalTrigger>): InternalTrigger {
  const base: InternalTrigger = {
    id: "trg-1",
    agentName: "test-agent",
    kind: "schedule",
    definition: {
      version: 2,
      kind: "daily",
      timeZone: "Europe/Madrid",
      at: "09:00",
    } as const,
    definitionJson: '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
    intent: "daily check",
    mode: "solo",
    suggestedSkill: null,
    createdBy: "owner",
    authority: "owner",
    proposalState: null,
    enabled: true,
    nextFireAt: 1_700_086_400_000,
    lastFiredAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    createIdempotencyKey: null,
    createCommandHash: null,
  };
  return { ...base, ...overrides };
}

function makeSnapshot(overrides?: Partial<InternalAutonomySnapshot>): InternalAutonomySnapshot {
  const initiative = makeInternalInitiative();
  const trigger = makeInternalTrigger();
  const base: InternalAutonomySnapshot = {
    asOf: 1_700_000_000_000,
    initiatives: [initiative],
    agenda: [{ position: 1, initiative }],
    inbox: [],
    triggers: [trigger],
    historyTruncated: false,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Públicas esperadas como referencia de shape
// ---------------------------------------------------------------------------

const EXPECTED_INITIATIVE_KEYS = [
  "id",
  "origin",
  "triggerId",
  "status",
  "mode",
  "intent",
  "summary",
  "question",
  "availableAt",
  "createdAt",
  "stateChangedAt",
  "startedAt",
  "finishedAt",
  "expiresAt",
  "failureReason",
].sort();

const EXPECTED_TRIGGER_KEYS = [
  "id",
  "kind",
  "definition",
  "intent",
  "mode",
  "suggestedSkill",
  "createdBy",
  "authority",
  "proposalState",
  "enabled",
  "nextFireAt",
  "lastFiredAt",
  "createdAt",
  "updatedAt",
].sort();

const EXPECTED_SNAPSHOT_KEYS = [
  "asOf",
  "initiatives",
  "agenda",
  "inbox",
  "triggers",
  "historyTruncated",
].sort();

const EXPECTED_AGENDA_ENTRY_KEYS = ["position", "initiative"].sort();

const EXPECTED_CREATE_TRIGGER_RESULT_KEYS = ["trigger", "replayed"].sort();
const EXPECTED_REVOKE_TRIGGER_RESULT_KEYS = ["trigger"].sort();
const EXPECTED_CANCEL_INITIATIVE_RESULT_KEYS = ["status", "initiative"].sort();
const EXPECTED_RESPOND_INITIATIVE_RESULT_KEYS = ["initiative", "replayed"].sort();

// ---------------------------------------------------------------------------
// Helper: inyecta propiedades internas «futuras» (simula columnas nuevas
// que el presenter no conoce) y contamina claves secretas reales.
// No contamina claves que el presenter LEE (aunque internamente tengan
// otro nombre, como `state`→`status`).
// ---------------------------------------------------------------------------

/**
 * Claves internas de Initiative que el presenter LEE (algunas renombradas).
 * Cualquier otra clave es un secreto interno que NO debe llegar al exterior.
 */
const INITIATIVE_PRESENTER_READS = new Set([
  "id", "origin", "triggerId",
  "state",              // → status
  "mode", "intent", "summary",
  "humanQuestion",      // → question
  "availableAt", "createdAt", "stateChangedAt",
  "startedAt", "finishedAt",
  "humanExpiresAt",     // → expiresAt
  "failureReason",
]);

/**
 * Claves internas de Trigger que el presenter LEE.
 */
const TRIGGER_PRESENTER_READS = new Set([
  "id", "kind", "definition",
  "intent", "mode", "suggestedSkill",
  "createdBy", "authority", "proposalState",
  "enabled", "nextFireAt", "lastFiredAt",
  "createdAt", "updatedAt",
]);

function taintSecrets<T extends Record<string, unknown>>(
  obj: T,
  presenterReads: Set<string>,
  futureProps?: Record<string, string>,
): T {
  const tainted = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!presenterReads.has(key)) {
      tainted[key] = `LEAK::${key}`;
    }
  }
  if (futureProps) {
    for (const [key, value] of Object.entries(futureProps)) {
      tainted[key] = value;
    }
  }
  return tainted as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autonomy presenters — shape exacta", () => {
  it("service presenter tiene los métodos esperados", () => {
    assert.ok(typeof SERVICE_AUTONOMY_PRESENTER.presentSnapshot === "function");
    assert.ok(typeof SERVICE_AUTONOMY_PRESENTER.presentCreateTriggerResult === "function");
    assert.ok(typeof SERVICE_AUTONOMY_PRESENTER.presentRevokeTriggerResult === "function");
    assert.ok(typeof SERVICE_AUTONOMY_PRESENTER.presentCancelInitiativeResult === "function");
    assert.ok(typeof SERVICE_AUTONOMY_PRESENTER.presentRespondInitiativeResult === "function");
  });

  it("panel presenter tiene los mismos métodos que service", () => {
    assert.ok(typeof PANEL_AUTONOMY_PRESENTER.presentSnapshot === "function");
    assert.ok(typeof PANEL_AUTONOMY_PRESENTER.presentCreateTriggerResult === "function");
    assert.ok(typeof PANEL_AUTONOMY_PRESENTER.presentRevokeTriggerResult === "function");
    assert.ok(typeof PANEL_AUTONOMY_PRESENTER.presentCancelInitiativeResult === "function");
    assert.ok(typeof PANEL_AUTONOMY_PRESENTER.presentRespondInitiativeResult === "function");
  });

  it("PublicInitiative tiene las claves exactas (allowlist)", () => {
    const snap = makeSnapshot();
    const pub = presentSnapshot(snap);
    const initiative = pub.initiatives[0];
    const keys = Object.keys(initiative).sort();
    assert.deepEqual(keys, EXPECTED_INITIATIVE_KEYS);
  });

  it("PublicTrigger tiene las claves exactas (allowlist)", () => {
    const snap = makeSnapshot();
    const pub = presentSnapshot(snap);
    const trigger = pub.triggers[0];
    const keys = Object.keys(trigger).sort();
    assert.deepEqual(keys, EXPECTED_TRIGGER_KEYS);
  });

  it("AutonomySnapshot tiene las claves exactas", () => {
    const snap = makeSnapshot();
    const pub = presentSnapshot(snap);
    const keys = Object.keys(pub).sort();
    assert.deepEqual(keys, EXPECTED_SNAPSHOT_KEYS);
  });

  it("AgendaEntry tiene position e initiative", () => {
    const snap = makeSnapshot();
    const pub = presentSnapshot(snap);
    const entry = pub.agenda[0];
    const keys = Object.keys(entry).sort();
    assert.deepEqual(keys, EXPECTED_AGENDA_ENTRY_KEYS);
  });

  it("service y panel producen el mismo snapshot para el mismo input", () => {
    const snap = makeSnapshot();
    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentSnapshot(snap);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentSnapshot(snap);
    assert.deepEqual(servicePub, panelPub);
  });
});

describe("autonomy presenters — failureReason saneado", () => {
  it("failureReason null se queda null", () => {
    assert.equal(sanitizeFailureReason(null), null);
  });

  it("failureReason conocido pasa igual", () => {
    assert.equal(sanitizeFailureReason("turn_failed"), "turn_failed");
    assert.equal(sanitizeFailureReason("runner_unavailable"), "runner_unavailable");
    assert.equal(sanitizeFailureReason("dispatch_failed"), "dispatch_failed");
    assert.equal(sanitizeFailureReason("agent_errored"), "agent_errored");
    assert.equal(sanitizeFailureReason("chain_deadline_exceeded"), "chain_deadline_exceeded");
    assert.equal(sanitizeFailureReason("startup_recovery"), "startup_recovery");
  });

  it("failureReason desconocido se vuelve unknown", () => {
    assert.equal(sanitizeFailureReason("arbitrary text"), "unknown");
    assert.equal(sanitizeFailureReason("corruption_detected"), "unknown");
  });
});

describe("autonomy schemas — createTriggerBodySchema", () => {
  it("daily válido pasa", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
      intent: "revisar",
      mode: "solo",
    });
    assert.equal(result.success, true);
  });

  it("weekly válido pasa", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00", days: ["mon", "wed", "fri"] },
      intent: "weekly review",
      mode: "ask",
      suggestedSkill: null,
    });
    assert.equal(result.success, true);
  });

  it("version 1 (interval) es rechazado", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 1, kind: "interval", intervalMs: 3_600_000 },
      intent: "test",
      mode: "solo",
    });
    assert.equal(result.success, false);
  });

  it("claves extra son rechazadas (.strict())", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
      intent: "test",
      mode: "solo",
      extraField: "nope",
    });
    assert.equal(result.success, false);
  });

  it("daily sin at es rechazado", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid" },
      intent: "test",
      mode: "solo",
    });
    assert.equal(result.success, false);
  });

  it("at malformado (9:00 en vez de 09:00) es rechazado", () => {
    const result = createTriggerBodySchema.safeParse({
      definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "9:00" },
      intent: "test",
      mode: "solo",
    });
    assert.equal(result.success, false);
  });
});

describe("autonomy schemas — respondBodySchema", () => {
  it("answer 1..4000 pasa", () => {
    const result = respondBodySchema.safeParse({ answer: "sí, procede" });
    assert.equal(result.success, true);
  });

  it("answer vacío es rechazado", () => {
    const result = respondBodySchema.safeParse({ answer: "" });
    assert.equal(result.success, false);
  });

  it("answer de 4001 chars es rechazado", () => {
    const result = respondBodySchema.safeParse({ answer: "x".repeat(MAX_HUMAN_ANSWER_LENGTH + 1) });
    assert.equal(result.success, false);
  });

  it("claves extra son rechazadas (.strict())", () => {
    const result = respondBodySchema.safeParse({ answer: "ok", extra: true });
    assert.equal(result.success, false);
  });
});

describe("autonomy presenters — taint automática (§3.2)", () => {
  /**
   * Fixture que parte de objetos internos reales construidos por
   * makeInternalInitiative / makeInternalTrigger, recorre Object.keys(interno)
   * y sustituye por `LEAK::<key>` todo valor cuya clave no pertenezca a la
   * allowlist pública (EXPECTED_INITIATIVE_KEYS / EXPECTED_TRIGGER_KEYS).
   * También inyecta `telegramDeliveryId` simulando una futura columna interna
   * que ningún presenter conoce aún — solo el recorrido automático por
   * Object.keys puede detectarlo.
   *
   * Tras presentar y JSON.stringify, ningún `LEAK::` puede aparecer.
   */
  it("presenters never serialize tainted internal fields (Object.keys + allowlist)", () => {
    // 1. Objetos internos reales
    const rawInitiative = makeInternalInitiative();
    const rawTrigger = makeInternalTrigger();

    // 2. Contaminar claves no allowlist mediante Object.keys
    //    También inyectar telegramDeliveryId como futura columna interna
    //    que NO está en la allowlist — el taint automático la descubre.
    const futureProps = {
      telegramDeliveryId: "LEAK::telegramDeliveryId",
      token: "LEAK::token",
      transcript: "LEAK::transcript",
      secretCorrelation: "LEAK::secretCorrelation",
    };

    const taintedInitiative = taintSecrets(rawInitiative, INITIATIVE_PRESENTER_READS, futureProps);
    const taintedTrigger = taintSecrets(rawTrigger, TRIGGER_PRESENTER_READS, futureProps);

    // Verificar que el taint funciona: alguna clave debe haberse contaminado
    const taintedKeys = Object.keys(taintedInitiative).filter(k =>
      (taintedInitiative as Record<string, unknown>)[k]?.toString().startsWith("LEAK::"),
    );
    assert.ok(taintedKeys.length > 0, "el helper debe marcar al menos una clave secreta");

    // Verificar específicamente que telegramDeliveryId está contaminada
    // (futura columna que ningún presenter conoce)
    assert.equal(
      (taintedInitiative as Record<string, unknown>).telegramDeliveryId,
      "LEAK::telegramDeliveryId",
      "telegramDeliveryId contaminada — futura columna fuera de allowlist",
    );
    // Verificar que sessionKey también se contaminó (secreto real)
    assert.equal(
      (taintedInitiative as Record<string, unknown>).sessionKey,
      "LEAK::sessionKey",
      "sessionKey contaminada — secreto interno fuera de allowlist",
    );

    const taintedSnapshot: InternalAutonomySnapshot = {
      asOf: 1_700_000_000_000,
      initiatives: [taintedInitiative as unknown as InternalInitiative],
      agenda: [{ position: 1, initiative: taintedInitiative as unknown as InternalInitiative }],
      inbox: [taintedInitiative as unknown as InternalInitiative],
      triggers: [taintedTrigger as unknown as InternalTrigger],
      historyTruncated: false,
    };

    // 3. Presentar con service y panel
    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentSnapshot(taintedSnapshot);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentSnapshot(taintedSnapshot);

    // 4. Serializar a JSON
    const serviceJson = JSON.stringify(servicePub);
    const panelJson = JSON.stringify(panelPub);

    // 5. Afirmar que ningún LEAK:: aparece
    assert.equal(serviceJson.includes("LEAK::"), false,
      `service presenter filtró campos internos: ${serviceJson.match(/LEAK::\w+/g)?.join(", ") ?? "ninguno (inesperado)"}`);
    assert.equal(panelJson.includes("LEAK::"), false,
      `panel presenter filtró campos internos: ${panelJson.match(/LEAK::\w+/g)?.join(", ") ?? "ninguno (inesperado)"}`);

    // 6. Verificar que telegramDeliveryId no está en el output
    assert.equal(serviceJson.includes("telegramDeliveryId"), false,
      "telegramDeliveryId no debe aparecer en el JSON de service");
    assert.equal(panelJson.includes("telegramDeliveryId"), false,
      "telegramDeliveryId no debe aparecer en el JSON de panel");
  });
});

describe("autonomy presenters — mutación manual exigida: { ...initiative } rompe el test", () => {
  /**
   * Este test comprueba que si alguien cambiara presentInitiative a usar
   * `{ ...initiative }` (spread del objeto interno), entonces el test de taint
   * fallaría. Se afirma que con el código actual el test pasa (no hay spread),
   * y se documenta qué mutación debe romperlo.
   *
   * Si en el futuro este test falla sin el spread, es porque una nueva clave
   * interna se está colando en el allowlist sin haber sido aprobada.
   */
  it("el test de taint pasa con la implementación actual (sin spread)", () => {
    const tainted = makeInternalInitiative({
      sessionKey: "LEAK::sessionKey",
      turnId: "LEAK::turnId",
    });
    const extra = { token: "LEAK::token" };
    const taintedInitiative = { ...tainted, ...extra };

    const snap: InternalAutonomySnapshot = {
      asOf: 1,
      initiatives: [taintedInitiative as unknown as InternalInitiative],
      agenda: [],
      inbox: [],
      triggers: [],
      historyTruncated: false,
    };

    const pub = presentSnapshot(snap);
    const json = JSON.stringify(pub);
    assert.equal(json.includes("LEAK::"), false);
  });
});

describe("autonomy presenters — command result shape exacta", () => {
  it("CreateTriggerResult tiene las claves exactas", () => {
    const trigger = makeInternalTrigger();
    const controlResult: CreateTriggerResult = { trigger: trigger as unknown as Trigger, replayed: false };

    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentCreateTriggerResult(controlResult);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentCreateTriggerResult(controlResult);

    assert.deepEqual(Object.keys(servicePub).sort(), EXPECTED_CREATE_TRIGGER_RESULT_KEYS);
    assert.deepEqual(Object.keys(panelPub).sort(), EXPECTED_CREATE_TRIGGER_RESULT_KEYS);
  });

  it("RevokeTriggerResult tiene las claves exactas", () => {
    const trigger = makeInternalTrigger();

    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentRevokeTriggerResult(trigger as unknown as InternalTrigger);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentRevokeTriggerResult(trigger as unknown as InternalTrigger);

    assert.deepEqual(Object.keys(servicePub).sort(), EXPECTED_REVOKE_TRIGGER_RESULT_KEYS);
    assert.deepEqual(Object.keys(panelPub).sort(), EXPECTED_REVOKE_TRIGGER_RESULT_KEYS);
  });

  it("CancelInitiativeResult tiene las claves exactas", () => {
    const initiative = makeInternalInitiative();
    const controlResult: CancelInitiativeResult = {
      status: "cancelled",
      initiative: initiative as unknown as Initiative,
    };

    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentCancelInitiativeResult(controlResult);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentCancelInitiativeResult(controlResult);

    assert.deepEqual(Object.keys(servicePub).sort(), EXPECTED_CANCEL_INITIATIVE_RESULT_KEYS);
    assert.deepEqual(Object.keys(panelPub).sort(), EXPECTED_CANCEL_INITIATIVE_RESULT_KEYS);
  });

  it("CancelInitiativeResult acepta cancellation_requested", () => {
    const initiative = makeInternalInitiative();
    const controlResult: CancelInitiativeResult = {
      status: "cancellation_requested",
      initiative: initiative as unknown as Initiative,
    };

    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentCancelInitiativeResult(controlResult);
    assert.deepEqual(Object.keys(servicePub).sort(), EXPECTED_CANCEL_INITIATIVE_RESULT_KEYS);
    assert.equal(servicePub.status, "cancellation_requested");
  });

  it("RespondInitiativeResult tiene las claves exactas", () => {
    const initiative = makeInternalInitiative();
    const controlResult: RespondInitiativeResult = {
      initiative: initiative as unknown as Initiative,
      replayed: false,
    };

    const servicePub = SERVICE_AUTONOMY_PRESENTER.presentRespondInitiativeResult(controlResult);
    const panelPub = PANEL_AUTONOMY_PRESENTER.presentRespondInitiativeResult(controlResult);

    assert.deepEqual(Object.keys(servicePub).sort(), EXPECTED_RESPOND_INITIATIVE_RESULT_KEYS);
    assert.deepEqual(Object.keys(panelPub).sort(), EXPECTED_RESPOND_INITIATIVE_RESULT_KEYS);
  });
});

describe("autonomy presenters — command result taint", () => {
  function makeTaintedTrigger(): InternalTrigger {
    return taintSecrets(
      makeInternalTrigger(),
      TRIGGER_PRESENTER_READS,
      { telegramDeliveryId: "LEAK::telegramDeliveryId", token: "LEAK::token" },
    ) as unknown as InternalTrigger;
  }

  function makeTaintedInitiative(): InternalInitiative {
    return taintSecrets(
      makeInternalInitiative(),
      INITIATIVE_PRESENTER_READS,
      { telegramDeliveryId: "LEAK::telegramDeliveryId", token: "LEAK::token" },
    ) as unknown as InternalInitiative;
  }

  it("presentCreateTriggerResult no filtra secretos internos", () => {
    const result: CreateTriggerResult = {
      trigger: makeTaintedTrigger() as unknown as Trigger,
      replayed: false,
    };

    const serviceJson = JSON.stringify(SERVICE_AUTONOMY_PRESENTER.presentCreateTriggerResult(result));
    const panelJson = JSON.stringify(PANEL_AUTONOMY_PRESENTER.presentCreateTriggerResult(result));

    assert.equal(serviceJson.includes("LEAK::"), false,
      `service presentCreateTriggerResult filtró: ${serviceJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
    assert.equal(panelJson.includes("LEAK::"), false,
      `panel presentCreateTriggerResult filtró: ${panelJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
  });

  it("presentRevokeTriggerResult no filtra secretos internos", () => {
    const trigger = makeTaintedTrigger();

    const serviceJson = JSON.stringify(SERVICE_AUTONOMY_PRESENTER.presentRevokeTriggerResult(trigger));
    const panelJson = JSON.stringify(PANEL_AUTONOMY_PRESENTER.presentRevokeTriggerResult(trigger));

    assert.equal(serviceJson.includes("LEAK::"), false,
      `service presentRevokeTriggerResult filtró: ${serviceJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
    assert.equal(panelJson.includes("LEAK::"), false,
      `panel presentRevokeTriggerResult filtró: ${panelJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
  });

  it("presentCancelInitiativeResult no filtra secretos internos", () => {
    const initiative = makeTaintedInitiative();
    const result: CancelInitiativeResult = {
      status: "cancelled",
      initiative: initiative as unknown as Initiative,
    };

    const serviceJson = JSON.stringify(SERVICE_AUTONOMY_PRESENTER.presentCancelInitiativeResult(result));
    const panelJson = JSON.stringify(PANEL_AUTONOMY_PRESENTER.presentCancelInitiativeResult(result));

    assert.equal(serviceJson.includes("LEAK::"), false,
      `service presentCancelInitiativeResult filtró: ${serviceJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
    assert.equal(panelJson.includes("LEAK::"), false,
      `panel presentCancelInitiativeResult filtró: ${panelJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
  });

  it("presentRespondInitiativeResult no filtra secretos internos", () => {
    const initiative = makeTaintedInitiative();
    const result: RespondInitiativeResult = {
      initiative: initiative as unknown as Initiative,
      replayed: true,
    };

    const serviceJson = JSON.stringify(SERVICE_AUTONOMY_PRESENTER.presentRespondInitiativeResult(result));
    const panelJson = JSON.stringify(PANEL_AUTONOMY_PRESENTER.presentRespondInitiativeResult(result));

    assert.equal(serviceJson.includes("LEAK::"), false,
      `service presentRespondInitiativeResult filtró: ${serviceJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
    assert.equal(panelJson.includes("LEAK::"), false,
      `panel presentRespondInitiativeResult filtró: ${panelJson.match(/LEAK::\w+/g)?.join(", ") ?? ""}`);
  });
});

describe("autonomy presenters — mutación de resultado crudo debe caer", () => {
  /**
   * Demostración: si un día alguien sustituye el cuerpo de
   * `presentCancelInitiativeResult` por `return result as unknown as PublicX`,
   * el test de taint (y shape) debe fallar porque permitiría pasar el objeto
   * sin filtrar.
   *
   * Este test comprueba que la implementación actual NO tiene ese bypass.
   */
  it("presentCancelInitiativeResult no es un cast directo", () => {
    const initiative = taintSecrets(
      makeInternalInitiative(),
      INITIATIVE_PRESENTER_READS,
      { token: "LEAK::token" },
    );
    const result: CancelInitiativeResult = {
      status: "cancelled",
      initiative: initiative as unknown as Initiative,
    };

    const pub = SERVICE_AUTONOMY_PRESENTER.presentCancelInitiativeResult(result);
    const json = JSON.stringify(pub);

    // Las claves públicas correctas deben estar
    assert.ok(Object.keys(pub).includes("status"));
    assert.ok(Object.keys(pub).includes("initiative"));
    // Pero los secretos internos NO pueden aparecer
    assert.equal(json.includes("LEAK::"), false,
      "el resultado crudo se filtró: presenter debe ser allowlist, no cast");
    assert.equal(json.includes("sessionKey"), false);
    assert.equal(json.includes("chainDepth"), false);
  });
});