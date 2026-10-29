import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { CompletedTurn, TurnExecution } from "../src/agenda/turn-execution.ts";
import { PairingMachine } from "../src/channels/pairing.ts";
import { writeChannelRecords, type ChannelRecord } from "../src/channels/store.ts";
import { ChannelDeliveryRouter, type EnqueueOutboxFn } from "../src/channels/delivery-router.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import * as exchangeLogModule from "../src/channels/exchange-log.ts";
import { ChannelExchangeLog } from "../src/channels/exchange-log.ts";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from "../src/storage/migrations.ts";
import { openManagerStore, openTestDb, type SqliteDb } from "../src/storage/sqlite.ts";

// T5a (ODD `agent-session-workspace`, S5 + S7) — the FULL transcript half of the
// projection-in mirror.
//
// The user settled the legacy question ("si, y recuerda documentar todo bien"):
// pre-existing dashboard rows are READ-ONLY honest history, and only NEW sessions
// promise resumability. That decision only holds if the mirror can tell the two
// apart, so schema v6 adds TWO nullable columns to `channel_exchanges`
// (`user_full_text`, `reply_full_text`) which are:
//
//   * written for every NEW row, bounded by the documented hard guard
//     `CHANNEL_FULL_TEXT_MAX_CHARS` (32,768 chars per half);
//   * left NULL for every row that existed before v6 (no backfill): a legacy row
//     is preview-only and the feed says so instead of pretending.
//
// What this file pins, in the order the reader should learn it:
//   1. the migration is additive (v6 columns nullable, rows survive v5 → v6);
//   2. a long exchange survives the roundtrip COMPLETE (the S5 promise);
//   3. a legacy row stays preview-only through the same public reader;
//   4. a retry (same `turn_id`) neither duplicates nor rewrites;
//   5. the mirror lives on disk: reopening the store keeps the text;
//   6. the guard is a documented HARD MAX, and the legacy columns keep exactly
//      today's semantics (complete halves) — the divergence is stated, not hidden;
//   7. the feed route exposes the full halves plus `hasFull`, and a legacy row is
//      byte-for-byte the row it always was;
//   8. nothing is mirrored without a real terminal turn (no fabrication).
//
// No test here reaches into SQLite to observe behaviour: DDL/`user_version` are
// inspected through the documented test fixture (`openTestDb`) and everything else
// goes through `ChannelExchangeLog`, `ManagerStore.channels` and the HTTP route.

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

const NOW = 1_761_100_800_000;
const SERVICE_TOKEN = "service-token";

/** A reply long enough that a preview-based mirror would visibly lose it. */
const LONG_REPLY = "Respuesta completa del Agent sobre el turno. ".repeat(60).padEnd(2_400, ".");
const LONG_USER_TEXT = "Mensaje largo del humano por Telegram. ".repeat(40).padEnd(1_700, ".");

async function dataDirOf(agentName = "agent"): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-full-transcript-"));
  dirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  await writeAgent(dataDir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function memoryDbAt(version: number): SqliteDb {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= version), version);
  dbs.push(db as unknown as SqliteDb);
  return db as unknown as SqliteDb;
}

/** The only way to build a row that predates v6 is to write it at v5: fixtures do it. */
function insertLegacyRow(db: SqliteDb, turnId = "turn-legacy"): void {
  db.prepare(
    `INSERT INTO channel_exchanges
       (agent_name, turn_id, origin, chat_id, user_text, reply_text, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("agent", turnId, "telegram", "12345", "hola legacy", "respuesta legacy", NOW);
}

async function logFor(dataDir: string): Promise<ChannelExchangeLog> {
  const db = await openTestDb(dataDir);
  dbs.push(db);
  return new ChannelExchangeLog(db);
}

function router(dataDir: string, deps: Record<string, unknown> = {}) {
  return createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN },
    {
      state: () => ({ state: "running", pid: 42 }),
      statusOf: async (config: { name: string }) => ({
        ...config,
        state: "running",
        port: 4100,
      }),
    } as unknown as Supervisor,
    undefined as unknown as OAuthService,
    undefined,
    { hasLiveTurnForAgent: () => false, hasAnyLiveTurn: () => false } as unknown as TurnExecution,
    undefined,
    deps,
  );
}

function get(app: ReturnType<typeof router>, url: string, token = SERVICE_TOKEN) {
  return app.request(`http://pihub.test${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test.afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

// --- 1. the migration is additive -------------------------------------------------

test("v6 añade las dos columnas full, NULLables y sin backfill", async () => {
  const dataDir = await dataDirOf();
  const db = await openTestDb(dataDir);
  dbs.push(db);

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  assert.equal(version, SCHEMA_VERSION, "una base nueva termina en el schema simbólico");
  assert.equal(MIGRATIONS.at(-1)?.version, SCHEMA_VERSION, "v7 es el último peldaño");

  const columns = (
    db.prepare("PRAGMA table_info(channel_exchanges)").all() as Array<{
      name: string;
      notnull: number;
    }>
  ).filter((column) => column.name === "user_full_text" || column.name === "reply_full_text");
  assert.deepEqual(
    columns.map((column) => column.name).sort(),
    ["reply_full_text", "user_full_text"],
    "las dos mitades se guardan por columnas distintas",
  );
  for (const column of columns) {
    assert.equal(column.notnull, 0, `${column.name} es NULLable: una fila legacy no tiene full text`);
  }
});

test("migrar v5 → v6 conserva las filas y las deja preview-only (sin backfill)", () => {
  const beforeV6 = MIGRATIONS.slice(0, -1);
  const previousVersion = beforeV6.at(-1)!.version;
  const db = memoryDbAt(previousVersion);
  insertLegacyRow(db, "turn-v5");

  runMigrations(db);

  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
  );
  const row = new ChannelExchangeLog(db).listAfter("agent", 0)[0];
  assert.equal(row?.turnId, "turn-v5", "la fila anterior a v6 sigue ahí");
  assert.equal(row?.userText, "hola legacy", "el texto legacy no se toca");
  assert.equal(row?.replyText, "respuesta legacy", "la respuesta legacy no se toca");
  assert.equal(row?.userFullText, null, "sin backfill: el full del humano queda desconocido");
  assert.equal(row?.replyFullText, null, "sin backfill: el full del Agent queda desconocido");
  assert.equal(row?.hasFull, false, "una fila legacy se anuncia preview-only");
});

// --- 2. a long exchange survives the roundtrip complete ---------------------------

test("un reply de más de 512 caracteres vuelve COMPLETO por el lector del espejo", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);

  const appended = log.append({
    agentName: "agent",
    turnId: "turn-largo",
    origin: "telegram",
    chatId: "12345",
    userText: LONG_USER_TEXT,
    replyText: LONG_REPLY,
    now: NOW,
  });

  assert.ok(LONG_REPLY.length > 512, `fixture: ${LONG_REPLY.length} caracteres`);
  assert.equal(appended.replyFullText, LONG_REPLY, "el append devuelve la mitad completa");
  assert.equal(appended.userFullText, LONG_USER_TEXT);
  assert.equal(appended.hasFull, true);

  const drained = log.listAfter("agent", 0)[0]!;
  assert.equal(drained.replyFullText, LONG_REPLY, "el feed entrega la respuesta entera");
  assert.equal(drained.userFullText, LONG_USER_TEXT, "y el mensaje del humano entero");
  assert.equal(drained.hasFull, true);
});

test("un intercambio proactivo deja el espejo completo con la mitad del humano vacía", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);

  log.append({
    agentName: "agent",
    turnId: "turn-proactivo",
    origin: "proactive",
    chatId: null,
    userText: "",
    replyText: LONG_REPLY,
    now: NOW,
  });

  const row = log.listAfter("agent", 0)[0]!;
  assert.equal(row.userFullText, "", "una mitad vacía es una mitad REAL, no ausencia");
  assert.equal(row.replyFullText, LONG_REPLY);
  assert.equal(row.hasFull, true);
});

// --- 3./4. retry and restart ------------------------------------------------------

test("un retry con el mismo turn_id no duplica fila ni reescribe el texto", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);

  log.append({
    agentName: "agent",
    turnId: "turn-retry",
    origin: "telegram",
    chatId: "12345",
    userText: "primero",
    replyText: "respuesta primera",
    now: NOW,
  });
  log.append({
    agentName: "agent",
    turnId: "turn-retry",
    origin: "telegram",
    chatId: "12345",
    userText: "segundo intento",
    replyText: "respuesta segunda",
    now: NOW + 1,
  });

  const rows = log.listAfter("agent", 0);
  assert.equal(rows.length, 1, "el turn_id es la clave: una fila por turno");
  assert.equal(rows[0]!.replyFullText, "respuesta primera", "el replay no reescribe el espejo");
  assert.equal(rows[0]!.userFullText, "primero");
});

test("el espejo vive en disco: reabrir el store conserva el texto completo", async () => {
  const dataDir = await dataDirOf();

  const first = await openManagerStore(dataDir);
  first.channels.exchanges.append({
    agentName: "agent",
    turnId: "turn-reinicio",
    origin: "telegram",
    chatId: "12345",
    userText: LONG_USER_TEXT,
    replyText: LONG_REPLY,
    now: NOW,
  });
  first.close();

  const second = await openManagerStore(dataDir);
  try {
    const row = second.channels.exchanges.listAfter("agent", 0)[0]!;
    assert.equal(row.replyFullText, LONG_REPLY, "el texto completo sobrevive al reinicio");
    assert.equal(row.userFullText, LONG_USER_TEXT);
    assert.equal(row.hasFull, true);
  } finally {
    second.close();
  }
});

// --- 5. the guard is a documented HARD MAX ---------------------------------------

test("el guard de 32.768 caracteres acota la columna full y deja el espejo intacto", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);

  assert.equal(
    exchangeLogModule.CHANNEL_FULL_TEXT_MAX_CHARS,
    32_768,
    "el techo documentado de una mitad",
  );
  const oversize = "x".repeat(32_768 + 1_000);

  const row = log.append({
    agentName: "agent",
    turnId: "turn-oversize",
    origin: "telegram",
    chatId: "12345",
    userText: oversize,
    replyText: oversize,
    now: NOW,
  });

  // Decisión documentada (docs/agent-sessions.md § Transcript persistence policy):
  // la columna FULL se acota en el techo duro; `hasFull` sigue siendo `true` porque
  // el contrato define "completo" HASTA ese techo explícito, no "arbitrariamente
  // largo". Las columnas históricas conservan su semántica de hoy (mitades
  // completas, sin recortes), así que nada de lo que ya dependía de ellas cambia.
  assert.equal(row.userFullText?.length, 32_768);
  assert.equal(row.replyFullText?.length, 32_768);
  assert.equal(row.hasFull, true, "el techo es parte del contrato, no una degradación silenciosa");
  assert.equal(row.userText.length, oversize.length, "user_text conserva su semántica de hoy");
  assert.equal(row.replyText.length, oversize.length);
  assert.equal(row.userFullText, oversize.slice(0, 32_768));
});

// --- 6. the feed route ------------------------------------------------------------

test("el feed devuelve las mitades completas y hasFull para una fila nueva", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);
  log.append({
    agentName: "agent",
    turnId: "turn-feed",
    origin: "telegram",
    chatId: "12345",
    userText: LONG_USER_TEXT,
    replyText: LONG_REPLY,
    now: NOW,
  });

  const response = await get(
    router(dataDir, { exchanges: log }),
    "/agents/agent/channel-exchanges?after=0",
  );
  assert.equal(response.status, 200);
  const [row] = (await response.json()).exchanges;
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "chatId",
      "createdAt",
      "hasFull",
      "origin",
      "replyFullText",
      "replyText",
      "seq",
      "sessionKey",
      "turnId",
      "userFullText",
      "userText",
    ],
    "la fila del feed es la de siempre MÁS el full text, su señal y la identidad del turno",
  );
  assert.equal(row.hasFull, true);
  assert.equal(row.userFullText, LONG_USER_TEXT);
  assert.equal(row.replyFullText, LONG_REPLY);
});

test("una fila legacy sigue siendo preview-only por el feed, con sus claves de siempre", async () => {
  const dataDir = await dataDirOf();
  // La fila se crea en v5 y se migra: es la única forma de tener una fila REAL
  // anterior a v6 (el `append` de hoy siempre escribe las columnas full). El peldaño
  // es LITERAL a propósito (T5b/2 movió el techo simbólico a v7): este caso prueba el
  // camino histórico v5→v6, no «el penúltimo peldaño», que dejaría de probarlo.
  const db = memoryDbAt(5);
  insertLegacyRow(db, "turn-legacy-feed");
  runMigrations(db);
  const log = new ChannelExchangeLog(db);

  const response = await get(
    router(dataDir, { exchanges: log }),
    "/agents/agent/channel-exchanges?after=0",
  );
  assert.equal(response.status, 200);
  const [row] = (await response.json()).exchanges;

  // PRESERVE: las claves y los valores que el Dashboard ya drenaba no cambian.
  assert.equal(row.turnId, "turn-legacy-feed");
  assert.equal(row.origin, "telegram");
  assert.equal(row.chatId, "12345");
  assert.equal(row.userText, "hola legacy");
  assert.equal(row.replyText, "respuesta legacy");
  assert.equal(row.createdAt, NOW);
  assert.equal(typeof row.seq, "number");

  // Y la señal honesta: la fila es preview-only, no una transcripción completa.
  assert.equal(row.hasFull, false);
  assert.equal(row.userFullText, null);
  assert.equal(row.replyFullText, null);
});

// --- 7. nothing is mirrored without a real terminal turn --------------------------

function channelRecord(): ChannelRecord {
  return {
    kind: "telegram",
    tokenDigest: "b".repeat(64),
    pairingWindowEndsAt: "2099-01-01T00:00:00.000Z",
    observedStatus: "active",
    lastSeenAt: NOW,
    updatedAt: NOW,
  };
}

async function boundRouter(dataDir: string, log: ChannelExchangeLog) {
  await writeChannelRecords(dataDir, "agent", [channelRecord()]);
  const pairing = new PairingMachine({ dataDir });
  await pairing.requestPairing("agent", "telegram", "12345");
  const delivered: string[] = [];
  const router = new ChannelDeliveryRouter({
    dataDir,
    pairing,
    exchanges: log,
    enqueue: ((input) => {
      delivered.push(input.target);
    }) satisfies EnqueueOutboxFn,
    now: () => NOW,
    log: () => {},
  });
  return { router, delivered };
}

function completedTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    agentName: "agent",
    turnId: "turn-real",
    origin: { kind: "channel", channelKind: "telegram", chatId: "12345" },
    finalEvent: "turn-complete",
    userText: "mensaje del humano",
    replyText: "respuesta del Agent",
    ...overrides,
  };
}

test("un turno abortado no escribe espejo: sin turno real no hay transcripción", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);
  const { router: delivery, delivered } = await boundRouter(dataDir, log);

  await delivery.onTurnCompletedAsync(completedTurn({ finalEvent: "turn-aborted" }));

  assert.deepEqual(log.listAfter("agent", 0), [], "un abort no es un intercambio");
  assert.deepEqual(delivered, [], "ni se entrega por el outbox");
});

test("un turno web (human) no escribe espejo: ese transcript lo posee el Dashboard", async () => {
  const dataDir = await dataDirOf();
  const log = await logFor(dataDir);
  const { router: delivery } = await boundRouter(dataDir, log);

  await delivery.onTurnCompletedAsync(
    completedTurn({ origin: { kind: "human" } as CompletedTurn["origin"] }),
  );

  assert.deepEqual(log.listAfter("agent", 0), [], "el espejo no fabrica un turno web");
});
