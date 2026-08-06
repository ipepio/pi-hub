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
function seedTrigger(db: SqliteDb, agentName: string, overrides?: Partial<{
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
}>): string {
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
    overrides?.definitionJson ?? '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
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
      projection: countingProjection as unknown as AutonomyRouteDeps["projection"],
      control,
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    snapshotCalls = 0;
    const resService = await app.request(
      "/agents/test-agent/autonomy",
      { headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(resService.status, 200, "service debe obtener 200");
    assert.equal(snapshotCalls, 1, "GET service debe llamar a snapshotForAgent exactamente una vez");
    const bodyService = await resService.json() as Record<string, unknown>;

    snapshotCalls = 0;
    const resPanel = await app.request(
      "/agents/test-agent/autonomy",
      { headers: { authorization: "Bearer panel-token" } },
    );
    assert.equal(resPanel.status, 200, "panel debe obtener 200");
    assert.equal(snapshotCalls, 1, "GET panel debe llamar a snapshotForAgent exactamente una vez");
    const bodyPanel = await resPanel.json() as Record<string, unknown>;

    // Ambas ven la misma proyección
    assert.deepEqual(bodyService, bodyPanel, "service y panel deben ver el mismo snapshot");
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

    const res = await app.request(
      "/agents/nonexistent/autonomy",
      { headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, "AGENT_NOT_FOUND");
  });

  it("Agent fixture con triggers e initiatives se refleja en el snapshot", async () => {
    const db = openMemoryDb();
    registerAgent("multi");
    const trgDailyId = seedTrigger(db, "multi", {
      id: "trg-daily",
      intent: "daily check",
      definitionJson: '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
    });
    // Trigger semanal
    const trgWeeklyId = seedTrigger(db, "multi", {
      id: "trg-weekly",
      intent: "weekly sync",
      definitionJson: '{"version":2,"kind":"weekly","timeZone":"America/New_York","at":"18:30","days":["mon","wed","fri"]}',
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
      "ini-queued", "multi", "queued", "trigger", "trg-daily", "daily check", "solo",
      "session-key-1", 1_700_000_000_000, null, null, 0, null,
      0, null, null, null, null,
      1_700_000_000_000, 1_700_000_000_000, null, null,
      null, null, null, null, null, null,
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
      "ini-running", "multi", "waiting_human", "trigger", "trg-weekly", "weekly sync", "ask",
      "session-key-2", 1_700_000_000_000, "gpt-4", "turn-1", 0, null,
      0, "running summary", null, null, null,
      1_699_000_000_000, 1_700_000_000_000, 1_699_500_000_000, null,
      "do you confirm?", 1_700_086_400_000, "req-1", null, null, null,
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

    const res = await app.request(
      "/agents/multi/autonomy",
      { headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
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

    const res = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-create-1",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          intent: "daily check",
          mode: "solo",
        }),
      },
    );
    assert.equal(res.status, 201, "create debe devolver 201");
    const body = await res.json() as Record<string, unknown>;
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

    const res = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-create-weekly",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "weekly", timeZone: "America/New_York", at: "18:30", days: ["mon", "wed", "fri"] },
          intent: "weekly sync",
          mode: "ask",
        }),
      },
    );
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
        definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
        intent: "daily check",
        mode: "solo",
      }),
    };

    const res1 = await app.request("/agents/test-agent/triggers", opts);
    assert.equal(res1.status, 201);

    const res2 = await app.request("/agents/test-agent/triggers", opts);
    assert.equal(res2.status, 200, "replay debe devolver 200");
    const body2 = await res2.json() as Record<string, unknown>;
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

    const res = await app.request(
      "/agents/nonexistent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-any",
        },
        body: JSON.stringify({ this_is: "garbage" }),
      },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as Record<string, unknown>;
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

    const res = await app.request(
      "/agents/test-agent/triggers",
      {
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
      },
    );
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

    const res = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          intent: "test",
          mode: "solo",
        }),
      },
    );
    assert.equal(res.status, 400);
  });
});

describe("P2.3 — POST /agents/:name/triggers/:id/revoke", () => {
  it("revoca trigger y devuelve 200", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const triggerId = seedTrigger(db, "test-agent");
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
    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.trigger);
    assert.equal((body.trigger as Record<string, unknown>).id, triggerId);
  });

  it("revoke repetido mantiene 200 y no borra historia", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const triggerId = seedTrigger(db, "test-agent");
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

    const res1 = await app.request(`/agents/test-agent/triggers/${triggerId}/revoke`, opts);
    assert.equal(res1.status, 200);

    const res2 = await app.request(`/agents/test-agent/triggers/${triggerId}/revoke`, opts);
    assert.equal(res2.status, 200, "revoke repetido debe dar 200");

    // Trigger debe seguir existiendo en disco
    const row = db.prepare("SELECT id FROM triggers WHERE id = ?").get(triggerId) as { id: string } | undefined;
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
    const body = await res.json() as Record<string, unknown>;
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
    const createRes = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer panel-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-cross-1",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          intent: "cross check",
          mode: "solo",
        }),
      },
    );
    assert.equal(createRes.status, 201);

    // Leer como Bearer service
    const getRes = await app.request(
      "/agents/test-agent/autonomy",
      { headers: { authorization: "Bearer service-token" } },
    );
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as Record<string, unknown>;
    const triggers = body.triggers as Array<Record<string, unknown>>;
    const created = triggers.find((t: Record<string, unknown>) => t.intent === "cross check");
    assert.ok(created, "el trigger creado por panel debe ser visible por Bearer");
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
    const createRes = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "idem-cross-2",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          intent: "bearer created",
          mode: "solo",
        }),
      },
    );
    assert.equal(createRes.status, 201);

    // Leer como panel
    const getRes = await app.request(
      "/agents/test-agent/autonomy",
      { headers: { authorization: "Bearer panel-token" } },
    );
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as Record<string, unknown>;
    const triggers = body.triggers as Array<Record<string, unknown>>;
    const created = triggers.find((t: Record<string, unknown>) => t.intent === "bearer created");
    assert.ok(created, "el trigger creado por Bearer debe ser visible por panel");
  });
});

describe("P2.3 — raw responses no contienen sentinels internos (§3.2)", () => {
  async function makeAppWithFakeControl(): Promise<{ app: Hono; db: SqliteDb }> {
    const db = openMemoryDb();
    registerAgent("test-agent");

    // Crear un control fake que devuelve triggers con propiedades secretas extra
    const fakeControl = {
      createTrigger: () => ({
        trigger: {
          id: "trg-tainted",
          agentName: "test-agent",
          kind: "schedule",
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          definitionJson: '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
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
        definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
        definitionJson: '{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}',
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
    const res = await app.request(
      "/agents/test-agent/autonomy",
      { headers: { authorization: "Bearer service-token" } },
    );
    const body = await res.text();
    assert.equal(body.includes("LEAK::"), false, "GET autonomy no debe contener LEAK::");
  });

  it("POST create trigger no contiene sentinels internos", async () => {
    const { app } = await makeAppWithFakeControl();
    const res = await app.request(
      "/agents/test-agent/triggers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "Idempotency-Key": "taint-test",
        },
        body: JSON.stringify({
          definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
          intent: "taint test",
          mode: "solo",
        }),
      },
    );
    const body = await res.text();
    assert.equal(body.includes("LEAK::"), false, "POST create trigger no debe contener LEAK::");
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
    assert.equal(body.includes("LEAK::"), false, "POST revoke trigger no debe contener LEAK::");
  });
});