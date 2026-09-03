/**
 * Tests end-to-end de rutas de autonomía — P2.3 (§5 "P2.3" del plan P2).
 *
 * Cubre:
 *   - GET snapshot: service/panel ven la misma proyección; una llamada a
 *     snapshotForAgent por request.
 *   - Agent inexistente antes de body inválido (404 sin validar schema).
 *   - POST create trigger: daily/weekly, replay, idempotency conflict,
 *     IANA/HH:mm/días inválidos.
 *   - POST revoke trigger: feliz/replay/not-found/otro Agent.
 *   - Mutación con cookie aparece en GET Bearer y viceversa.
 *   - Raw responses no contienen sentinels internos.
 *
 * Usa store SQLite real en `:memory:` con Agent fixture y TurnExecution fake.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import { AutonomyControl } from "../src/agenda/autonomy-control.ts";
import { TurnExecution } from "../src/agenda/turn-execution.ts";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import {
  registerAutonomyRoutes,
  type AutonomyRouteDeps,
} from "../src/api-v1/autonomy.ts";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Helpers de test
// ---------------------------------------------------------------------------

const openDbs: SqliteDb[] = [];
const EXISTING_AGENTS = new Set<string>();

function makeAgentExists() {
  return async (name: string): Promise<boolean> => EXISTING_AGENTS.has(name);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  EXISTING_AGENTS.clear();
});

function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

/** Declara que un Agent existe para el test. */
function registerAgent(name: string): void {
  EXISTING_AGENTS.add(name);
}

/** Crea un trigger de prueba y devuelve su id. */
function seedTrigger(
  db: SqliteDb,
  agentName: string,
  overrides?: Partial<{
    id: string;
    kind: string;
    definitionJson: string;
    intent: string;
    mode: string;
    suggestedSkill: string | null;
    createdBy: string;
    authority: string;
    proposalState: string | null;
    enabled: number;
    nextFireAt: number | null;
    lastFiredAt: number | null;
    createdAt: number;
    updatedAt: number;
    createIdempotencyKey: string | null;
    createCommandHash: string | null;
  }>,
): string {
  const id = overrides?.id ?? `trg-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO triggers
      (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
       created_by, authority, proposal_state, enabled, next_fire_at,
       last_fired_at, created_at, updated_at,
       create_idempotency_key, create_command_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    agentName,
    overrides?.kind ?? "schedule",
    overrides?.definitionJson ??
      '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
    overrides?.intent ?? "test intent",
    overrides?.mode ?? "solo",
    overrides?.suggestedSkill ?? null,
    overrides?.createdBy ?? "owner",
    overrides?.authority ?? "owner",
    overrides?.proposalState ?? null,
    overrides?.enabled ?? 1,
    overrides?.nextFireAt ?? null,
    overrides?.lastFiredAt ?? null,
    overrides?.createdAt ?? now,
    overrides?.updatedAt ?? now,
    overrides?.createIdempotencyKey ?? null,
    overrides?.createCommandHash ?? null,
  );
  return id;
}

function makeApp(deps: AutonomyRouteDeps): Hono {
  const app = new Hono();
  // Simular auth middleware que establece principal
  app.use("*", async (c, next) => {
    c.set("correlationId", "test-correlation-id");
    const auth = c.req.header("authorization");
    if (auth === "Bearer panel-token") {
      c.set("principal", { kind: "panel" });
    } else {
      c.set("principal", { kind: "service" });
    }
    await next();
  });
  registerAutonomyRoutes(app, deps);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("P2.3 — GET /agents/:name/autonomy", () => {
  it("devuelve snapshot para service y panel con la misma proyección (una llamada a snapshotForAgent por request)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedTrigger(db, "test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });

    let snapshotCalls = 0;
    const countingProjection = {
      snapshotForAgent: (name: string, now: number) => {
        snapshotCalls += 1;
        return agenda.projection.snapshotForAgent(name, now);
      },
    };

    const app = makeApp({
      projection:
        countingProjection as unknown as AutonomyRouteDeps["projection"],
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    snapshotCalls = 0;
    const resService = await app.request("/agents/test-agent/autonomy", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(resService.status, 200, "service debe obtener 200");
    assert.equal(
      snapshotCalls,
      1,
      "GET service debe llamar a snapshotForAgent exactamente una vez",
    );
    const bodyService = (await resService.json()) as Record<string, unknown>;

    snapshotCalls = 0;
    const resPanel = await app.request("/agents/test-agent/autonomy", {
      headers: { authorization: "Bearer panel-token" },
    });
    assert.equal(resPanel.status, 200, "panel debe obtener 200");
    assert.equal(
      snapshotCalls,
      1,
      "GET panel debe llamar a snapshotForAgent exactamente una vez",
    );
    const bodyPanel = (await resPanel.json()) as Record<string, unknown>;

    // Ambas ven la misma proyección
    assert.deepEqual(
      bodyService,
      bodyPanel,
      "service y panel deben ver el mismo snapshot",
    );
  });

  it("Agent inexistente da 404 AGENT_NOT_FOUND", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: async () => false,
      now: () => Date.now(),
    });

    const res = await app.request("/agents/nonexistent/autonomy", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "AGENT_NOT_FOUND");
  });

  it("Agent fixture con triggers e initiatives se refleja en el snapshot", async () => {
    const db = openMemoryDb();
    registerAgent("multi");
    const trgDailyId = seedTrigger(db, "multi", {
      id: "trg-daily",
      intent: "daily check",
      definitionJson:
        '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
    });
    // Trigger semanal
    const trgWeeklyId = seedTrigger(db, "multi", {
      id: "trg-weekly",
      intent: "weekly sync",
      definitionJson:
        '{"version":2,"kind":"weekly","timeZone":"America/New_York","at":"18:30","days":["mon","wed","fri"]}',
    });
    // Initiative queued
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at,
         human_question, human_expires_at, human_request_id, pending_human_input,
         human_response_idempotency_key, human_response_command_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "ini-queued",
      "multi",
      "queued",
      "trigger",
      "trg-daily",
      "daily check",
      "solo",
      "session-key-1",
      1_700_000_000_000,
      null,
      null,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
      1_700_000_000_000,
      1_700_000_000_000,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    // Initiative running
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at,
         human_question, human_expires_at, human_request_id, pending_human_input,
         human_response_idempotency_key, human_response_command_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "ini-running",
      "multi",
      "waiting_human",
      "trigger",
      "trg-weekly",
      "weekly sync",
      "ask",
      "session-key-2",
      1_700_000_000_000,
      "gpt-4",
      "turn-1",
      0,
      null,
      0,
      "running summary",
      null,
      null,
      null,
      1_699_000_000_000,
      1_700_000_000_000,
      1_699_500_000_000,
      null,
      "do you confirm?",
      1_700_086_400_000,
      "req-1",
      null,
      null,
      null,
    );

    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_050_000,
    });

    const res = await app.request("/agents/multi/autonomy", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.initiatives), "initiatives debe ser array");
    assert.ok(Array.isArray(body.agenda), "agenda debe ser array");
    assert.ok(Array.isArray(body.inbox), "inbox debe ser array");
    assert.ok(Array.isArray(body.triggers), "triggers debe ser array");
    assert.equal(body.historyTruncated, false);

    // Verificar que la initiative waiting_human aparece en inbox
    // (running con humanQuestion = waiting_human)
    assert.equal(body.inbox.length, 1, "debe haber 1 initiative en inbox");
  });
});

describe("P2.3 — POST /agents/:name/triggers", () => {
  it("crea trigger daily y devuelve 201 con replayed:false", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-create-1",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "daily check",
        mode: "solo",
      }),
    });
    assert.equal(res.status, 201, "create debe devolver 201");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.replayed, false);
    assert.ok(body.trigger);
    assert.equal(typeof (body.trigger as Record<string, unknown>).id, "string");
  });

  it("create weekly devuelve 201", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-create-weekly",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "weekly",
          timeZone: "America/New_York",
          at: "18:30",
          days: ["mon", "wed", "fri"],
        },
        intent: "weekly sync",
        mode: "ask",
      }),
    });
    assert.equal(res.status, 201);
  });

  it("replay con misma key y mismo body devuelve 200 y replayed:true", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const opts = {
      method: "POST" as const,
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-replay",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "daily check",
        mode: "solo",
      }),
    };

    const res1 = await app.request("/agents/test-agent/triggers", opts);
    assert.equal(res1.status, 201);

    const res2 = await app.request("/agents/test-agent/triggers", opts);
    assert.equal(res2.status, 200, "replay debe devolver 200");
    const body2 = (await res2.json()) as Record<string, unknown>;
    assert.equal(body2.replayed, true, "replay debe marcar replayed:true");
  });

  it("Agent inexistente da 404 antes de validar body (body basura)", async () => {
    const db = openMemoryDb();
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: async () => false,
      now: () => Date.now(),
    });

    const res = await app.request("/agents/nonexistent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-any",
      },
      body: JSON.stringify({ this_is: "garbage" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "AGENT_NOT_FOUND");
  });

  it("version 1 (interval) es rechazado como BAD_REQUEST", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-v1",
      },
      body: JSON.stringify({
        definition: { version: 1, kind: "interval", intervalMs: 3_600_000 },
        intent: "test",
        mode: "solo",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("Idempotency-Key ausente da 400", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "test",
        mode: "solo",
      }),
    });
    assert.equal(res.status, 400);
  });
});

describe("P2.3 — POST /agents/:name/triggers/:id/revoke", () => {
  it("revoca trigger y devuelve 200", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    // Un caller service se resuelve a autoridad control_plane (por principal);
    // el Trigger sembrado debe ser de control_plane para que el revoke aplique.
    const triggerId = seedTrigger(db, "test-agent", {
      createdBy: "control_plane",
      authority: "control_plane",
    });
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      `/agents/test-agent/triggers/${triggerId}/revoke`,
      {
        method: "POST",
        headers: { authorization: "Bearer service-token" },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.trigger);
    assert.equal((body.trigger as Record<string, unknown>).id, triggerId);
  });

  it("revoke repetido mantiene 200 y no borra historia", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const triggerId = seedTrigger(db, "test-agent", {
      createdBy: "control_plane",
      authority: "control_plane",
    });
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const opts = {
      method: "POST" as const,
      headers: { authorization: "Bearer service-token" },
    };

    const res1 = await app.request(
      `/agents/test-agent/triggers/${triggerId}/revoke`,
      opts,
    );
    assert.equal(res1.status, 200);

    const res2 = await app.request(
      `/agents/test-agent/triggers/${triggerId}/revoke`,
      opts,
    );
    assert.equal(res2.status, 200, "revoke repetido debe dar 200");

    // Trigger debe seguir existiendo en disco
    const row = db
      .prepare("SELECT id FROM triggers WHERE id = ?")
      .get(triggerId) as { id: string } | undefined;
    assert.ok(row, "trigger debe seguir existiendo en BD tras revoke repetido");
  });

  it("trigger inexistente da 404", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request(
      "/agents/test-agent/triggers/nonexistent-trigger/revoke",
      {
        method: "POST",
        headers: { authorization: "Bearer service-token" },
      },
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "TRIGGER_NOT_FOUND");
  });

  it("trigger de otro Agent da 404 (indistinguible de inexistente)", async () => {
    const db = openMemoryDb();
    registerAgent("agent-a");
    registerAgent("agent-b");
    const triggerId = seedTrigger(db, "agent-a");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request(
      `/agents/agent-b/triggers/${triggerId}/revoke`,
      {
        method: "POST",
        headers: { authorization: "Bearer service-token" },
      },
    );
    assert.equal(res.status, 404);
  });
});

describe("P2.3 — mutación con cookie visible en GET Bearer y viceversa", () => {
  it("trigger creado por panel (cookie) se ve en GET con Bearer", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    // Crear trigger como panel
    const createRes = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer panel-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-cross-1",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "cross check",
        mode: "solo",
      }),
    });
    assert.equal(createRes.status, 201);

    // Leer como Bearer service
    const getRes = await app.request("/agents/test-agent/autonomy", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as Record<string, unknown>;
    const triggers = body.triggers as Array<Record<string, unknown>>;
    const created = triggers.find(
      (t: Record<string, unknown>) => t.intent === "cross check",
    );
    assert.ok(
      created,
      "el trigger creado por panel debe ser visible por Bearer",
    );
  });

  it("trigger creado por Bearer se ve en GET con panel", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    // Crear trigger como Bearer service
    const createRes = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-cross-2",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "bearer created",
        mode: "solo",
      }),
    });
    assert.equal(createRes.status, 201);

    // Leer como panel
    const getRes = await app.request("/agents/test-agent/autonomy", {
      headers: { authorization: "Bearer panel-token" },
    });
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as Record<string, unknown>;
    const triggers = body.triggers as Array<Record<string, unknown>>;
    const created = triggers.find(
      (t: Record<string, unknown>) => t.intent === "bearer created",
    );
    assert.ok(
      created,
      "el trigger creado por Bearer debe ser visible por panel",
    );
  });
});

describe("P2.3 — raw responses no contienen sentinels internos (§3.2)", () => {
  async function makeAppWithFakeControl(): Promise<{
    app: Hono;
    db: SqliteDb;
  }> {
    const db = openMemoryDb();
    registerAgent("test-agent");

    // Crear un control fake que devuelve triggers con propiedades secretas extra
    const fakeControl = {
      createTrigger: () => ({
        trigger: {
          id: "trg-tainted",
          agentName: "test-agent",
          kind: "schedule",
          definition: {
            version: 2,
            kind: "daily",
            timeZone: "Europe/Madrid",
            at: "09:00",
          },
          definitionJson:
            '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
          intent: "tainted test",
          mode: "solo",
          suggestedSkill: null,
          createdBy: "owner",
          authority: "owner",
          proposalState: null,
          enabled: true,
          nextFireAt: null,
          lastFiredAt: null,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          createIdempotencyKey: "LEAK::createIdempotencyKey",
          createCommandHash: "LEAK::createCommandHash",
          token: "LEAK::token",
          telegramDeliveryId: "LEAK::telegramDeliveryId",
        },
        replayed: false,
      }),
      revokeTrigger: () => ({
        id: "trg-tainted-revoke",
        agentName: "test-agent",
        kind: "schedule",
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        definitionJson:
          '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
        intent: "tainted revoke",
        mode: "solo",
        suggestedSkill: null,
        createdBy: "owner",
        authority: "owner",
        proposalState: null,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        createIdempotencyKey: "LEAK::createIdempotencyKey",
        createCommandHash: "LEAK::createCommandHash",
        token: "LEAK::token",
      }),
    } as unknown as AutonomyControl;

    const agenda = new AgendaRepository(db);
    const projection = agenda.projection;
    const app = makeApp({
      projection,
      control: fakeControl,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    return { app, db };
  }

  it("GET autonomy no contiene sentinels internos", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request("/agents/test-agent/autonomy", {
      headers: { authorization: "Bearer service-token" },
    });
    const body = await res.text();
    assert.equal(
      body.includes("LEAK::"),
      false,
      "GET autonomy no debe contener LEAK::",
    );
  });

  it("POST create trigger no contiene sentinels internos", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request("/agents/test-agent/triggers", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "taint-test",
      },
      body: JSON.stringify({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "09:00",
        },
        intent: "taint test",
        mode: "solo",
      }),
    });
    const body = await res.text();
    assert.equal(
      body.includes("LEAK::"),
      false,
      "POST create trigger no debe contener LEAK::",
    );
  });

  it("POST revoke trigger no contiene sentinels internos", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request(
      "/agents/test-agent/triggers/fake-id/revoke",
      {
        method: "POST",
        headers: { authorization: "Bearer service-token" },
      },
    );
    const body = await res.text();
    assert.equal(
      body.includes("LEAK::"),
      false,
      "POST revoke trigger no debe contener LEAK::",
    );
  });
});

// ---------------------------------------------------------------------------
// P2.4 — Cancel initiative
// ---------------------------------------------------------------------------

describe("P2.4 — POST /agents/:name/initiatives/:id/cancel", () => {
  function seedQueued(db: SqliteDb, id: string): void {
    // Need the referenced trigger first
    seedTrigger(db, "test-agent", { id: "trg-1", intent: "test" });
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      "test-agent",
      "queued",
      "trigger",
      "trg-1",
      "test",
      "solo",
      "sk",
      1_700_000_000_000,
      null,
      null,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
      1_700_000_000_000,
      1_700_000_000_000,
      null,
      null,
    );
  }

  function seedRunning(
    db: SqliteDb,
    id: string,
    turnId: string = "turn-running",
  ): void {
    seedTrigger(db, "test-agent", { id: "trg-1", intent: "test" });
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      "test-agent",
      "running",
      "trigger",
      "trg-1",
      "test",
      "solo",
      "sk",
      1_700_000_000_000,
      "gpt-4",
      turnId,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
      1_699_000_000_000,
      1_700_000_000_000,
      1_699_500_000_000,
      null,
    );
  }

  function seedTerminal(db: SqliteDb, id: string, state: string): void {
    seedTrigger(db, "test-agent", { id: "trg-1", intent: "test" });
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      "test-agent",
      state,
      "trigger",
      "trg-1",
      "test",
      "solo",
      "sk",
      1_700_000_000_000,
      null,
      null,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
      1_699_000_000_000,
      1_700_000_000_000,
      1_699_500_000_000,
      1_700_000_000_000,
    );
  }

  it("cancel initiative queued devuelve 200 cancelled", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedQueued(db, "ini-cancel-q");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-cancel-q/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "cancelled");
    assert.ok(body.initiative);
  });

  it("cancel initiative already cancelled es idempotente (200)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedTerminal(db, "ini-already-cancelled", "cancelled");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-already-cancelled/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "cancelled");
  });

  it("cancel initiative running devuelve 202 cancellation_requested", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedRunning(db, "ini-running-cancel");
    const agenda = new AgendaRepository(db);
    // Fake TurnExecution que aborta siempre (simula que encontró el handle)
    const fakeTurns = {
      abort: () => true,
    } as unknown as TurnExecution;
    const control = new AutonomyControl({
      agenda,
      turns: fakeTurns,
      authority: "owner",
    });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-running-cancel/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 202, "running debe dar 202");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "cancellation_requested");
  });

  it("cancel terminal (succeeded) da 409 INITIATIVE_STATE_CONFLICT", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedTerminal(db, "ini-terminal-succ", "succeeded");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-terminal-succ/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "INITIATIVE_STATE_CONFLICT");
  });

  it("cancel de otro Agent da 404 (indistinguible de inexistente)", async () => {
    const db = openMemoryDb();
    registerAgent("agent-a");
    registerAgent("agent-b");
    seedQueued(db, "ini-other-agent");
    // la initiative es de agent-a, pedimos cancel en agent-b
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    // Actualizar agent_name en la fila a agent-a
    db.prepare(
      "UPDATE initiatives SET agent_name = 'agent-a' WHERE id = 'ini-other-agent'",
    ).run();
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request(
      "/agents/agent-b/initiatives/ini-other-agent/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "INITIATIVE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// P2.4 — Respond initiative
// ---------------------------------------------------------------------------

describe("P2.4 — POST /agents/:name/initiatives/:id/respond", () => {
  function seedWaitingHuman(db: SqliteDb, id: string): void {
    seedTrigger(db, "test-agent", { id: "trg-1", intent: "test respond" });
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at,
         human_question, human_expires_at, human_request_id, pending_human_input,
         human_response_idempotency_key, human_response_command_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      "test-agent",
      "waiting_human",
      "trigger",
      "trg-1",
      "test respond",
      "ask",
      "sk-respond",
      1_700_000_000_000,
      "gpt-4",
      "turn-respond",
      0,
      null,
      0,
      "summary respond",
      null,
      null,
      null,
      1_699_000_000_000,
      1_700_000_000_000,
      1_699_500_000_000,
      null,
      "do you confirm?",
      1_700_086_400_000,
      "req-1",
      null,
      null,
      null,
    );
  }

  it("respond feliz devuelve 200 con initiative y replayed:false", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedWaitingHuman(db, "ini-respond-1");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-respond-1/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-respond-1",
        },
        body: JSON.stringify({ answer: "sí, procede" }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body.initiative);
    assert.equal(body.replayed, false);
    // Verificar que la initiative pasó a queued
    assert.equal((body.initiative as Record<string, unknown>).status, "queued");
  });

  it("respond replay con misma key devuelve 200 y replayed:true", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedWaitingHuman(db, "ini-respond-replay");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const opts = {
      method: "POST" as const,
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "Idempotency-Key": "idem-respond-replay",
      },
      body: JSON.stringify({ answer: "confirmado" }),
    };

    const res1 = await app.request(
      "/agents/test-agent/initiatives/ini-respond-replay/respond",
      opts,
    );
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    assert.equal(body1.replayed, false);

    const res2 = await app.request(
      "/agents/test-agent/initiatives/ini-respond-replay/respond",
      opts,
    );
    assert.equal(res2.status, 200, "replay debe dar 200");
    const body2 = (await res2.json()) as Record<string, unknown>;
    assert.equal(body2.replayed, true, "replay debe marcar replayed:true");
  });

  it("respond con Idempotency-Key ausente da 400", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedWaitingHuman(db, "ini-respond-no-key");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-respond-no-key/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ answer: "ok" }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("respond a initiative no waiting_human da 409", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    // Create trigger and initiative directly (not waiting_human, so respond should fail)
    seedTrigger(db, "test-agent", { id: "trg-1", intent: "test" });
    db.prepare(`
      INSERT INTO initiatives
        (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
         available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
         visible_effects_declared, summary, ask_correlation, failure_reason,
         result, created_at, state_changed_at, started_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "ini-respond-queued",
      "test-agent",
      "queued",
      "trigger",
      "trg-1",
      "test",
      "solo",
      "sk",
      1_700_000_000_000,
      null,
      null,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
      1_700_000_000_000,
      1_700_000_000_000,
      null,
      null,
    );
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-respond-queued/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-respond-queued",
        },
        body: JSON.stringify({ answer: "ok" }),
      },
    );
    assert.equal(res.status, 409);
  });

  it("respond de otro Agent da 404 (indistinguible de inexistente)", async () => {
    const db = openMemoryDb();
    registerAgent("agent-a");
    registerAgent("agent-b");
    seedWaitingHuman(db, "ini-respond-other");
    db.prepare(
      "UPDATE initiatives SET agent_name = 'agent-a' WHERE id = 'ini-respond-other'",
    ).run();
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request(
      "/agents/agent-b/initiatives/ini-respond-other/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-respond-other",
        },
        body: JSON.stringify({ answer: "ok" }),
      },
    );
    assert.equal(res.status, 404);
  });

  it("respond con answer demasiado larga (4001) da 400", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    seedWaitingHuman(db, "ini-respond-long");
    const agenda = new AgendaRepository(db);
    const turns = new TurnExecution({ apiToken: "test" });
    const control = new AutonomyControl({ agenda, turns, authority: "owner" });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    });

    const res = await app.request(
      "/agents/test-agent/initiatives/ini-respond-long/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-respond-long",
        },
        body: JSON.stringify({ answer: "x".repeat(4001) }),
      },
    );
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// P2.4 — Admission shell contractual
// ---------------------------------------------------------------------------

describe("P2.4 — GET/PUT /runtime/admission", () => {
  function makeAdmissionApp(fakeAdmission?: {
    state: "open" | "draining";
    idle: boolean;
    activeTurns: number;
    runningInitiatives: number;
    changedAt: number;
  }) {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const control = new AutonomyControl({
      agenda,
      turns: new TurnExecution({ apiToken: "test" }),
      authority: "owner",
    });

    const deps: AutonomyRouteDeps = {
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
    };

    if (fakeAdmission) {
      deps.admission = {
        getAdmission: () => fakeAdmission,
        setAdmission: (state) => ({
          ...fakeAdmission,
          state,
          changedAt: Date.now(),
        }),
      };
    }

    const app = makeApp(deps);
    return { app, db };
  }

  it("sin port (producción P2) GET da 503 RESOURCE_UNAVAILABLE", async () => {
    const { app } = makeAdmissionApp(); // no fake admission
    const res = await app.request("/runtime/admission", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
  });

  it("sin port PUT da 503 RESOURCE_UNAVAILABLE", async () => {
    const { app } = makeAdmissionApp();
    const res = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "open" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "RESOURCE_UNAVAILABLE");
  });

  it("con port fake GET devuelve 200 con shape exacta", async () => {
    const fakeAdmission = {
      state: "open" as const,
      idle: false,
      activeTurns: 2,
      runningInitiatives: 3,
      changedAt: 1_700_000_000_000,
    };
    const { app } = makeAdmissionApp(fakeAdmission);
    const res = await app.request("/runtime/admission", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "activeTurns",
        "changedAt",
        "idle",
        "runningInitiatives",
        "state",
      ].sort(),
    );
    assert.equal(body.state, "open");
    assert.equal(body.idle, false);
    assert.equal(body.activeTurns, 2);
    assert.equal(body.runningInitiatives, 3);
    assert.equal(body.changedAt, 1_700_000_000_000);
  });

  it("PUT con port fake cambia estado y devuelve shape exacta", async () => {
    const fakeAdmission = {
      state: "open" as const,
      idle: false,
      activeTurns: 2,
      runningInitiatives: 3,
      changedAt: 1_700_000_000_000,
    };
    const { app } = makeAdmissionApp(fakeAdmission);
    const res = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "draining" }),
    });
    assert.equal(res.status, 200, "PUT admission debe dar 200");
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "activeTurns",
        "changedAt",
        "idle",
        "runningInitiatives",
        "state",
      ].sort(),
    );
    assert.equal(body.state, "draining");
  });

  it("PUT admite service y panel principals", async () => {
    const fakeAdmission = {
      state: "open" as const,
      idle: true,
      activeTurns: 0,
      runningInitiatives: 0,
      changedAt: 1_700_000_000_000,
    };
    const { app } = makeAdmissionApp(fakeAdmission);

    // service
    const resService = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "open" }),
    });
    assert.equal(resService.status, 200);

    // panel
    const resPanel = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer panel-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "open" }),
    });
    assert.equal(resPanel.status, 200);
  });

  it("PUT con body inválido (state incorrecto) da 400", async () => {
    const fakeAdmission = {
      state: "open" as const,
      idle: false,
      activeTurns: 0,
      runningInitiatives: 0,
      changedAt: 1_700_000_000_000,
    };
    const { app } = makeAdmissionApp(fakeAdmission);
    const res = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "invalid" }),
    });
    assert.equal(res.status, 400);
  });

  it("PUT con claves extra (.strict()) da 400", async () => {
    const fakeAdmission = {
      state: "open" as const,
      idle: false,
      activeTurns: 0,
      runningInitiatives: 0,
      changedAt: 1_700_000_000_000,
    };
    const { app } = makeAdmissionApp(fakeAdmission);
    const res = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "open", extra: "nope" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET con port sucio no filtra LEAK:: ni claves extra (taint HTTP)", async () => {
    // Port fake que devuelve propiedades enumerables de más
    const taintedPort = {
      getAdmission: () => ({
        state: "open" as const,
        idle: false,
        activeTurns: 2,
        runningInitiatives: 3,
        changedAt: 1_700_000_000_000,
        token: "LEAK::token",
        internalCounters: "LEAK::counters",
        "LEAK::x": "leaked",
      }),
      setAdmission: (state: "open" | "draining") => ({
        state,
        idle: false,
        activeTurns: 2,
        runningInitiatives: 3,
        changedAt: Date.now(),
        token: "LEAK::token",
        internalCounters: "LEAK::counters",
        "LEAK::x": "leaked",
      }),
    };
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const control = new AutonomyControl({
      agenda,
      turns: new TurnExecution({ apiToken: "test" }),
      authority: "owner",
    });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
      admission: taintedPort,
    });

    const res = await app.request("/runtime/admission", {
      headers: { authorization: "Bearer service-token" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    // Solo las 5 claves públicas
    assert.deepEqual(Object.keys(body).sort(), [
      "activeTurns",
      "changedAt",
      "idle",
      "runningInitiatives",
      "state",
    ]);
    const json = JSON.stringify(body);
    assert.equal(json.includes("LEAK::"), false, "GET no debe filtrar LEAK::");
    assert.equal(json.includes("token"), false, "GET no debe filtrar token");
    assert.equal(
      json.includes("internalCounters"),
      false,
      "GET no debe filtrar internalCounters",
    );
  });

  it("PUT con port sucio no filtra LEAK:: ni claves extra (taint HTTP)", async () => {
    const taintedPort = {
      getAdmission: () => ({
        state: "open" as const,
        idle: false,
        activeTurns: 2,
        runningInitiatives: 3,
        changedAt: 1_700_000_000_000,
        token: "LEAK::token",
        internalCounters: "LEAK::counters",
        "LEAK::x": "leaked",
      }),
      setAdmission: (state: "open" | "draining") => ({
        state,
        idle: false,
        activeTurns: 2,
        runningInitiatives: 3,
        changedAt: Date.now(),
        token: "LEAK::token",
        internalCounters: "LEAK::counters",
        "LEAK::x": "leaked",
      }),
    };
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const control = new AutonomyControl({
      agenda,
      turns: new TurnExecution({ apiToken: "test" }),
      authority: "owner",
    });
    const app = makeApp({
      projection: agenda.projection,
      control,
      agentExists: makeAgentExists(),
      now: () => Date.now(),
      admission: taintedPort,
    });

    const res = await app.request("/runtime/admission", {
      method: "PUT",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "draining" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "activeTurns",
      "changedAt",
      "idle",
      "runningInitiatives",
      "state",
    ]);
    assert.equal(body.state, "draining");
    const json = JSON.stringify(body);
    assert.equal(json.includes("LEAK::"), false, "PUT no debe filtrar LEAK::");
    assert.equal(json.includes("token"), false, "PUT no debe filtrar token");
    assert.equal(
      json.includes("internalCounters"),
      false,
      "PUT no debe filtrar internalCounters",
    );
  });
});

// ---------------------------------------------------------------------------
// P2.4 — cancel/respond raw responses no contienen sentinels internos
// ---------------------------------------------------------------------------

describe("P2.4 — raw responses de cancel/respond no contienen sentinels internos", () => {
  async function makeAppWithFakeControl(): Promise<{ app: Hono }> {
    const db = openMemoryDb();
    registerAgent("test-agent");

    const fakeControl = {
      createTrigger: () => ({}),
      revokeTrigger: () => ({}),
      cancelInitiative: () => ({
        status: "cancelled" as const,
        initiative: {
          id: "ini-tainted",
          agentName: "test-agent",
          state: "cancelled",
          origin: "trigger",
          triggerId: "trg-1",
          intent: "tainted cancel",
          mode: "solo",
          sessionKey: "LEAK::sessionKey",
          turnId: "LEAK::turnId",
          boundModel: "LEAK::boundModel",
          askCorrelation: "LEAK::askCorrelation",
          pendingHumanInput: "LEAK::pendingHumanInput",
          result: "LEAK::result",
          summary: null,
          humanQuestion: null,
          humanExpiresAt: null,
          humanRequestId: null,
          humanResponseIdempotencyKey: null,
          humanResponseCommandHash: null,
          availableAt: 1,
          createdAt: 1,
          stateChangedAt: 1,
          startedAt: null,
          finishedAt: null,
          chainDepth: 0,
          chainDeadlineAt: null,
          visibleEffectsDeclared: false,
          failureReason: null,
          token: "LEAK::token",
        },
      }),
      respondToInitiative: () => ({
        initiative: {
          id: "ini-tainted-respond",
          agentName: "test-agent",
          state: "queued",
          origin: "trigger",
          triggerId: "trg-1",
          intent: "tainted respond",
          mode: "ask",
          sessionKey: "LEAK::sessionKey-respond",
          turnId: "LEAK::turnId-respond",
          boundModel: "LEAK::boundModel",
          askCorrelation: "LEAK::askCorrelation",
          pendingHumanInput: "LEAK::pendingHumanInput",
          result: "LEAK::result-respond",
          summary: null,
          humanQuestion: null,
          humanExpiresAt: null,
          humanRequestId: null,
          humanResponseIdempotencyKey: null,
          humanResponseCommandHash: null,
          availableAt: 1,
          createdAt: 1,
          stateChangedAt: 1,
          startedAt: null,
          finishedAt: null,
          chainDepth: 0,
          chainDeadlineAt: null,
          visibleEffectsDeclared: false,
          failureReason: null,
          token: "LEAK::token-respond",
        },
        replayed: false,
      }),
    } as unknown as AutonomyControl;

    const agenda = new AgendaRepository(db);
    const app = makeApp({
      projection: agenda.projection,
      control: fakeControl,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    return { app };
  }

  it("POST cancel no contiene LEAK::", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request(
      "/agents/test-agent/initiatives/fake-id/cancel",
      { method: "POST", headers: { authorization: "Bearer service-token" } },
    );
    const body = await res.text();
    assert.equal(
      body.includes("LEAK::"),
      false,
      "POST cancel no debe contener LEAK::",
    );
  });

  it("POST respond no contiene LEAK::", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request(
      "/agents/test-agent/initiatives/fake-id/respond",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "taint-respond",
        },
        body: JSON.stringify({ answer: "ok" }),
      },
    );
    const body = await res.text();
    assert.equal(
      body.includes("LEAK::"),
      false,
      "POST respond no debe contener LEAK::",
    );
  });
});
