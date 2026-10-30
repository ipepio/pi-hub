// T3 (S2/S7) — el catálogo de sesiones sobre el router REAL de `/api/v1`.
//
// La suite hermana (`api-v1-sessions.test.ts`) monta las rutas de sesión sobre una
// `Hono` desnuda: verifica el catálogo, pero no puede afirmar nada sobre el guard
// que en producción las envuelve. Este fichero cubre las dos cosas que solo el
// router real puede fijar:
//
//   1. **Auth/CSRF heredados.** `registerSessionRoutes` se registra DENTRO de
//      `createApiV1Router`, después del guard dual Bearer/cookie, así que las tres
//      rutas de sesión se comportan como el resto de `/api/v1`: sin credencial 401
//      `MISSING_AUTH`, Bearer inválido 401 `INVALID_AUTH`, Bearer válido pasa, y la
//      cookie de panel lee pero no muta sin CSRF. Si alguien mueve el registro fuera
//      del guard, esto se pone rojo.
//   2. **Teardown de Agent.** `DELETE /agents/:name` vive en ese router. Hasta esta
//      unidad paraba canales y dreñaba el outbox, pero no tocaba el catálogo: un
//      Agent recreado con el mismo nombre heredaba historiales y selección. El
//      borrado ahora purga el catálogo de ESE Agent, con semántica de fallo explícita
//      y sin tocar a los Agents vecinos.
//
// Patrón de importación (el establecido en `api-v1-agent-delete-channels.test.ts`):
// router real desde `../dist` —requiere `npm run build --workspace @pihub/manager`—
// y almacén real (`openTestDb` + `openAgentSessionCatalogue`), nunca un mock ni SQL
// a mano en el test.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAgent,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
  type PihubEnv,
} from "@pihub/shared";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { createApiV1Router, type ApiV1ChannelDeps } from "../dist/api-v1/routes.js";
import { openAgentSessionCatalogue } from "../dist/sessions/persistence.js";
import type { AgentSessionCatalogue } from "../dist/sessions/catalogue.js";
import { openTestDb, type SqliteDb } from "../dist/storage/sqlite.js";

const API = "http://pihub.test";
const SERVICE_TOKEN = "service-token";
const CSRF_TOKEN = "csrf-real";

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

async function setup(...agentNames: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-sessions-router-"));
  dirs.push(dir);
  await scaffoldGlobalDirs(dir);
  for (const name of agentNames) await recreateAgent(dir, name);
  return dir;
}

/** Alta de un Agent por sus ficheros reales: es el fixture, no el objeto del test. */
async function recreateAgent(dir: string, name: string): Promise<void> {
  await scaffoldAgentDirs(dir, name);
  await writeAgent(dir, {
    name,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
}

function closeDb(db: SqliteDb): void {
  const index = dbs.indexOf(db);
  if (index >= 0) dbs.splice(index, 1);
  db.close();
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function idleSupervisor(): Supervisor {
  return {
    state: () => ({ state: "stopped" as never, pid: undefined }),
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    statusOf: async (config: { name: string }) => ({
      ...config,
      state: "stopped",
      port: 4100,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

function noLiveTurn(): TurnExecution {
  return {
    hasLiveTurnForAgent: () => false,
    hasAnyLiveTurn: () => false,
  } as unknown as TurnExecution;
}

interface Harness {
  app: ReturnType<typeof createApiV1Router>;
  db: SqliteDb;
  catalogue: AgentSessionCatalogue;
}

/** Router REAL con el almacén REAL: el guard, las rutas y el catálogo de producción. */
async function buildApp(dataDir: string): Promise<Harness> {
  const db = await openTestDb(dataDir);
  dbs.push(db);
  const catalogue = openAgentSessionCatalogue(db);
  const deps: ApiV1ChannelDeps = { sessions: catalogue };
  const app = createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN, panelEnabled: true } as unknown as PihubEnv,
    idleSupervisor(),
    undefined as unknown as OAuthService,
    undefined,
    noLiveTurn(),
    undefined,
    deps,
  );
  return { app, db, catalogue };
}

function send(
  app: Harness["app"],
  method: string,
  url: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${API}${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Petición servicio-a-servicio: el camino que usa el dashboard. */
function service(
  harness: Harness,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  return send(harness.app, method, url, {
    body,
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  });
}

interface SessionBody {
  id: string;
  key: string;
  channel: string;
  agent: string;
  name: string | null;
  legacy: boolean;
  createdAt: string;
}

interface CatalogueBody {
  agent: string;
  sessions: SessionBody[];
  selection: { web: string | null; telegram: string | null };
}

async function createSession(
  harness: Harness,
  agentName: string,
  body: Record<string, unknown> = {},
): Promise<SessionBody> {
  const response = await service(harness, "POST", `/agents/${agentName}/sessions`, body);
  assert.equal(response.status, 201, "fixture: la sesión se crea");
  return (await response.json()) as SessionBody;
}

async function catalogueOf(harness: Harness, agentName: string): Promise<CatalogueBody> {
  const response = await service(harness, "GET", `/agents/${agentName}/sessions`);
  assert.equal(response.status, 200, "fixture: el catálogo se lee");
  return (await response.json()) as CatalogueBody;
}

async function selectSession(
  harness: Harness,
  agentName: string,
  sessionId: string,
  channel: "web" | "telegram",
): Promise<void> {
  const response = await service(
    harness,
    "POST",
    `/agents/${agentName}/sessions/${sessionId}/select`,
    { channel },
  );
  assert.equal(response.status, 200, "fixture: la sesión se selecciona");
}

describe("guard real de /api/v1 sobre las rutas de sesión", () => {
  it("sin credencial rechaza las tres rutas con 401 MISSING_AUTH y sin efectos", async () => {
    const dataDir = await setup("agent");
    const handle = await buildApp(dataDir);

    const routes: Array<[string, string, string, unknown]> = [
      ["crear", "POST", "/agents/agent/sessions", {}],
      ["listar", "GET", "/agents/agent/sessions", undefined],
      ["seleccionar", "POST", "/agents/agent/sessions/main/select", { channel: "web" }],
    ];
    for (const [label, method, url, body] of routes) {
      const response = await send(handle.app, method, url, { body });
      assert.equal(response.status, 401, `${label}: status`);
      const envelope = (await response.json()) as { code: string };
      assert.equal(envelope.code, "MISSING_AUTH", `${label}: code`);
    }

    // El guard rechaza ANTES del handler: no se creó ni se adoptó nada con la
    // petición anónima. Solo la entrada legacy que materializa el GET autorizado.
    const catalogue = await catalogueOf(handle, "agent");
    assert.equal(catalogue.sessions.length, 1);
    assert.equal(catalogue.sessions[0]?.id, "main");
  });

  it("Bearer inválido responde 401 INVALID_AUTH, distinto de ausente", async () => {
    const dataDir = await setup("agent");
    const handle = await buildApp(dataDir);

    // La distinción es H01.02: el dashboard reacciona distinto a «no mandé
    // credencial» que a «mi credencial ya no vale».
    const response = await send(handle.app, "GET", "/agents/agent/sessions", {
      headers: { authorization: "Bearer otra-credencial" },
    });
    assert.equal(response.status, 401);
    const envelope = (await response.json()) as { code: string };
    assert.equal(envelope.code, "INVALID_AUTH");
  });

  it("Bearer válido atraviesa el guard: crear, listar y seleccionar funcionan", async () => {
    const dataDir = await setup("agent");
    const handle = await buildApp(dataDir);

    const created = await createSession(handle, "agent", { name: "desde servicio" });
    assert.equal(created.agent, "agent");
    const listed = await catalogueOf(handle, "agent");
    assert.ok(listed.sessions.some((row) => row.id === created.id));
    await selectSession(handle, "agent", created.id, "telegram");
    assert.deepEqual((await catalogueOf(handle, "agent")).selection, {
      web: "main",
      telegram: created.id,
    });
  });

  it("cookie de panel: lee, no muta sin CSRF y muta con CSRF y origen correctos", async () => {
    const dataDir = await setup("agent");
    const handle = await buildApp(dataDir);

    const cookie = `pihub_token=${SERVICE_TOKEN}`;
    const read = await send(handle.app, "GET", "/agents/agent/sessions", {
      headers: { cookie },
    });
    assert.equal(read.status, 200, "una lectura del panel no exige CSRF");

    const noCsrf = await send(handle.app, "POST", "/agents/agent/sessions", {
      body: {},
      headers: { cookie },
    });
    assert.equal(noCsrf.status, 403);
    const noCsrfEnvelope = (await noCsrf.json()) as { code: string };
    assert.equal(noCsrfEnvelope.code, "CSRF_REQUIRED");

    const withCsrf = await send(handle.app, "POST", "/agents/agent/sessions", {
      body: { name: "desde panel" },
      headers: {
        cookie: `${cookie}; pihub_csrf=${CSRF_TOKEN}`,
        "x-csrf-token": CSRF_TOKEN,
        origin: API,
      },
    });
    assert.equal(withCsrf.status, 201, "cookie + CSRF + mismo origen pasa el guard");

    // La petición sin CSRF no dejó sesión a medias.
    const catalogue = await catalogueOf(handle, "agent");
    assert.deepEqual(
        catalogue.sessions.map((row) => row.name).sort(),
        [null, "desde panel"].sort(),
      );
    });
});

describe("teardown del catálogo al borrar un Agent", () => {
  it("recrear el mismo Agent no hereda sesiones ni selección, y no toca a la vecina", async () => {
    const dataDir = await setup("agent", "vecina");
    const handle = await buildApp(dataDir);

    // Catálogo del Agent que se va a borrar: la legacy adoptada más dos sesiones, con
    // una selección explícita y distinta por superficie.
    const plan = await createSession(handle, "agent", { name: "plan" });
    const archivo = await createSession(handle, "agent", { name: "archivo" });
    await selectSession(handle, "agent", plan.id, "web");
    await selectSession(handle, "agent", archivo.id, "telegram");

    // Un vecino con su propio catálogo: el borrado debe ser POR Agent.
    const propia = await createSession(handle, "vecina", { name: "propia" });
    await selectSession(handle, "vecina", propia.id, "web");

    const deleted = await service(handle, "DELETE", "/agents/agent");
    assert.equal(deleted.status, 204);
    assert.equal(await readAgent(dataDir, "agent"), undefined, "el Agent se borró");

    // Recrear el MISMO nombre es un alta limpia: los ficheros son nuevos y el
    // catálogo anterior no puede sobrevivir en SQLite, que es el estado que `rm -rf`
    // del directorio no alcanza.
    await recreateAgent(dataDir, "agent");

    const recreated = await catalogueOf(handle, "agent");
    assert.deepEqual(
      recreated.sessions.map((row) => row.id),
      ["main"],
      "solo la entrada legacy adoptada: ninguna sesión del Agent anterior",
    );
    assert.equal(recreated.sessions[0]?.legacy, true);
    assert.deepEqual(recreated.selection, { web: "main", telegram: "main" });
    for (const stale of [plan.id, archivo.id]) {
      assert.equal(
        recreated.sessions.some((row) => row.id === stale),
        false,
        "una sesión del Agent borrado no reaparece",
      );
    }

    // La vecina conserva su catálogo y su selección: el borrado no fue global.
    const neighbour = await catalogueOf(handle, "vecina");
    assert.ok(
      neighbour.sessions.some((row) => row.id === propia.id),
      "la sesión de la vecina sigue ahí",
    );
    assert.equal(
      neighbour.sessions.some((row) => row.id === plan.id),
      false,
      "la vecina nunca vio la sesión ajena",
    );
    assert.deepEqual(neighbour.selection, { web: propia.id, telegram: "main" });
  });

  it("PRESERVE: sin catálogo compuesto, DELETE /agents/:name sigue respondiendo 204", async () => {
    const dataDir = await setup("agent");

    // Comportamiento previo de la ruta: los despliegues sin almacén durable (o los
    // tests que montan el router con deps pelados) no tienen catálogo que purgar. La
    // ausencia no puede volverse un 500: es «no hay nada más que borrar».
    const app = createApiV1Router(
      { dataDir, apiToken: SERVICE_TOKEN, panelEnabled: true } as unknown as PihubEnv,
      idleSupervisor(),
      undefined as unknown as OAuthService,
      undefined,
      noLiveTurn(),
    );

    const response = await send(app, "DELETE", "/agents/agent", {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    assert.equal(response.status, 204);
    assert.equal(await readAgent(dataDir, "agent"), undefined);
  });

  it("si la purga falla, responde 500, no borra el Agent y el reintento funciona", async () => {
    const dataDir = await setup("agent");
    const handle = await buildApp(dataDir);
    const persistente = await createSession(handle, "agent", { name: "persistente" });
    await selectSession(handle, "agent", persistente.id, "web");

    // Avería real, no un mock: el handle SQLite se cierra por debajo del catálogo, que
    // es el único modo en que esta purga puede fallar. El teardown de canales es
    // best-effort a propósito; el catálogo NO: si no se puede borrar, el Agent no se
    // borra, porque un Agent a medias dejaría el historial anterior disponible para el
    // siguiente que reutilice el nombre.
    closeDb(handle.db);

    const failed = await service(handle, "DELETE", "/agents/agent");
    assert.equal(failed.status, 500);
    const envelope = (await failed.json()) as { code: string };
    assert.equal(envelope.code, "INTERNAL_ERROR");
    assert.ok(await readAgent(dataDir, "agent"), "el Agent sigue existiendo para reintentar");

    // La base quedó intacta: un Manager nuevo (otro handle sobre la misma base) ve las
    // mismas sesiones y la misma selección que antes del intento fallido.
    const retry = await buildApp(dataDir);
    const afterFailure = await catalogueOf(retry, "agent");
    assert.equal(afterFailure.sessions.length, 2);
    assert.deepEqual(afterFailure.selection, {
      web: persistente.id,
      telegram: "main",
    });

    // Y el reintento completa el borrado.
    const deleted = await service(retry, "DELETE", "/agents/agent");
    assert.equal(deleted.status, 204);
    assert.equal(await readAgent(dataDir, "agent"), undefined);
  });
});
