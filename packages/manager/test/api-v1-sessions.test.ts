// T3 (S2/S7) — catálogo durable de sesiones del Manager y selección por superficie.
//
// Qué fija esta suite, y por qué en este seam:
//   * El seam público es la API de sesiones del Manager (`POST/GET
//     /api/v1/agents/:name/sessions`, `POST …/sessions/:id/select`). El catálogo
//     durable es lo único que el dashboard/Telegram pueden observar, así que los
//     tests cruzan esa puerta y nunca el driver SQLite.
//   * El catálogo se abre con el mismo `openManagerStore` de producción y se
//     reabre sobre el MISMO `dataDir`: "sobrevive al reinicio" se prueba cerrando y
//     volviendo a abrir el store, no mirando filas por dentro.
//   * Se registran las rutas reales sobre una `Hono` app (mismo patrón que
//     `api-v1-autonomy.test.ts`) para que el runner enfocado no dependa de `dist`;
//     el guard de auth/CSRF sigue siendo el de `createApiV1Router`, que envuelve
//     este registro en producción y no cambia en esta unidad.
//
// Fuera de alcance aquí (y por eso NO se afirma): reanudación del contexto del
// Runner entre reinicios, admisión de un único turno cross-origin, transcript
// compartido y comandos de Telegram. Este unit solo entrega el catálogo
// persistente y su selección explícita.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  readAgent,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import { openManagerStore, type ManagerStore } from "../src/storage/sqlite.ts";
import { registerSessionRoutes } from "../src/sessions/routes.ts";

const API = "http://pihub.test";

/** Reloj fijo: `createdAt` deja de depender del instante de ejecución. */
const NOW = 1_790_000_000_000;

const tempDirs: string[] = [];
const openStores: ManagerStore[] = [];

interface OpenApp {
  app: Hono;
  store: ManagerStore;
}

async function setup(agentNames: string[] = ["agent"]): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-sessions-"));
  tempDirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  for (const name of agentNames) {
    await scaffoldAgentDirs(dataDir, name);
    await writeAgent(dataDir, {
      name,
      port: 4100,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  }
  return dataDir;
}

/**
 * Abre el catálogo REAL de producción (`openManagerStore`) y monta las rutas de
 * sesión tal y como las monta `createApiV1Router`: misma dependencia de
 * existencia del Agent (`readAgent`) y mismo reloj inyectable.
 */
async function open(dataDir: string): Promise<OpenApp> {
  const store = await openManagerStore(dataDir);
  openStores.push(store);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("correlationId", "test-correlation-id");
    c.set("principal", { kind: "service" });
    await next();
  });
  registerSessionRoutes(app, {
    agentExists: async (name) =>
      (await readAgent(dataDir, name).catch(() => undefined)) !== undefined,
    catalogue: () => store.sessions,
    now: () => NOW,
  });
  return { app, store };
}

function closeStore(store: ManagerStore): void {
  const index = openStores.indexOf(store);
  if (index >= 0) openStores.splice(index, 1);
  store.close();
}

/** Cierra y reabre el store sobre el mismo `dataDir` — el "reinicio" del Manager. */
async function reopen(opened: OpenApp, dataDir: string): Promise<OpenApp> {
  closeStore(opened.store);
  return open(dataDir);
}

function request(
  app: Hono,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.request(`${API}${url}`, init);
}

function post(app: Hono, url: string, body?: unknown): Promise<Response> {
  return request(app, "POST", url, body);
}

function get(app: Hono, url: string): Promise<Response> {
  return request(app, "GET", url);
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

describe("T3 — catálogo durable de sesiones (S2/S7)", () => {
  it("POST con el payload legacy persiste la sesión y sobrevive a reabrir el store", async () => {
    const dataDir = await setup();
    let opened = await open(dataDir);

    const created = await post(opened.app, "/agents/agent/sessions", {
      channel: "web",
      sessionKey: "clave-estable",
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      key: string;
      channel: string;
      agent: string;
      name: string | null;
      legacy: boolean;
      createdAt: string;
    };

    // Contrato legacy conservado: `key`, `channel`, `agent` y `createdAt` siguen
    // ahí con el mismo significado. `id`/`legacy`/`name` son aditivos.
    assert.equal(body.key, "clave-estable");
    assert.equal(body.channel, "web");
    assert.equal(body.agent, "agent");
    assert.equal(body.createdAt, new Date(NOW).toISOString());
    assert.equal(body.legacy, false);
    assert.equal(body.name, null);
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    opened = await reopen(opened, dataDir);

    const listed = await get(opened.app, "/agents/agent/sessions");
    assert.equal(listed.status, 200);
    const catalogue = (await listed.json()) as {
      agent: string;
      sessions: Array<{ id: string; key: string; legacy: boolean }>;
      selection: { web: string | null; telegram: string | null };
    };
    assert.equal(catalogue.agent, "agent");
    const found = catalogue.sessions.find((row) => row.key === "clave-estable");
    assert.ok(found, "la sesión sigue en el catálogo tras reabrir el store");
    assert.equal(found.id, body.id);
    assert.equal(found.legacy, false);
  });

  it("POST sin body genera una identidad persistente con la key namespaced por Agent", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const created = await post(opened.app, "/agents/agent/sessions");
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      key: string;
      channel: string;
      name: string | null;
      legacy: boolean;
    };

    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // La key generada lleva el Agent dentro: dos Agents no pueden compartir
    // contexto aunque generen ids parecidos.
    assert.equal(body.key, `agent:agent:session:${body.id}`);
    assert.equal(body.channel, "web");
    assert.equal(body.name, null);
    assert.equal(body.legacy, false);
  });

  it("POST acepta nombre y superficie de origen, y recorta el nombre", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const created = await post(opened.app, "/agents/agent/sessions", {
      channel: "telegram",
      name: "  Plan semanal  ",
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      channel: string;
      name: string;
      key: string;
    };
    assert.equal(body.channel, "telegram");
    assert.equal(body.name, "Plan semanal");
    assert.equal(body.key, `agent:agent:session:${body.id}`);
  });

  it("rechaza payloads inválidos sin crear ninguna sesión", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const invalid: Array<{ label: string; body: unknown }> = [
      { label: "superficie desconocida", body: { channel: "sms" } },
      { label: "key vacía", body: { sessionKey: "" } },
      { label: "key con espacios", body: { sessionKey: "clave con espacio" } },
      { label: "key demasiado larga", body: { sessionKey: "k".repeat(201) } },
      { label: "nombre en blanco", body: { name: "   " } },
      { label: "nombre demasiado largo", body: { name: "n".repeat(121) } },
      { label: "nombre con salto de línea", body: { name: "dos\nlíneas" } },
      { label: "JSON mal formado", body: "{" },
    ];

    for (const { label, body } of invalid) {
      const response = await post(opened.app, "/agents/agent/sessions", body);
      assert.equal(response.status, 400, `${label}: se esperaba 400`);
      const envelope = (await response.json()) as { code: string };
      assert.equal(envelope.code, "BAD_REQUEST", `${label}: código`);
    }

    // Ninguna sesión se creó: el catálogo solo tiene la entrada legacy adoptada.
    const listed = await get(opened.app, "/agents/agent/sessions");
    const catalogue = (await listed.json()) as {
      sessions: Array<{ id: string; legacy: boolean }>;
    };
    assert.equal(catalogue.sessions.length, 1, "solo la entrada legacy");
    assert.equal(catalogue.sessions[0]?.legacy, true);
  });

      it("acepta las keys legacy simples y rechaza separadores, traversal y el namespace de otro Agent", async () => {
        const dataDir = await setup(["agent", "otro"]);
        const opened = await open(dataDir);

        // POSITIVOS legacy: esto es lo que ya mandan los callers actuales (UUID de
        // Initiative, nombre simple, la key del propio runtime) y tiene que seguir
        // funcionando. Están en el mismo test que los rechazos para que nadie pueda
        // endurecer la regla de más sin que esto se ponga rojo.
        const legacyKeys = [
          "main",
          "3f2b8c1e-9a44-4c1f-9c1e-1d2a3b4c5d6e",
          "agent:agent:main",
          "Sesion_de_prueba.v2",
        ];
        for (const sessionKey of legacyKeys) {
          const response = await post(opened.app, "/agents/agent/sessions", {
            channel: "web",
            sessionKey,
          });
          assert.equal(response.status, 201, `${sessionKey}: se esperaba 201`);
          const body = (await response.json()) as { key: string };
          assert.equal(body.key, sessionKey);
        }

        // NEGATIVOS: la key se convierte en el nombre del directorio de sesión del
        // Runner y en el espacio de nombres de un Agent, así que lo que puede salirse
        // de ese directorio o pertenecer a otro Agent se rechaza aquí, en la puerta.
        const rejected: Array<[string, string]> = [
          ["barra", "sessions/otra"],
          ["barra inversa", "sessions\\\\otra"],
          ["traversal", "../../etc/passwd"],
          ["segmento de traversal", ".."],
          ["carácter de control", "clave\u0000nula"],
          ["namespace de otro Agent", "agent:otro:session:3f2b8c1e-9a44-4c1f-9c1e-1d2a3b4c5d6e"],
          ["main de otro Agent", "agent:otro:main"],
        ];
        for (const [label, sessionKey] of rejected) {
          const response = await post(opened.app, "/agents/agent/sessions", {
            sessionKey,
          });
          assert.equal(response.status, 400, `${label}: se esperaba 400`);
          const envelope = (await response.json()) as { code: string };
          assert.equal(envelope.code, "BAD_REQUEST", `${label}: código`);
        }

        // Ninguna key rechazada dejó fila: el catálogo es exactamente la entrada
        // legacy adoptada más las keys aceptadas (agent:agent:main ES esa entrada).
        const listed = (await (
          await get(opened.app, "/agents/agent/sessions")
        ).json()) as { sessions: Array<{ key: string }> };
        assert.deepEqual(
          listed.sessions.map((row) => row.key).sort(),
          ["Sesion_de_prueba.v2", "agent:agent:main", "main", legacyKeys[1]!].sort(),
        );
      });

      it("la adopción legacy tiene metadatos deterministas, no el instante de la primera lectura", async () => {
        const dataDir = await setup();
        const opened = await open(dataDir);

        // El `agent:<nombre>:main` existía ANTES del catálogo. Guardar `now` al
        // adoptarlo convertía «cuándo se leyó por primera vez» en «cuándo nació la
        // sesión»: dos bases distintas con el mismo pasado veían fechas distintas y un
        // reinicio con otro reloj lo movía de orden. El epoch es el marcador honesto
        // de «no sabemos cuándo nació» y es el mismo en cualquier Manager.
        const first = (await (
          await get(opened.app, "/agents/agent/sessions")
        ).json()) as {
          sessions: Array<{ id: string; legacy: boolean; createdAt: string }>;
        };
        assert.equal(first.sessions.length, 1);
        assert.equal(first.sessions[0]?.id, "main");
        assert.equal(first.sessions[0]?.legacy, true);
        assert.equal(first.sessions[0]?.createdAt, new Date(0).toISOString());
      });

      it("repetir el POST legacy devuelve la MISMA sesión, sin duplicar la key", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);
    const payload = { channel: "web", sessionKey: "clave-estable" };

    const first = (await (
      await post(opened.app, "/agents/agent/sessions", payload)
    ).json()) as { id: string; key: string; createdAt: string };
    const replay = await post(opened.app, "/agents/agent/sessions", payload);
    assert.equal(replay.status, 201);
    const second = (await replay.json()) as {
      id: string;
      key: string;
      createdAt: string;
    };

    // El reintento del caller legacy no abre un segundo contexto para la misma key:
    // mismo id y mismo createdAt — la fila original, no una copia.
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.key, "clave-estable");

    const listed = await get(opened.app, "/agents/agent/sessions");
    const catalogue = (await listed.json()) as {
      sessions: Array<{ id: string; key: string }>;
    };
    assert.equal(
      catalogue.sessions.filter((row) => row.key === "clave-estable").length,
      1,
      "una sola fila por key",
    );
  });

  it("la misma key con otra superficie de origen devuelve la sesión original", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const first = (await (
      await post(opened.app, "/agents/agent/sessions", {
        channel: "web",
        sessionKey: "clave-compartida",
      })
    ).json()) as { id: string; channel: string };
    const second = (await (
      await post(opened.app, "/agents/agent/sessions", {
        channel: "telegram",
        sessionKey: "clave-compartida",
      })
    ).json()) as { id: string; channel: string };

    // La key identifica el contexto; la superficie es metadato de origen y no se
    // reescribe en un replay (un contexto pertenece a una sola fila).
    assert.equal(second.id, first.id);
    assert.equal(second.channel, "web");
  });

  it("GET adopta el agent:<nombre>:main del runtime actual como entrada legacy estable", async () => {
    const dataDir = await setup();
    let opened = await open(dataDir);

    const first = await get(opened.app, "/agents/agent/sessions");
    assert.equal(first.status, 200);
    const catalogue = (await first.json()) as {
      agent: string;
      sessions: Array<{
        id: string;
        key: string;
        channel: string;
        name: string | null;
        legacy: boolean;
        createdAt: string;
      }>;
      selection: { web: string | null; telegram: string | null };
    };

    // Un Agent sin catálogo arranca con SU sesión principal: la que ya usan web y
    // Telegram, adoptada tal cual (no se crea ni se mueve nada en el Runner).
    assert.equal(catalogue.sessions.length, 1);
    const main = catalogue.sessions[0]!;
    assert.equal(main.id, "main");
    assert.equal(main.key, "agent:agent:main");
    assert.equal(main.legacy, true);
    assert.equal(main.name, null);
    // Metadato determinista: la sesión legacy ya existía, así que su fecha no es el
    // reloj de esta lectura (ver `LEGACY_CREATED_AT` en `sessions/catalogue.ts`).
    assert.equal(main.createdAt, new Date(0).toISOString());
    assert.deepEqual(catalogue.selection, { web: "main", telegram: "main" });

    // Leer de nuevo no añade filas ni mueve la selección: la adopción es idempotente.
    const second = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { sessions: unknown[]; selection: unknown };
    assert.equal(second.sessions.length, 1);
    assert.deepEqual(second.selection, { web: "main", telegram: "main" });

    // Y sobrevive al reinicio del Manager.
    opened = await reopen(opened, dataDir);
    const afterRestart = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { sessions: Array<{ id: string }>; selection: unknown };
    assert.equal(afterRestart.sessions.length, 1);
    assert.equal(afterRestart.sessions[0]?.id, "main");
    assert.deepEqual(afterRestart.selection, { web: "main", telegram: "main" });
  });

  it("la entrada legacy encabeza el catálogo y una sesión nueva no la desplaza", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const created = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "Nueva" })
    ).json()) as { id: string };
    const listed = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as {
      sessions: Array<{ id: string; legacy: boolean; name: string | null }>;
      selection: { web: string | null; telegram: string | null };
    };

    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.sessions[0]?.id, "main");
    assert.equal(listed.sessions[0]?.legacy, true);
    assert.equal(listed.sessions[1]?.id, created.id);
    assert.equal(listed.sessions[1]?.name, "Nueva");
    // Crear no cambia lo seleccionado: la conversación en curso sigue siendo main.
    assert.deepEqual(listed.selection, { web: "main", telegram: "main" });
  });

  it("select cambia SOLO la superficie indicada sobre un catálogo compartido", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    const web = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "web-a" })
    ).json()) as { id: string };
    const telegram = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "telegram-b" })
    ).json()) as { id: string };

    const selected = await post(
      opened.app,
      `/agents/agent/sessions/${web.id}/select`,
      { channel: "web" },
    );
    assert.equal(selected.status, 200);
    const selection = (await selected.json()) as {
      agent: string;
      channel: string;
      session: { id: string; key: string; name: string };
    };
    assert.equal(selection.agent, "agent");
    assert.equal(selection.channel, "web");
    assert.equal(selection.session.id, web.id);
    assert.equal(selection.session.name, "web-a");

    const afterWeb = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { selection: { web: string | null; telegram: string | null } };
    // Web elige A; Telegram sigue en la principal — selecciones independientes.
    assert.deepEqual(afterWeb.selection, { web: web.id, telegram: "main" });

    const telegramSelect = await post(
      opened.app,
      `/agents/agent/sessions/${telegram.id}/select`,
      { channel: "telegram" },
    );
    assert.equal(telegramSelect.status, 200);
    const afterTelegram = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { selection: { web: string | null; telegram: string | null } };
    assert.deepEqual(afterTelegram.selection, {
      web: web.id,
      telegram: telegram.id,
    });
  });

  it("seleccionar dos veces la misma sesión es idempotente", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);
    const created = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "repetida" })
    ).json()) as { id: string };

    const path = `/agents/agent/sessions/${created.id}/select`;
    const first = await post(opened.app, path, { channel: "web" });
    const second = await post(opened.app, path, { channel: "web" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const body = (await second.json()) as { session: { id: string } };
    assert.equal(body.session.id, created.id);
  });

  it("seleccionar la entrada legacy por su id es explícito y no crea otra fila", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);
    const created = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "otra" })
    ).json()) as { id: string };

    await post(opened.app, `/agents/agent/sessions/${created.id}/select`, {
      channel: "web",
    });
    const back = await post(opened.app, "/agents/agent/sessions/main/select", {
      channel: "web",
    });
    assert.equal(back.status, 200);

    const listed = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as {
      sessions: Array<{ id: string }>;
      selection: { web: string | null };
    };
    assert.equal(listed.selection.web, "main");
    assert.equal(listed.sessions.length, 2);
  });

  it("la selección sobrevive al reinicio del Manager", async () => {
    const dataDir = await setup();
    let opened = await open(dataDir);
    const created = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "persistente" })
    ).json()) as { id: string };
    await post(opened.app, `/agents/agent/sessions/${created.id}/select`, {
      channel: "telegram",
    });

    opened = await reopen(opened, dataDir);
    const listed = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { selection: { web: string | null; telegram: string | null } };
    assert.deepEqual(listed.selection, {
      web: "main",
      telegram: created.id,
    });
  });

  it("rechaza seleccionar un id inexistente o de OTRO Agent, sin tocar la selección", async () => {
    const dataDir = await setup(["agent", "otro"]);
    const opened = await open(dataDir);

    const mine = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "mía" })
    ).json()) as { id: string };
    const foreign = (await (
      await post(opened.app, "/agents/otro/sessions", { name: "ajena" })
    ).json()) as { id: string };

    for (const [label, id] of [
      ["inexistente", "no-existe"],
      ["de otro Agent", foreign.id],
    ] as const) {
      for (const channel of ["web", "telegram"] as const) {
        const response = await post(
          opened.app,
          `/agents/agent/sessions/${id}/select`,
          { channel },
        );
        assert.equal(response.status, 404, `${label}/${channel}: status`);
        const envelope = (await response.json()) as { code: string };
        assert.equal(envelope.code, "SESSION_NOT_FOUND", `${label}/${channel}: code`);
      }
    }

    // Ninguna superficie del Agent quedó apuntando a una sesión ajena o inventada.
    const listed = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as {
      sessions: Array<{ id: string }>;
      selection: { web: string | null; telegram: string | null };
    };
    assert.deepEqual(listed.selection, { web: "main", telegram: "main" });
    assert.equal(
      listed.sessions.some((row) => row.id === foreign.id),
      false,
      "la sesión de otro Agent no aparece en este catálogo",
    );
    assert.ok(mine.id);
  });

  it("rechaza un select sin superficie válida", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);
    const created = (await (
      await post(opened.app, "/agents/agent/sessions", { name: "x" })
    ).json()) as { id: string };
    const path = `/agents/agent/sessions/${created.id}/select`;

    for (const [label, body] of [
      ["sin body", undefined],
      ["canal desconocido", { channel: "sms" }],
      ["campo de más", { channel: "web", sessionKey: "otra" }],
    ] as const) {
      const response = await post(opened.app, path, body);
      assert.equal(response.status, 400, `${label}: status`);
      const envelope = (await response.json()) as { code: string };
      assert.equal(envelope.code, "BAD_REQUEST", `${label}: code`);
    }

    const listed = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { selection: { web: string | null } };
    assert.equal(listed.selection.web, "main", "ningún rejected tocó la selección");
  });

  it("el catálogo está scopeado por Agent: la misma key son dos sesiones distintas", async () => {
    const dataDir = await setup(["agent", "otro"]);
    const opened = await open(dataDir);

    const payload = { channel: "web", sessionKey: "compartida" };
    const mine = (await (
      await post(opened.app, "/agents/agent/sessions", payload)
    ).json()) as { id: string; key: string };
    const theirs = (await (
      await post(opened.app, "/agents/otro/sessions", payload)
    ).json()) as { id: string; key: string };

    // Misma key literal, dos identidades: la identidad durable es
    // `(agent, id)`, no la key suelta.
    assert.equal(mine.key, theirs.key);
    assert.notEqual(mine.id, theirs.id);

    const mineList = (await (
      await get(opened.app, "/agents/agent/sessions")
    ).json()) as { sessions: Array<{ id: string; key: string }> };
    const theirList = (await (
      await get(opened.app, "/agents/otro/sessions")
    ).json()) as { sessions: Array<{ id: string; key: string }> };

    assert.ok(mineList.sessions.some((row) => row.id === mine.id));
    assert.equal(
      mineList.sessions.some((row) => row.id === theirs.id),
      false,
      "el catálogo de un Agent no lista sesiones de otro",
    );
    assert.ok(theirList.sessions.some((row) => row.id === theirs.id));
    // Cada Agent adopta SU principal, no la del vecino.
    assert.ok(mineList.sessions.some((row) => row.key === "agent:agent:main"));
    assert.ok(theirList.sessions.some((row) => row.key === "agent:otro:main"));
  });

  it("PRESERVE: un Agent inexistente responde 404 antes de mirar el body", async () => {
    const dataDir = await setup();
    const opened = await open(dataDir);

    for (const [label, method, url, body] of [
      ["POST body válido", "POST", "/agents/no-existe/sessions", {
        channel: "web",
        sessionKey: "k",
      }],
      ["POST body inválido", "POST", "/agents/no-existe/sessions", { channel: "sms" }],
      ["GET catálogo", "GET", "/agents/no-existe/sessions", undefined],
      ["POST select", "POST", "/agents/no-existe/sessions/main/select", {
        channel: "web",
      }],
    ] as const) {
      const response = await request(opened.app, method, url, body);
      assert.equal(response.status, 404, `${label}: status`);
      const envelope = (await response.json()) as { code: string };
      assert.equal(envelope.code, "AGENT_NOT_FOUND", `${label}: code`);
    }
  });

  it("PRESERVE: sin almacén compuesto las rutas responden 503 y no inventan catálogo", async () => {
    const dataDir = await setup();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("correlationId", "test-correlation-id");
      c.set("principal", { kind: "service" });
      await next();
    });
    registerSessionRoutes(app, {
      agentExists: async (name) =>
        (await readAgent(dataDir, name).catch(() => undefined)) !== undefined,
      catalogue: () => undefined,
      now: () => NOW,
    });

    for (const [label, method, url, body] of [
      ["crear", "POST", "/agents/agent/sessions", {}],
      ["listar", "GET", "/agents/agent/sessions", undefined],
      ["seleccionar", "POST", "/agents/agent/sessions/main/select", { channel: "web" }],
    ] as const) {
      const response = await request(app, method, url, body);
      assert.equal(response.status, 503, `${label}: status`);
      const envelope = (await response.json()) as { code: string };
      assert.equal(envelope.code, "RESOURCE_UNAVAILABLE", `${label}: code`);
    }
  });
});
