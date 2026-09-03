// P1.3 — AutonomyControl.createTrigger (plan P1 §4.1).
//
// Primera **escritura** de la superficie de autonomía. Todo el comportamiento
// bajo prueba se cruza por `AutonomyControl.createTrigger` — la Interface de
// Control —, nunca por `db` ni por el repositorio directamente; el SQL directo
// es solo fixture (setup) y verificación de estado durable (conteos/metadata).
//
// Decisiones cerradas de la sub-fase, aquí convertidas en invariantes:
//
//   - solo create `version: 2` (`daily`/`weekly`); `version: 1` se rechaza;
//   - la key de idempotencia va scoped por Agent y el hash sobre el comando
//     canónico (definition, intent, mode, suggestedSkill);
//   - replay con misma key y mismo payload → mismo ID y **una sola fila**
//     (conteo SQL que lo demuestra);
//   - misma key con payload distinto → `IDEMPOTENCY_CONFLICT`;
//   - misma key en otro Agent → otro Trigger (dos filas);
//   - el caller no aporta ID, `enabled`, `proposal_state` ni next fire: los
//     materializa el sistema;
//   - Gobernador/Gobernado materializan `created_by`/`authority` correctas,
//     inyectadas — nunca inferidas de ninguna credencial.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository, AutonomyControl } from "../src/agenda/index.ts";
import type {
  CreateTriggerCommand,
  EffectiveTriggerAuthority,
} from "../src/agenda/index.ts";
import { DEFAULT_MAX_ACTIVE_AGENT_TRIGGERS } from "../src/agenda/index.ts";
import type { ScheduleV2 } from "../src/agenda/triggers.ts";
import { DomainError } from "../src/agenda/errors.ts";

const openDbs: SqliteDb[] = [];

/** Fixture de `:memory:` con el esquema aplicado (patrón de la suite). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function control(
  db: SqliteDb,
  authority: EffectiveTriggerAuthority = "owner",
): AutonomyControl {
  // P1.5: `AutonomyControl` recibe además `turns: Pick<TurnExecution,"abort">`;
  // estos tests de Triggers nunca llegan al camino de abort, así que el fake
  // falla si alguien lo invocara.
  return new AutonomyControl({
    agenda: new AgendaRepository(db),
    turns: {
      abort: (): boolean => {
        throw new Error("abort no debe invocarse en tests de Triggers");
      },
    },
    authority,
  });
}

/** definition v2 daily de fixture. */
const DAILY_MADRID_09: ScheduleV2 = {
  version: 2,
  kind: "daily",
  timeZone: "Europe/Madrid",
  at: "09:00",
};

interface CreateOverrides {
  agentName?: string;
  definition?: ScheduleV2;
  intent?: string;
  mode?: "solo" | "ask";
  suggestedSkill?: string | null;
  idempotencyKey?: string;
  now?: number;
}

/** Comando de Control con defaults estables. */
function command(overrides: CreateOverrides = {}): CreateTriggerCommand {
  return {
    agentName: overrides.agentName ?? "alice",
    definition: overrides.definition ?? DAILY_MADRID_09,
    intent: overrides.intent ?? "saluda cada mañana",
    mode: overrides.mode ?? "solo",
    suggestedSkill: overrides.suggestedSkill ?? null,
    idempotencyKey: overrides.idempotencyKey ?? "key-1",
    now: overrides.now ?? Date.parse("2024-03-29T08:00:00Z"),
  };
}

/** Fila cruda de `triggers` para verificar la metadata materializada. */
interface TriggerRaw {
  id: string;
  agent_name: string;
  kind: string;
  definition_json: string;
  intent: string;
  mode: string;
  suggested_skill: string | null;
  created_by: string;
  authority: string;
  proposal_state: string | null;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
  create_idempotency_key: string | null;
  create_command_hash: string | null;
}

function triggerRow(db: SqliteDb, id: string): TriggerRaw {
  return db
    .prepare(
      `SELECT id, agent_name, kind, definition_json, intent, mode, suggested_skill,
              created_by, authority, proposal_state, enabled, next_fire_at,
              last_fired_at, created_at, updated_at, create_idempotency_key,
              create_command_hash
         FROM triggers WHERE id = ?`,
    )
    .get(id) as TriggerRaw;
}

/** Conteo SQL por `(agent_name, key)` — el criterio verificable de la sub-fase. */
function countByKey(db: SqliteDb, agentName: string, key: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM triggers WHERE agent_name = ? AND create_idempotency_key = ?",
    )
    .get(agentName, key) as { n: number };
  return row.n;
}

function isDomainError(code: string): (err: unknown) => boolean {
  return (err: unknown) => err instanceof DomainError && err.code === code;
}

const ms = (s: string) => Date.parse(s);

describe("AutonomyControl.createTrigger (P1.3, plan P1 §4.1)", () => {
  it("daily válido: materializa id, kind=schedule, metadata y next_fire_at > now", () => {
    const db = openMemoryDb();
    const now = ms("2024-03-29T08:00:00Z");
    const result = control(db).createTrigger(command({ now }));

    assert.strictEqual(result.replayed, false);
    const trigger = result.trigger;
    assert.ok(trigger.id.length > 0);
    assert.strictEqual(trigger.agentName, "alice");
    assert.strictEqual(trigger.kind, "schedule");
    assert.strictEqual(trigger.intent, "saluda cada mañana");
    assert.strictEqual(trigger.mode, "solo");
    assert.strictEqual(trigger.suggestedSkill, null);
    assert.strictEqual(trigger.createdBy, "owner");
    assert.strictEqual(trigger.authority, "owner");
    assert.strictEqual(trigger.proposalState, null);
    assert.strictEqual(trigger.enabled, true);
    assert.strictEqual(trigger.nextFireAt, ms("2024-03-30T08:00:00Z"));
    assert.ok(
      trigger.nextFireAt! > now,
      "next_fire_at estrictamente posterior a now",
    );
    assert.strictEqual(trigger.lastFiredAt, null);
    assert.strictEqual(trigger.createdAt, now);
    assert.strictEqual(trigger.updatedAt, now);
    assert.strictEqual(trigger.createIdempotencyKey, "key-1");
    assert.match(trigger.createCommandHash!, /^[0-9a-f]{64}$/);

    // La fila durable confirma la normalización y la metadata materializada.
    const row = triggerRow(db, trigger.id);
    assert.strictEqual(row.kind, "schedule");
    assert.deepEqual(JSON.parse(row.definition_json), {
      version: 2,
      kind: "daily",
      timeZone: "Europe/Madrid",
      at: "09:00",
    });
    assert.strictEqual(row.created_by, "owner");
    assert.strictEqual(row.authority, "owner");
    assert.strictEqual(row.proposal_state, null);
    assert.strictEqual(row.enabled, 1);
    assert.strictEqual(row.next_fire_at, trigger.nextFireAt);
    assert.strictEqual(row.last_fired_at, null);
    assert.strictEqual(row.created_at, now);
    assert.strictEqual(row.updated_at, now);
    assert.strictEqual(row.create_idempotency_key, "key-1");
    assert.strictEqual(row.create_command_hash, trigger.createCommandHash);
  });

  it("weekly válido: days se conservan (canónico ordenado) y next_fire_at cae en un día elegido", () => {
    const db = openMemoryDb();
    const now = ms("2024-03-29T07:00:00Z"); // viernes 08:00 en Madrid, antes de las 09:00
    const result = control(db).createTrigger(
      command({
        definition: {
          version: 2,
          kind: "weekly",
          timeZone: "Europe/Madrid",
          at: "09:00",
          days: ["wed", "fri"],
        },
        now,
      }),
    );

    const trigger = result.trigger;
    assert.strictEqual(result.replayed, false);
    // El `definition` devuelto es el canónico persistido: claves fijas, days ordenado.
    assert.deepEqual(trigger.definition, {
      version: 2,
      kind: "weekly",
      timeZone: "Europe/Madrid",
      at: "09:00",
      days: ["fri", "wed"],
    });
    // Hoy es viernes y el disparo de las 09:00 aún no llegó → next es hoy mismo.
    assert.strictEqual(trigger.nextFireAt, ms("2024-03-29T08:00:00Z"));
  });

  it("invalid definition (IANA, HH:mm, días, v1): TRIGGER_NOT_DISPARABLE y cero filas", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const invalids: ScheduleV2[] = [
      { version: 2, kind: "daily", timeZone: "Mars/Olympus_Mons", at: "09:00" },
      { version: 2, kind: "daily", timeZone: "+01:00", at: "09:00" },
      { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "24:00" },
      { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "9:00" },
      { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00:00" },
      {
        version: 2,
        kind: "weekly",
        timeZone: "Europe/Madrid",
        at: "09:00",
        days: [],
      },
      {
        version: 2,
        kind: "weekly",
        timeZone: "Europe/Madrid",
        at: "09:00",
        days: ["mon", "mon"],
      },
      {
        version: 2,
        kind: "weekly",
        timeZone: "Europe/Madrid",
        at: "09:00",
        days: ["mond"],
      },
      {
        version: 2,
        kind: "daily",
        timeZone: "Europe/Madrid",
        at: "09:00",
        days: ["mon"],
      },
      { version: 1, kind: "interval", intervalMs: 5000 },
    ];

    for (const definition of invalids) {
      assert.throws(
        () =>
          ctl.createTrigger(
            command({ definition, idempotencyKey: `k-${definition.kind}` }),
          ),
        isDomainError("TRIGGER_NOT_DISPARABLE"),
        `definition ${JSON.stringify(definition)} debe rechazarse`,
      );
    }
    const total = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as {
      n: number;
    };
    assert.strictEqual(total.n, 0, "ningún create rechazado deja fila");
  });

  it("next_fire_at > now con DST: daily 02:30 en el hueco de Madrid se desplaza", () => {
    const db = openMemoryDb();
    const now = ms("2024-03-30T23:00:00Z");
    const result = control(db).createTrigger(
      command({
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "02:30",
        },
        now,
      }),
    );

    const next = result.trigger.nextFireAt;
    assert.strictEqual(next, ms("2024-03-31T01:30:00Z"));
    assert.ok(
      next! > now,
      "la primera ocurrencia es estrictamente posterior a now",
    );
  });

  it("replay con misma key y mismo payload: mismo ID, replayed=true, una sola fila", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const first = ctl.createTrigger(command());
    const second = ctl.createTrigger(command());

    assert.strictEqual(first.replayed, false);
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.trigger.id, first.trigger.id);
    assert.strictEqual(
      countByKey(db, "alice", "key-1"),
      1,
      "replay no crea segunda fila",
    );
  });

  it("replay con distinto `now`: mismo ID y next_fire_at intacto", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const first = ctl.createTrigger(
      command({ now: ms("2024-03-29T08:00:00Z") }),
    );
    const originalNext = first.trigger.nextFireAt;

    const replay = ctl.createTrigger(
      command({ now: ms("2024-03-30T07:00:00Z") }),
    );

    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.trigger.id, first.trigger.id);
    assert.strictEqual(
      replay.trigger.nextFireAt,
      originalNext,
      "el replay no reprograma",
    );
    assert.strictEqual(countByKey(db, "alice", "key-1"), 1);
  });

  it("misma key con payload distinto → IDEMPOTENCY_CONFLICT, no es replay ni segunda fila", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    ctl.createTrigger(command());

    const variants: CreateOverrides[] = [
      {
        definition: {
          version: 2,
          kind: "daily",
          timeZone: "Europe/Madrid",
          at: "10:00",
        },
      },
      { intent: "otra intención" },
      { mode: "ask" },
      { suggestedSkill: "skill:otra" },
    ];
    for (const overrides of variants) {
      assert.throws(
        () => ctl.createTrigger(command(overrides)),
        isDomainError("IDEMPOTENCY_CONFLICT"),
        `payload distinto debe ser IDEMPOTENCY_CONFLICT: ${JSON.stringify(overrides)}`,
      );
    }
    assert.strictEqual(
      countByKey(db, "alice", "key-1"),
      1,
      "el conflicto no crea fila",
    );
  });

  it("misma key en otro Agent crea otro Trigger: dos filas y IDs distintos", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const alice = ctl.createTrigger(
      command({ agentName: "alice", idempotencyKey: "key-comp" }),
    );
    const bob = ctl.createTrigger(
      command({ agentName: "bob", idempotencyKey: "key-comp" }),
    );

    assert.notStrictEqual(bob.trigger.id, alice.trigger.id);
    assert.strictEqual(bob.replayed, false);
    assert.strictEqual(countByKey(db, "alice", "key-comp"), 1);
    assert.strictEqual(countByKey(db, "bob", "key-comp"), 1);
    const total = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as {
      n: number;
    };
    assert.strictEqual(
      total.n,
      2,
      "la misma key en Agents distintos son dos Triggers",
    );
  });

  it("Gobernador (authority owner): created_by=owner, authority=owner", () => {
    const db = openMemoryDb();
    const result = control(db, "owner").createTrigger(command());
    const row = triggerRow(db, result.trigger.id);
    assert.strictEqual(row.created_by, "owner");
    assert.strictEqual(row.authority, "owner");
  });

  it("Gobernado (authority control_plane): created_by=control_plane, authority=control_plane", () => {
    const db = openMemoryDb();
    const result = control(db, "control_plane").createTrigger(command());
    const row = triggerRow(db, result.trigger.id);
    assert.strictEqual(row.created_by, "control_plane");
    assert.strictEqual(row.authority, "control_plane");
    assert.strictEqual(row.proposal_state, null);
    assert.strictEqual(row.enabled, 1);
  });

  it("canónico: days en distinto orden es la misma key/payload (replay, no conflicto)", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const first = ctl.createTrigger(
      command({
        definition: {
          version: 2,
          kind: "weekly",
          timeZone: "Europe/Madrid",
          at: "09:00",
          days: ["mon", "wed"],
        },
      }),
    );
    const replay = ctl.createTrigger(
      command({
        definition: {
          version: 2,
          kind: "weekly",
          timeZone: "Europe/Madrid",
          at: "09:00",
          days: ["wed", "mon"],
        },
      }),
    );

    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.trigger.id, first.trigger.id);
    assert.strictEqual(countByKey(db, "alice", "key-1"), 1);
  });

  it("tras un create idempotente la base queda operativa: el Trigger se ve en la proyección", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const { trigger } = ctl.createTrigger(command());

    const snapshot = new AgendaRepository(db).projection.snapshotForAgent(
      "alice",
      ms("2024-03-29T08:00:00Z"),
    );
    assert.deepEqual(
      snapshot.triggers.map((t) => t.id),
      [trigger.id],
    );
  });
});

/** Siembra un Trigger con metadata arbitraria (setup, no comportamiento bajo prueba). */
function seedTrigger(
  db: SqliteDb,
  overrides: {
    id: string;
    agent_name?: string;
    created_by?: "owner" | "control_plane" | "agent";
    authority?: "owner" | "control_plane" | "agent";
    proposal_state?: "proposed" | "approved" | null;
    enabled?: number;
    next_fire_at?: number | null;
    updated_at?: number;
  },
): void {
  db.prepare(
    `INSERT INTO triggers
       (id, agent_name, kind, definition_json, intent, mode, suggested_skill,
        created_by, authority, proposal_state, enabled, next_fire_at,
        last_fired_at, created_at, updated_at, create_idempotency_key,
        create_command_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    overrides.id,
    overrides.agent_name ?? "alice",
    "schedule",
    JSON.stringify({
      version: 2,
      kind: "daily",
      timeZone: "Europe/Madrid",
      at: "09:00",
    }),
    "intent semilla",
    "solo",
    null,
    overrides.created_by ?? "owner",
    overrides.authority ?? "owner",
    overrides.proposal_state ?? null,
    overrides.enabled ?? 1,
    overrides.next_fire_at ?? ms("2024-03-30T08:00:00Z"),
    null,
    0,
    overrides.updated_at ?? 0,
    null,
    null,
  );
}

/** Metadata de autoridad de una fila, para afirmar lo que la reconciliación conserva/cambia. */
interface AuthorityRow {
  id: string;
  agent_name: string;
  created_by: string;
  authority: string;
  proposal_state: string | null;
  enabled: number;
  next_fire_at: number | null;
  updated_at: number;
}

function authorityRow(db: SqliteDb, id: string): AuthorityRow {
  return db
    .prepare(
      `SELECT id, agent_name, created_by, authority, proposal_state, enabled, next_fire_at, updated_at
         FROM triggers WHERE id = ?`,
    )
    .get(id) as AuthorityRow;
}

describe("AutonomyControl.revokeTrigger (P1.4, plan P1 §4.2)", () => {
  it("revoke con autoridad correcta: deshabilita, anula next_fire_at y conserva created_by/last_fired_at", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const created = ctl.createTrigger(
      command({ now: ms("2024-03-29T08:00:00Z") }),
    );
    // Conserva `last_fired_at`: si el Trigger ya disparó, revocar no borra historia.
    db.prepare("UPDATE triggers SET last_fired_at = 5 WHERE id = ?").run(
      created.trigger.id,
    );
    const revokeNow = ms("2024-03-29T09:00:00Z");

    const revoked = ctl.revokeTrigger({
      agentName: "alice",
      triggerId: created.trigger.id,
      now: revokeNow,
    });

    assert.strictEqual(revoked.enabled, false);
    assert.strictEqual(revoked.nextFireAt, null);
    assert.strictEqual(revoked.updatedAt, revokeNow);
    assert.strictEqual(
      revoked.createdBy,
      "owner",
      "created_by es procedencia histórica y nunca cambia",
    );
    assert.strictEqual(
      revoked.lastFiredAt,
      5,
      "revocar no borra last_fired_at",
    );

    const row = authorityRow(db, created.trigger.id);
    assert.strictEqual(row.enabled, 0);
    assert.strictEqual(row.next_fire_at, null);
    assert.strictEqual(row.updated_at, revokeNow);
    assert.strictEqual(row.created_by, "owner");
    const count = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as {
      n: number;
    };
    assert.strictEqual(count.n, 1, "revocar no borra el Trigger");

    // Revocar conserva historia: la proyección sigue viendo el Trigger, deshabilitado.
    const snapshot = new AgendaRepository(db).projection.snapshotForAgent(
      "alice",
      revokeNow,
    );
    assert.deepEqual(
      snapshot.triggers.map((t) => t.id),
      [created.trigger.id],
    );
    assert.strictEqual(snapshot.triggers[0].enabled, false);
  });

  it("revoke repetido es éxito idempotente y no vuelve a tocar updated_at", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command());
    const firstNow = ms("2024-03-29T09:00:00Z");
    const secondNow = ms("2024-03-29T10:00:00Z");

    ctl.revokeTrigger({
      agentName: "alice",
      triggerId: trigger.id,
      now: firstNow,
    });
    const again = ctl.revokeTrigger({
      agentName: "alice",
      triggerId: trigger.id,
      now: secondNow,
    });

    assert.strictEqual(again.enabled, false);
    assert.strictEqual(again.nextFireAt, null);
    assert.strictEqual(
      again.updatedAt,
      firstNow,
      "la segunda revocación no reescribe updated_at",
    );
    assert.strictEqual(authorityRow(db, trigger.id).updated_at, firstNow);
  });

  it("revoke tras un disable externo (carrera perdida) es éxito idempotente y conserva updated_at", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command());
    // Otro escritor ya deshabilitó el Trigger (el CAS del revoke pierde la carrera).
    db.prepare(
      "UPDATE triggers SET enabled = 0, next_fire_at = NULL, updated_at = 500 WHERE id = ?",
    ).run(trigger.id);

    const result = ctl.revokeTrigger({
      agentName: "alice",
      triggerId: trigger.id,
      now: ms("2024-03-29T09:00:00Z"),
    });

    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.nextFireAt, null);
    assert.strictEqual(
      result.updatedAt,
      500,
      "el perdedor de la carrera no reescribe updated_at",
    );
  });

  it("revoke con autoridad distinta a la efectiva → TRIGGER_AUTHORITY_CONFLICT y el Trigger queda intacto", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command());

    assert.throws(
      () =>
        control(db, "control_plane").revokeTrigger({
          agentName: "alice",
          triggerId: trigger.id,
          now: ms("2024-03-29T09:00:00Z"),
        }),
      isDomainError("TRIGGER_AUTHORITY_CONFLICT"),
    );

    const row = authorityRow(db, trigger.id);
    assert.strictEqual(
      row.enabled,
      1,
      "el conflicto no deshabilita el Trigger",
    );
    assert.strictEqual(row.next_fire_at, trigger.nextFireAt);
  });

  it("revoke de un ID inexistente → TRIGGER_NOT_FOUND", () => {
    const db = openMemoryDb();
    assert.throws(
      () =>
        control(db).revokeTrigger({
          agentName: "alice",
          triggerId: "no-existe",
          now: ms("2024-03-29T09:00:00Z"),
        }),
      isDomainError("TRIGGER_NOT_FOUND"),
    );
  });

  it("revoke de un ID de otro Agent es indistinguible de inexistente → TRIGGER_NOT_FOUND", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command({ agentName: "alice" }));

    assert.throws(
      () =>
        control(db, "owner").revokeTrigger({
          agentName: "bob",
          triggerId: trigger.id,
          now: ms("2024-03-29T09:00:00Z"),
        }),
      isDomainError("TRIGGER_NOT_FOUND"),
    );

    const row = authorityRow(db, trigger.id);
    assert.strictEqual(row.enabled, 1, "el Trigger de Alice sigue habilitado");
    assert.strictEqual(row.agent_name, "alice");
  });

  it("Gobernado: revoke bajo control_plane conserva created_by=control_plane", () => {
    const db = openMemoryDb();
    const ctl = control(db, "control_plane");
    const { trigger } = ctl.createTrigger(command());

    const revoked = ctl.revokeTrigger({
      agentName: "alice",
      triggerId: trigger.id,
      now: ms("2024-03-29T09:00:00Z"),
    });

    assert.strictEqual(revoked.enabled, false);
    assert.strictEqual(
      revoked.createdBy,
      "control_plane",
      "created_by no se reescribe al revocar",
    );
    assert.strictEqual(
      authorityRow(db, trigger.id).created_by,
      "control_plane",
    );
  });
});

describe("TriggerRepository.reconcileAuthority (P1.4, plan P1 §5)", () => {
  it("matriz §5.1 bajo arranque Gobernador: authority=owner en todo, created_by intacto", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = ms("2024-03-29T08:00:00Z");
    seedTrigger(db, {
      id: "t-owner",
      created_by: "owner",
      authority: "owner",
      updated_at: 100,
    });
    seedTrigger(db, {
      id: "t-plane",
      created_by: "control_plane",
      authority: "control_plane",
    });
    seedTrigger(db, {
      id: "t-agent",
      created_by: "agent",
      authority: "control_plane",
      proposal_state: "proposed",
    });

    const changed = repo.triggers.reconcileAuthority("owner", now);

    assert.strictEqual(
      changed,
      2,
      "solo cambian las dos filas cuya authority no era owner",
    );

    const ownerRow = authorityRow(db, "t-owner");
    assert.strictEqual(ownerRow.authority, "owner");
    assert.strictEqual(ownerRow.created_by, "owner");
    assert.strictEqual(
      ownerRow.updated_at,
      100,
      "restart en el mismo modo no altera timestamps",
    );

    const planeRow = authorityRow(db, "t-plane");
    assert.strictEqual(planeRow.authority, "owner");
    assert.strictEqual(
      planeRow.created_by,
      "control_plane",
      "created_by es procedencia y nunca cambia",
    );
    assert.strictEqual(planeRow.updated_at, now);

    const agentRow = authorityRow(db, "t-agent");
    assert.strictEqual(agentRow.authority, "owner");
    assert.strictEqual(agentRow.created_by, "agent");
    assert.strictEqual(
      agentRow.proposal_state,
      "proposed",
      "la reconciliación no toca proposal_state",
    );
    assert.strictEqual(agentRow.enabled, 1);
  });

  it("matriz §5.1 bajo arranque Gobernado: authority=control_plane en todo, created_by intacto", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const now = ms("2024-03-29T08:00:00Z");
    seedTrigger(db, { id: "t-owner", created_by: "owner", authority: "owner" });
    seedTrigger(db, {
      id: "t-plane",
      created_by: "control_plane",
      authority: "control_plane",
      updated_at: 200,
    });
    seedTrigger(db, {
      id: "t-agent",
      created_by: "agent",
      authority: "owner",
      proposal_state: "proposed",
    });

    const changed = repo.triggers.reconcileAuthority("control_plane", now);

    assert.strictEqual(changed, 2);

    const ownerRow = authorityRow(db, "t-owner");
    assert.strictEqual(ownerRow.authority, "control_plane");
    assert.strictEqual(ownerRow.created_by, "owner");
    assert.strictEqual(ownerRow.updated_at, now);

    const planeRow = authorityRow(db, "t-plane");
    assert.strictEqual(planeRow.authority, "control_plane");
    assert.strictEqual(
      planeRow.updated_at,
      200,
      "restart en el mismo modo no altera timestamps",
    );

    const agentRow = authorityRow(db, "t-agent");
    assert.strictEqual(agentRow.authority, "control_plane");
    assert.strictEqual(agentRow.created_by, "agent");
    assert.strictEqual(agentRow.proposal_state, "proposed");
  });

  it("restart en el mismo modo: 0 cambios y timestamps estables", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedTrigger(db, {
      id: "t-owner",
      created_by: "owner",
      authority: "owner",
      updated_at: 100,
    });
    seedTrigger(db, {
      id: "t-owner2",
      created_by: "owner",
      authority: "owner",
      updated_at: 200,
    });

    const first = repo.triggers.reconcileAuthority(
      "owner",
      ms("2024-03-29T08:00:00Z"),
    );
    const second = repo.triggers.reconcileAuthority(
      "owner",
      ms("2024-03-29T09:00:00Z"),
    );

    assert.strictEqual(first, 0);
    assert.strictEqual(second, 0);
    assert.strictEqual(authorityRow(db, "t-owner").updated_at, 100);
    assert.strictEqual(authorityRow(db, "t-owner2").updated_at, 200);
  });

  it("cambio ida y vuelta Gobernador↔Gobernado: authority sigue al modo, created_by estable", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    const n1 = ms("2024-03-29T08:00:00Z");
    const n2 = ms("2024-03-29T09:00:00Z");
    const n3 = ms("2024-03-29T10:00:00Z");
    seedTrigger(db, {
      id: "t-plane",
      created_by: "control_plane",
      authority: "control_plane",
    });

    const toOwner = repo.triggers.reconcileAuthority("owner", n1);
    const backToPlane = repo.triggers.reconcileAuthority("control_plane", n2);
    const ownerAgain = repo.triggers.reconcileAuthority("owner", n3);

    assert.strictEqual(toOwner, 1);
    assert.strictEqual(backToPlane, 1);
    assert.strictEqual(ownerAgain, 1);

    const row = authorityRow(db, "t-plane");
    assert.strictEqual(row.authority, "owner", "la última reconciliación gana");
    assert.strictEqual(
      row.created_by,
      "control_plane",
      "created_by nunca cambia",
    );
    assert.strictEqual(row.updated_at, n3);
  });

  it("la reconciliación no toca la Agenda de otros Agent y solo afecta a triggers", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedTrigger(db, {
      id: "alice-t",
      agent_name: "alice",
      created_by: "owner",
      authority: "owner",
    });
    seedTrigger(db, {
      id: "bob-t",
      agent_name: "bob",
      created_by: "control_plane",
      authority: "control_plane",
    });

    const changed = repo.triggers.reconcileAuthority(
      "owner",
      ms("2024-03-29T08:00:00Z"),
    );

    assert.strictEqual(
      changed,
      1,
      "solo la fila de Bob cambia; la de Alice ya era owner",
    );
    assert.strictEqual(authorityRow(db, "bob-t").authority, "owner");
    assert.strictEqual(authorityRow(db, "alice-t").authority, "owner");
  });
});

/**
 * P2.4a — Autoridad efectiva `agent` (pihub step 2a). La autoridad se deriva del
 * principal por request; `AutonomyControl.createTrigger`/`revokeTrigger` aceptan
 * la autoridad por request (`options`) con la autoridad del proceso como DEFAULT.
 *
 * Decisiones cerradas, aquí convertidas en invariantes:
 *   - authority `agent`: gate de política ANTES de tocar disco.
 *   - (a) `autonomy.triggers.enabled === false` → `AUTONOMY_DISABLED`.
 *   - (b) count activos del agente con `created_by='agent'` ≥
 *         `maxActiveAgentTriggers` → `TRIGGER_LIMIT_REACHED`.
 *   - autoridad `owner`/`control_plane` bypassa el gate.
 *   - un Trigger de agente que pasa el gate nace `created_by='agent'`,
 *     `proposal_state=NULL` (ACTIVO, ADR 0035) y programado.
 *   - revoke `agent` solo sobre `created_by='agent'`; otro → `FORBIDDEN`.
 */
describe("Autoridad agent (P2.4a, pihub step 2a)", () => {
  it("pasa el gate dentro de política: created_by=agent, proposal_state NULL, programado", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const now = ms("2024-03-29T07:00:00Z");
    const result = ctl.createTrigger(command({ now }), {
      authority: "agent",
      policy: {},
    });

    assert.strictEqual(result.replayed, false);
    const trigger = result.trigger;
    assert.strictEqual(trigger.createdBy, "agent");
    assert.strictEqual(trigger.authority, "agent");
    assert.strictEqual(trigger.proposalState, null);
    assert.strictEqual(trigger.enabled, true);
    assert.ok(
      trigger.nextFireAt !== null,
      "el Trigger agent se programa (next_fire_at)",
    );
    assert.ok(trigger.nextFireAt! > now);

    const row = triggerRow(db, trigger.id);
    assert.strictEqual(row.created_by, "agent");
    assert.strictEqual(row.authority, "agent");
    assert.strictEqual(row.proposal_state, null);
    assert.strictEqual(row.enabled, 1);
  });

  it("policy enabled=false → AUTONOMY_DISABLED y cero filas (default de max=5)", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    assert.throws(
      () =>
        ctl.createTrigger(command(), {
          authority: "agent",
          policy: { enabled: false },
        }),
      isDomainError("AUTONOMY_DISABLED"),
    );
    const total = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as {
      n: number;
    };
    assert.strictEqual(total.n, 0, "el rechazo por política no deja fila");
  });

  it("límite por defecto (max=5) alcanzado → TRIGGER_LIMIT_REACHED", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    for (let i = 0; i < 5; i++) {
      seedTrigger(db, {
        id: `agent-activo-${i}`,
        created_by: "agent",
        authority: "agent",
        proposal_state: null,
      });
    }
    assert.throws(
      () => ctl.createTrigger(command(), { authority: "agent", policy: {} }),
      isDomainError("TRIGGER_LIMIT_REACHED"),
    );
  });

  it("maxActiveAgentTriggers explícito: 1 activo con max=1 → rechaza; 0 activos → crea", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    seedTrigger(db, {
      id: "ag",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
    });
    assert.throws(
      () =>
        ctl.createTrigger(command(), {
          authority: "agent",
          policy: { maxActiveAgentTriggers: 1 },
        }),
      isDomainError("TRIGGER_LIMIT_REACHED"),
    );
    // Otro agente sin filas: con max=1 crea sin problema.
    const ok = ctl.createTrigger(command({ agentName: "bob" }), {
      authority: "agent",
      policy: { maxActiveAgentTriggers: 1 },
    });
    assert.strictEqual(ok.trigger.createdBy, "agent");
  });

  it("solo cuenta activos de agente: los deshabilitados y los de owner/control_plane no pesan", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedTrigger(db, {
      id: "a1",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
    });
    seedTrigger(db, {
      id: "a2",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
    });
    seedTrigger(db, {
      id: "off",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
      enabled: 0,
    });
    seedTrigger(db, { id: "own", created_by: "owner", authority: "owner" });
    assert.strictEqual(repo.triggers.countActiveAgentTriggers("alice"), 2);
  });

  it("autoridad owner/control_plane bypassa el gate de agente (sin policy)", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const ownerResult = ctl.createTrigger(command(), { authority: "owner" });
    assert.strictEqual(ownerResult.trigger.createdBy, "owner");
    const planeResult = ctl.createTrigger(
      command({ idempotencyKey: "k-plane" }),
      { authority: "control_plane" },
    );
    assert.strictEqual(planeResult.trigger.createdBy, "control_plane");
  });

  it("revoke agent de un Trigger de owner → FORBIDDEN y el Trigger queda intacto", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command());
    assert.throws(
      () =>
        ctl.revokeTrigger(
          {
            agentName: "alice",
            triggerId: trigger.id,
            now: ms("2024-03-29T09:00:00Z"),
          },
          { authority: "agent" },
        ),
      isDomainError("FORBIDDEN"),
    );
    const row = authorityRow(db, trigger.id);
    assert.strictEqual(
      row.enabled,
      1,
      "el rechazo FORBIDDEN no deshabilita el Trigger",
    );
  });

  it("revoke agent de un Trigger propio → ok y created_by/authority intactos", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command(), { authority: "agent" });
    const revoked = ctl.revokeTrigger(
      {
        agentName: "alice",
        triggerId: trigger.id,
        now: ms("2024-03-29T09:00:00Z"),
      },
      { authority: "agent" },
    );
    assert.strictEqual(revoked.enabled, false);
    assert.strictEqual(revoked.nextFireAt, null);
    assert.strictEqual(
      revoked.createdBy,
      "agent",
      "revocar no reescribe created_by",
    );
    assert.strictEqual(revoked.authority, "agent");
    assert.strictEqual(authorityRow(db, trigger.id).created_by, "agent");
  });

  it("el DEFAULT del proceso (authority owner) sigue funcionando sin options (retrocompat)", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const result = ctl.createTrigger(command());
    assert.strictEqual(result.trigger.createdBy, "owner");
  });

  it("F3/R3-003: retry con la MISMA key al límite → replayed=true, no TRIGGER_LIMIT_REACHED", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const first = ctl.createTrigger(command(), {
      authority: "agent",
      policy: {},
    });
    assert.strictEqual(first.replayed, false);
    // Al reiniciar la política con max=1 y el trigger activo, la retry con la
    // misma key resuelve el replay ANTES del gate.
    const replay = ctl.createTrigger(command(), {
      authority: "agent",
      policy: { maxActiveAgentTriggers: 1 },
    });
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.trigger.id, first.trigger.id);
    assert.strictEqual(triggerRow(db, first.trigger.id).enabled, 1);
  });

  it("F2/R3-001: owner/control_plane revoca un Trigger creado por el agente", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    const { trigger } = ctl.createTrigger(command(), { authority: "agent" });
    assert.strictEqual(trigger.createdBy, "agent");
    // owner revoca la fila creada por el agente (ADR 0035): éxito, no CONFLICT.
    const revoked = ctl.revokeTrigger(
      {
        agentName: "alice",
        triggerId: trigger.id,
        now: ms("2024-03-29T09:00:00Z"),
      },
      { authority: "owner" },
    );
    assert.strictEqual(revoked.enabled, false);
    assert.strictEqual(
      authorityRow(db, trigger.id).created_by,
      "agent",
      "created_by no se reescribe",
    );
    assert.strictEqual(authorityRow(db, trigger.id).enabled, 0);
    // Lo mismo con control_plane.
    const ctlPlane = control(db, "owner");
    const { trigger: t2 } = ctlPlane.createTrigger(
      command({ idempotencyKey: "k-2" }),
      { authority: "agent" },
    );
    const revoked2 = ctlPlane.revokeTrigger(
      { agentName: "alice", triggerId: t2.id, now: ms("2024-03-29T09:00:00Z") },
      { authority: "control_plane" },
    );
    assert.strictEqual(revoked2.enabled, false);
  });

  it("F13/R2-004: DEFAULT_MAX_ACTIVE_AGENT_TRIGGERS = 5 y gate con límite por defecto", () => {
    const db = openMemoryDb();
    const ctl = control(db, "owner");
    // Default 5: con 4 activos crea (count=4 < 5); con 5 activos rechaza.
    for (let i = 0; i < 4; i++) {
      seedTrigger(db, {
        id: `a-${i}`,
        created_by: "agent",
        authority: "agent",
        proposal_state: null,
      });
    }
    const ok = ctl.createTrigger(command(), { authority: "agent", policy: {} });
    assert.strictEqual(ok.trigger.createdBy, "agent");
    assert.strictEqual(DEFAULT_MAX_ACTIVE_AGENT_TRIGGERS, 5);
    seedTrigger(db, {
      id: "a-5",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
    });
    assert.throws(
      () =>
        ctl.createTrigger(command({ idempotencyKey: "k-full" }), {
          authority: "agent",
          policy: {},
        }),
      isDomainError("TRIGGER_LIMIT_REACHED"),
    );
  });
});

describe("reconcileAuthority y la autoridad agent (R3-002/R4-001)", () => {
  it("una fila de agente (created_by=agent, authority=agent) sobrevive a la reconciliación en modo owner", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedTrigger(db, {
      id: "ag",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
      updated_at: 100,
    });
    seedTrigger(db, {
      id: "pl",
      created_by: "control_plane",
      authority: "control_plane",
    });
    const changed = repo.triggers.reconcileAuthority(
      "owner",
      ms("2024-03-29T08:00:00Z"),
    );
    assert.strictEqual(
      changed,
      1,
      "solo cambia la fila control_plane; la del agente queda intacta",
    );
    assert.strictEqual(
      authorityRow(db, "ag").authority,
      "agent",
      "la fila de agente NO se reescribe a owner",
    );
    assert.strictEqual(
      authorityRow(db, "ag").updated_at,
      100,
      "timestamp intacto",
    );
    assert.strictEqual(authorityRow(db, "pl").authority, "owner");
  });

  it("una fila de agente sobrevive a la reconciliación en modo control_plane", () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedTrigger(db, {
      id: "ag",
      created_by: "agent",
      authority: "agent",
      proposal_state: null,
      updated_at: 200,
    });
    seedTrigger(db, { id: "own", created_by: "owner", authority: "owner" });
    const changed = repo.triggers.reconcileAuthority(
      "control_plane",
      ms("2024-03-29T08:00:00Z"),
    );
    assert.strictEqual(
      changed,
      1,
      "solo cambia la fila owner; la del agente queda intacta",
    );
    assert.strictEqual(
      authorityRow(db, "ag").authority,
      "agent",
      "la fila de agente NO se reescribe a control_plane",
    );
    assert.strictEqual(authorityRow(db, "ag").updated_at, 200);
    assert.strictEqual(authorityRow(db, "own").authority, "control_plane");
  });
});
