// Fase 2.4 — composición del arranque (§11 "Fase 2.4", §7.1 y §7.4 del plan de
// Fase 2).
//
// Se prueba la **composición**, no la recuperación en sí (esa es
// `agenda-recovery.test.ts`, §10.3 pasos 1-7): `runStartup` recibe fakes de
// Providers/provisión/repositorio/Supervisor y se afirma el orden
// `openManagerStore → initialize → provision → recover → startAll → serve`
// (§10.3) y que un `STARTUP_RECOVERY_FAILED` aborta antes de `startAll` y de
// `serve` (§7.4). No se importa ni se ejecuta `index.ts`.
//
// La recuperación se prueba con el repositorio real sobre `:memory:` (el seam
// del §3): el test compone el arranque con el `AgendaRepository` de verdad, de
// modo que el orden afirmado es el que corre en producción.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "../src/storage/sqlite.ts";
import { runMigrations } from "../src/storage/migrations.ts";
import { AgendaRepository } from "../src/agenda/index.ts";
import type { StartupRecoveryResult } from "../src/agenda/index.ts";
import { DomainError } from "../src/agenda/errors.ts";
import { runStartup, type StartupStore } from "../src/startup.ts";

const openDbs: SqliteDb[] = [];

/** Fixture de `:memory:` con el esquema aplicado (patrón `storage.test.ts:297`). */
function openMemoryDb(): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Siembra una Initiative `running` durable (setup, no comportamiento bajo prueba). */
function seedRunning(db: SqliteDb, id: string): void {
  db.prepare(
    `INSERT INTO initiatives
       (id, agent_name, state, origin, trigger_id, intent, mode, session_key,
        available_at, bound_model, turn_id, chain_depth, chain_deadline_at,
        visible_effects_declared, summary, ask_correlation, failure_reason,
        result, created_at, state_changed_at, started_at, finished_at)
     VALUES (?, 'alice', 'running', 'human', NULL, 'di hola', 'solo', 'sk-1', 1,
             'm', 't1', 0, NULL, 0, NULL, NULL, NULL, NULL, 1000, 1000, 1000, NULL)`,
  ).run(id);
}

/**
 * Fake de almacén que registra la llamada a la recuperación y delega en el
 * `AgendaRepository` real: la composición ejecuta el SQL de verdad (§7.2) en
 * su posición exacta, no un stub.
 */
function spyStore(repo: AgendaRepository, calls: string[]): StartupStore {
  return {
    agenda: {
      recoverRunningOnStartup(now: number): StartupRecoveryResult {
        calls.push("recover");
        return repo.recoverRunningOnStartup(now);
      },
    },
    close(): void {},
  };
}

describe("startup.ts — composición del arranque (Fase 2.4, §7)", () => {
  it("recupera antes de startAll y de serve, en el orden del §7.1", async () => {
    const db = openMemoryDb();
    const repo = new AgendaRepository(db);
    seedRunning(db, "r1"); // Initiative `running` durable de una ejecución anterior
    const calls: string[] = [];
    const store = spyStore(repo, calls);

    const runtime = await runStartup({
      openStore: async () => {
        calls.push("openStore");
        return store;
      },
      providers: {
        async initialize(): Promise<void> {
          calls.push("initialize");
        },
      },
      provision: async () => {
        calls.push("provision");
      },
      createSupervisor: () => {
        calls.push("createSupervisor");
        return {
          async startAll(): Promise<void> {
            calls.push("startAll");
          },
        };
      },
      createOAuth: () => {
        calls.push("createOAuth");
        return {};
      },
      createApp: ({ supervisor, oauth, providers }) => {
        calls.push("createApp");
        assert.ok(supervisor); // el Supervisor ya arrancado
        assert.ok(oauth);
        assert.ok(providers);
        return {};
      },
      serve: () => {
        calls.push("serve");
        return { close(): void {} };
      },
    });

    // La secuencia completa, en el orden que fija el plan (§7.1, §10.3).
    assert.deepEqual(calls, [
      "openStore",
      "initialize",
      "provision",
      "recover",
      "createSupervisor",
      "startAll",
      "createOAuth",
      "createApp",
      "serve",
    ]);
    // El orden crítico, explícito: recuperar → arrancar agentes → servir.
    assert.ok(calls.indexOf("recover") < calls.indexOf("startAll"));
    assert.ok(calls.indexOf("recover") < calls.indexOf("serve"));

    // La recuperación real corrió en posición: la `running` durable pasó a
    // failed con `failure_reason='startup_recovery'` (§7.2 paso 1, ADR 0007).
    assert.deepEqual(runtime.recovery.runningRecovered, ["r1"]);
    assert.equal(runtime.recovery.deadlineExpired, 0);
    const row = db.prepare("SELECT state, failure_reason FROM initiatives WHERE id = ?").get("r1") as {
      state: string;
      failure_reason: string | null;
    };
    assert.equal(row.state, "failed");
    assert.equal(row.failure_reason, "startup_recovery");

    // El `agenda` queda inyectable a través del store devuelto: las fases
    // posteriores lo consumirán desde aquí (sin consumidor todavía).
    assert.equal(runtime.store, store);
    assert.equal(typeof runtime.store.agenda.recoverRunningOnStartup, "function");
  });

  it("si la recuperación lanza STARTUP_RECOVERY_FAILED, ni startAll ni serve se ejecutan (§7.4)", async () => {
    const calls: string[] = [];
    const store: StartupStore = {
      agenda: {
        recoverRunningOnStartup(): StartupRecoveryResult {
          calls.push("recover");
          throw new DomainError("STARTUP_RECOVERY_FAILED", "fallo simulado de la recuperación (§7.4)");
        },
      },
      close(): void {},
    };

    await assert.rejects(
      runStartup({
        openStore: async () => {
          calls.push("openStore");
          return store;
        },
        providers: {
          async initialize(): Promise<void> {
            calls.push("initialize");
          },
        },
        provision: async () => {
          calls.push("provision");
        },
        createSupervisor: () => {
          calls.push("createSupervisor");
          return {
            async startAll(): Promise<void> {
              calls.push("startAll");
            },
          };
        },
        createOAuth: () => {
          calls.push("createOAuth");
          return {};
        },
        createApp: () => {
          calls.push("createApp");
          return {};
        },
        serve: () => {
          calls.push("serve");
          return { close(): void {} };
        },
      }),
      (err: unknown) => err instanceof DomainError && err.code === "STARTUP_RECOVERY_FAILED",
    );

    // Aborta sin arrancar agentes ni publicar HTTP: el Manager quedaría sin
    // Supervisor ni `serve`, y systemd reintentaría (§7.4).
    assert.deepEqual(calls, ["openStore", "initialize", "provision", "recover"]);
  });
});
