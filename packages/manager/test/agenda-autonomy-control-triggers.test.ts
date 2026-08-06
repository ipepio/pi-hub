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

function control(db: SqliteDb, authority: EffectiveTriggerAuthority = "owner"): AutonomyControl {
  return new AutonomyControl({ agenda: new AgendaRepository(db), authority });
}

/** definition v2 daily de fixture. */
const DAILY_MADRID_09: ScheduleV2 = {
  version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00",
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
    assert.ok(trigger.nextFireAt! > now, "next_fire_at estrictamente posterior a now");
    assert.strictEqual(trigger.lastFiredAt, null);
    assert.strictEqual(trigger.createdAt, now);
    assert.strictEqual(trigger.updatedAt, now);
    assert.strictEqual(trigger.createIdempotencyKey, "key-1");
    assert.match(trigger.createCommandHash!, /^[0-9a-f]{64}$/);

    // La fila durable confirma la normalización y la metadata materializada.
    const row = triggerRow(db, trigger.id);
    assert.strictEqual(row.kind, "schedule");
    assert.deepEqual(JSON.parse(row.definition_json), {
      version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00",
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
          version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00",
          days: ["wed", "fri"],
        },
        now,
      }),
    );

    const trigger = result.trigger;
    assert.strictEqual(result.replayed, false);
    // El `definition` devuelto es el canónico persistido: claves fijas, days ordenado.
    assert.deepEqual(trigger.definition, {
      version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00",
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
      { version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00", days: [] },
      { version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00", days: ["mon", "mon"] },
      { version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00", days: ["mond"] },
      { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00", days: ["mon"] },
      { version: 1, kind: "interval", intervalMs: 5000 },
    ];

    for (const definition of invalids) {
      assert.throws(
        () => ctl.createTrigger(command({ definition, idempotencyKey: `k-${definition.kind}` })),
        isDomainError("TRIGGER_NOT_DISPARABLE"),
        `definition ${JSON.stringify(definition)} debe rechazarse`,
      );
    }
    const total = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number };
    assert.strictEqual(total.n, 0, "ningún create rechazado deja fila");
  });

  it("next_fire_at > now con DST: daily 02:30 en el hueco de Madrid se desplaza", () => {
    const db = openMemoryDb();
    const now = ms("2024-03-30T23:00:00Z");
    const result = control(db).createTrigger(
      command({
        definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "02:30" },
        now,
      }),
    );

    const next = result.trigger.nextFireAt;
    assert.strictEqual(next, ms("2024-03-31T01:30:00Z"));
    assert.ok(next! > now, "la primera ocurrencia es estrictamente posterior a now");
  });

  it("replay con misma key y mismo payload: mismo ID, replayed=true, una sola fila", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const first = ctl.createTrigger(command());
    const second = ctl.createTrigger(command());

    assert.strictEqual(first.replayed, false);
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.trigger.id, first.trigger.id);
    assert.strictEqual(countByKey(db, "alice", "key-1"), 1, "replay no crea segunda fila");
  });

  it("replay con distinto `now`: mismo ID y next_fire_at intacto", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const first = ctl.createTrigger(command({ now: ms("2024-03-29T08:00:00Z") }));
    const originalNext = first.trigger.nextFireAt;

    const replay = ctl.createTrigger(command({ now: ms("2024-03-30T07:00:00Z") }));

    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.trigger.id, first.trigger.id);
    assert.strictEqual(replay.trigger.nextFireAt, originalNext, "el replay no reprograma");
    assert.strictEqual(countByKey(db, "alice", "key-1"), 1);
  });

  it("misma key con payload distinto → IDEMPOTENCY_CONFLICT, no es replay ni segunda fila", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    ctl.createTrigger(command());

    const variants: CreateOverrides[] = [
      { definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "10:00" } },
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
    assert.strictEqual(countByKey(db, "alice", "key-1"), 1, "el conflicto no crea fila");
  });

  it("misma key en otro Agent crea otro Trigger: dos filas y IDs distintos", () => {
    const db = openMemoryDb();
    const ctl = control(db);
    const alice = ctl.createTrigger(command({ agentName: "alice", idempotencyKey: "key-comp" }));
    const bob = ctl.createTrigger(command({ agentName: "bob", idempotencyKey: "key-comp" }));

    assert.notStrictEqual(bob.trigger.id, alice.trigger.id);
    assert.strictEqual(bob.replayed, false);
    assert.strictEqual(countByKey(db, "alice", "key-comp"), 1);
    assert.strictEqual(countByKey(db, "bob", "key-comp"), 1);
    const total = db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number };
    assert.strictEqual(total.n, 2, "la misma key en Agents distintos son dos Triggers");
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
          version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00",
          days: ["mon", "wed"],
        },
      }),
    );
    const replay = ctl.createTrigger(
      command({
        definition: {
          version: 2, kind: "weekly", timeZone: "Europe/Madrid", at: "09:00",
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

    const snapshot = new AgendaRepository(db).projection.snapshotForAgent("alice", ms("2024-03-29T08:00:00Z"));
    assert.deepEqual(
      snapshot.triggers.map((t) => t.id),
      [trigger.id],
    );
  });
});
