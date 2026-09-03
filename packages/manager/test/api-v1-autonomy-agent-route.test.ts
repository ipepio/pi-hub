// P2.4a (pihub step 2a) — resolución de la autoridad efectiva del Trigger por
// PRINCIPAL autenticado en las rutas `/api/v1` de autonomía:
//   - sesión de panel (cookie)            → owner
//   - Bearer de servicio solo             → control_plane
//   - Bearer de servicio + X-Pihub-Principal: runner → agent
//
// La capa de ruta deriva la autoridad por request (que en `/api/v1/auth.ts` ya
// validó una credencial real antes de llegar aquí) y la inyecta a AutonomyControl,
// con la política del agente (autonomy.triggers, aditivo) para el gate de `agent`.

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
import { AUTH_COOKIE } from "@pihub/shared";
import { DomainError } from "../src/agenda/errors.ts";

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

function registerAgent(name: string): void {
  EXISTING_AGENTS.add(name);
}

/** Middleware que simula `/api/v1/auth.ts`: cookie → panel, Bearer → service. */
function makeApp(deps: AutonomyRouteDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("correlationId", "test-correlation-id");
    const cookie = c.req.header("cookie") ?? "";
    const authorization = c.req.header("authorization");
    if (cookie.includes(`${AUTH_COOKIE}=panel-token`)) {
      c.set("principal", { kind: "panel" });
    } else if (authorization === "Bearer token") {
      c.set("principal", { kind: "service" });
    } else {
      c.set("principal", { kind: "service" });
    }
    await next();
  });
  registerAutonomyRoutes(app, deps);
  return app;
}

/** Criar un trigger y devolver el body (createdBy/authority). */
async function createTrigger(
  app: Hono,
  agentName: string,
  headers: Record<string, string>,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Un Runner que se declara como tal (PIHUB_PRINCIPAL_HEADER) debe llevar
  // además el X-Pihub-Agent ligado al Agent de la ruta (R1-008); lo inyectamos
  // aquí por comodidad en los casos de principal runner.
  if (headers["x-pihub-principal"] === "runner") {
    headers["x-pihub-agent"] = agentName;
  }
  const res = await app.request(`/agents/${agentName}/triggers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...headers,
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
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function makeControl(db: SqliteDb): AutonomyControl {
  return new AutonomyControl({
    agenda: new AgendaRepository(db),
    turns: new TurnExecution({ apiToken: "test" }),
    authority: "owner", // DEFAULT del proceso; la ruta lo sobreescribe por request
  });
}

describe("P2.4a — autoridad efectiva por principal (pihub step 2a)", () => {
  it("cookie de panel → create con created_by/authority owner", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { cookie: `${AUTH_COOKIE}=panel-token` },
      "k-cookie-owner",
    );
    assert.equal(status, 201);
    const trigger = body.trigger as Record<string, unknown>;
    assert.equal(trigger.createdBy, "owner");
    assert.equal(trigger.authority, "owner");
  });

  it("Bearer de servicio solo → create con created_by/authority control_plane", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token" },
      "k-bearer-plane",
    );
    assert.equal(status, 201);
    const trigger = body.trigger as Record<string, unknown>;
    assert.equal(trigger.createdBy, "control_plane");
    assert.equal(trigger.authority, "control_plane");
  });

  it("Bearer de servicio + X-Pihub-Principal: runner → create con created_by/authority agent", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-bearer-agent",
    );
    assert.equal(status, 201);
    const trigger = body.trigger as Record<string, unknown>;
    assert.equal(trigger.createdBy, "agent");
    assert.equal(trigger.authority, "agent");
    assert.equal(
      trigger.proposalState,
      null,
      "Trigger agent nace activo (ADR 0035)",
    );
  });

  it("autoridad agent con política deshabilitada → 403 AUTONOMY_DISABLED", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      // Política cerrada: el Runner no puede crear triggers aquí.
      readAgentTriggerPolicy: async () => ({ enabled: false }),
    });

    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-agent-disabled",
    );
    assert.equal(status, 403);
    assert.equal(body.code, "AUTONOMY_DISABLED");
  });

  it("autoridad agent con límite activo alcanzado → 409 TRIGGER_LIMIT_REACHED", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    // Siembra un trigger activo de agente (count=1) con max=1.
    const agenda = new AgendaRepository(db);
    db.prepare(
      `INSERT INTO triggers
         (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
          created_by, authority, proposal_state, enabled, next_fire_at,
          last_fired_at, created_at, updated_at, create_idempotency_key, create_command_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "agent-active",
      "test-agent",
      "schedule",
      JSON.stringify({
        version: 2,
        kind: "daily",
        timeZone: "Europe/Madrid",
        at: "09:00",
      }),
      "seed",
      "solo",
      null,
      "agent",
      "agent",
      null,
      1,
      1_700_000_100_000,
      null,
      1_700_000_000_000,
      1_700_000_000_000,
      null,
      null,
    );
    const app = makeApp({
      projection: agenda.projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      readAgentTriggerPolicy: async () => ({ maxActiveAgentTriggers: 1 }),
    });

    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-agent-limit",
    );
    assert.equal(status, 409);
    assert.equal(body.code, "TRIGGER_LIMIT_REACHED");
  });

  it("agente no puede revocar un Trigger de owner → 403 FORBIDDEN", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    // Trigger de owner (el agente no lo creó).
    db.prepare(
      `INSERT INTO triggers
         (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
          created_by, authority, proposal_state, enabled, next_fire_at,
          last_fired_at, created_at, updated_at, create_idempotency_key, create_command_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "owner-trig",
      "test-agent",
      "schedule",
      JSON.stringify({
        version: 2,
        kind: "daily",
        timeZone: "Europe/Madrid",
        at: "09:00",
      }),
      "seed",
      "solo",
      null,
      "owner",
      "owner",
      null,
      1,
      1_700_000_100_000,
      null,
      1_700_000_000_000,
      1_700_000_000_000,
      null,
      null,
    );
    const app = makeApp({
      projection: agenda.projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const res = await app.request(
      `/agents/test-agent/triggers/owner-trig/revoke`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-pihub-principal": "runner",
          "x-pihub-agent": "test-agent",
        },
      },
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "FORBIDDEN");
    // El trigger de owner sigue habilitado.
    const row = db
      .prepare("SELECT enabled FROM triggers WHERE id = 'owner-trig'")
      .get() as { enabled: number };
    assert.equal(row.enabled, 1);
  });

  it("agente revoca su propio Trigger → 200 y quedó deshabilitado", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const agenda = new AgendaRepository(db);
    const app = makeApp({
      projection: agenda.projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });

    const create = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-agent-self",
    );
    assert.equal(create.status, 201);
    const id = (create.body.trigger as Record<string, unknown>).id as string;

    const res = await app.request(`/agents/test-agent/triggers/${id}/revoke`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "x-pihub-principal": "runner",
        "x-pihub-agent": "test-agent",
      },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal((body.trigger as Record<string, unknown>).createdBy, "agent");
    const row = db
      .prepare("SELECT enabled FROM triggers WHERE id = ?")
      .get(id) as { enabled: number };
    assert.equal(row.enabled, 0);
  });
});

// Fix round (post-REJECT) — P2: obligaciones 2a.
describe("pihub step 2a — fix round (R1..R4)", () => {
  it("F3/R3-003: retry con la misma Idempotency-Key al límite → 200 replayed=true", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      readAgentTriggerPolicy: async () => ({ maxActiveAgentTriggers: 1 }),
    });
    // Creación con max=1 (0 activos → pasa) y la key queda registrada.
    const first = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-replay-limit",
    );
    assert.equal(first.status, 201);
    // Retry con la MISMA key al límite: el replay se resuelve ANTES del gate.
    const replay = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-replay-limit",
    );
    assert.equal(
      replay.status,
      200,
      "la retry con misma key devuelve 200, no 409",
    );
    assert.equal(replay.body.replayed, true);
  });

  it("F5/R1-008: un Runner con X-Pihub-Agent de otro Agent → 403 FORBIDDEN", async () => {
    const db = openMemoryDb();
    registerAgent("target-agent");
    registerAgent("other-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    const res = await app.request(`/agents/target-agent/triggers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "k-bind",
        authorization: "Bearer token",
        "x-pihub-principal": "runner",
        "x-pihub-agent": "other-agent", // el Runner dice llamarse otro Agent
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
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "FORBIDDEN");
  });

  it("F5/R1-008: un Runner que omite X-Pihub-Agent → 403 FORBIDDEN (no se asume el path)", async () => {
    const db = openMemoryDb();
    registerAgent("target-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    const res = await app.request(`/agents/target-agent/triggers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "k-nobind",
        authorization: "Bearer token",
        "x-pihub-principal": "runner",
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
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "FORBIDDEN");
  });

  it("F10/R3-005: header distinto de 'runner' ('Runner', 'agent', vacío) → control_plane", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    for (const value of ["Runner", "agent", ""]) {
      const app = makeApp({
        projection: new AgendaRepository(db).projection,
        control: makeControl(db),
        agentExists: makeAgentExists(),
        now: () => 1_700_000_000_000,
      });
      const { status, body } = await createTrigger(
        app,
        "test-agent",
        { authorization: "Bearer token", "x-pihub-principal": value },
        `k-edge-${value}`,
      );
      assert.equal(status, 201);
      const trigger = body.trigger as Record<string, unknown>;
      assert.equal(
        trigger.createdBy,
        "control_plane",
        `valor header '${value}' → control_plane`,
      );
      assert.equal(
        trigger.authority,
        "control_plane",
        `valor header '${value}' → control_plane`,
      );
    }
  });

  it("F10/R3-005: cookie de panel + header runner → sigue siendo owner (el panel manda)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    const { status, body } = await createTrigger(
      app,
      "test-agent",
      {
        cookie: `${AUTH_COOKIE}=panel-token`,
        "x-pihub-principal": "runner",
        "x-pihub-agent": "test-agent",
      },
      "k-panel-header",
    );
    assert.equal(status, 201);
    const trigger = body.trigger as Record<string, unknown>;
    assert.equal(trigger.createdBy, "owner");
    assert.equal(trigger.authority, "owner");
  });

  it("F11/R3-006: enabled no booleano → 403 AUTONOMY_DISABLED (fail-closed)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      readAgentTriggerPolicy: async () => ({ enabled: "yes" as never }),
    });
    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-shape-enabled",
    );
    assert.equal(status, 403);
    assert.equal(body.code, "AUTONOMY_DISABLED");
  });

  it("F11/R3-006: maxActiveAgentTriggers no positivo (0, -1, 1.5, '5') → 403 AUTONOMY_DISABLED", async () => {
    for (const bad of [0, -1, 1.5, "5"]) {
      const db = openMemoryDb();
      registerAgent("test-agent");
      const app = makeApp({
        projection: new AgendaRepository(db).projection,
        control: makeControl(db),
        agentExists: makeAgentExists(),
        now: () => 1_700_000_000_000,
        readAgentTriggerPolicy: async () => ({
          maxActiveAgentTriggers: bad as never,
        }),
      });
      const { status, body } = await createTrigger(
        app,
        "test-agent",
        { authorization: "Bearer token", "x-pihub-principal": "runner" },
        `k-shape-max-${String(bad)}`,
      );
      assert.equal(status, 403, `max=${String(bad)} → 403`);
      assert.equal(
        body.code,
        "AUTONOMY_DISABLED",
        `max=${String(bad)} → AUTONOMY_DISABLED`,
      );
    }
  });

  it("F12/R4-004: error de lectura ≠ ENOENT → 403 AUTONOMY_DISABLED (no defaults silenciosos)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      // El provider de routes.ts convierte un error no-ENOENT en AUTONOMY_DISABLED
      // (fail-closed); aquí se reproduce ese contrato.
      readAgentTriggerPolicy: async () => {
        throw new DomainError(
          "AUTONOMY_DISABLED",
          "lectura de config falló: fail-closed",
        );
      },
    });
    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-readerr",
    );
    assert.equal(status, 403);
    assert.equal(body.code, "AUTONOMY_DISABLED");
  });

  it("F12/R4-004: un error de lectura no-DomainError → 500 INTERNAL (nunca defaults)", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
      readAgentTriggerPolicy: async () => {
        throw new Error("permiso denegado al leer la config");
      },
    });
    const { status, body } = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-readerr-generic",
    );
    // No se devuelve 201 con defaults silenciosos: un error no mapeado es INTERNAL.
    assert.equal(status, 500);
    assert.equal(body.code, "INTERNAL_ERROR");
  });

  it("F2/R3-001: owner (cookie panel) revoca un Trigger creado por el agente → 200, enabled=0", async () => {
    const db = openMemoryDb();
    registerAgent("test-agent");
    const app = makeApp({
      projection: new AgendaRepository(db).projection,
      control: makeControl(db),
      agentExists: makeAgentExists(),
      now: () => 1_700_000_000_000,
    });
    // El agente crea el trigger (created_by='agent', authority='agent').
    const create = await createTrigger(
      app,
      "test-agent",
      { authorization: "Bearer token", "x-pihub-principal": "runner" },
      "k-owner-revoke",
    );
    assert.equal(create.status, 201);
    const id = (create.body.trigger as Record<string, unknown>).id as string;

    // El owner (panel) lo revoca: ADR 0035 visibilidad/revocabilidad.
    const res = await app.request(`/agents/test-agent/triggers/${id}/revoke`, {
      method: "POST",
      headers: { cookie: `${AUTH_COOKIE}=panel-token` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal((body.trigger as Record<string, unknown>).enabled, false);
    const row = db
      .prepare("SELECT enabled FROM triggers WHERE id = ?")
      .get(id) as { enabled: number };
    assert.equal(row.enabled, 0);
  });
});
