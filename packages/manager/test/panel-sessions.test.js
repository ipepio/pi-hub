// T7/3 (S2/S3) — transporte del catálogo de sesiones desde el panel.
//
// Qué fija este test: el panel deja de inventarse la sesión. Las tres operaciones
// hablan con el catálogo durable de T3 y nada más: las rutas son las de
// `/api/v1/agents/:name/sessions*`, cada segmento se escapa, las mutaciones llevan
// `X-CSRF-Token` y un envelope de error se convierte en `PanelApiError` con código
// y correlationId (el mismo contrato que `panel-api.js`, para que el panel pueda
// distinguir CSRF de un 404 o de un 500).

import test from "node:test";
import assert from "node:assert/strict";
import { createPanelSessions } from "../public/panel-sessions.js";
import { PanelApiError } from "../public/panel-api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CATALOGUE = {
  agent: "linus",
  sessions: [
    {
      id: "main",
      key: "agent:linus:main",
      channel: "web",
      agent: "linus",
      name: null,
      legacy: true,
      createdAt: "1970-01-01T00:00:00.000Z",
    },
    {
      id: "s-1",
      key: "agent:linus:session:1",
      channel: "web",
      agent: "linus",
      name: "Charla",
      legacy: false,
      createdAt: "2026-10-01T10:00:00.000Z",
    },
  ],
  selection: { web: "s-1", telegram: "main" },
};

function recorder(responses) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("fetch inesperado");
    return next;
  };
  return { requests, fetchImpl };
}

test("T7/3 sesiones: list es un GET versionado sin CSRF y devuelve el catálogo", async () => {
  const { requests, fetchImpl } = recorder([jsonResponse(CATALOGUE)]);
  const sessions = createPanelSessions({ fetchImpl, csrfToken: "csrf-real" });

  const body = await sessions.list("linus");

  assert.deepEqual(body, CATALOGUE);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, "/api/v1/agents/linus/sessions");
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.body, undefined);
  assert.equal(init.headers["X-CSRF-Token"], undefined);
  assert.equal(init.headers.accept, "application/json");
});

test("T7/3 sesiones: create manda POST con CSRF y sin sessionKey inventada", async () => {
  const { requests, fetchImpl } = recorder([
    jsonResponse({ id: "s-2", key: "agent:linus:session:2", channel: "web", agent: "linus", name: "Nueva", legacy: false, createdAt: "2026-10-02T09:00:00.000Z" }, 201),
    jsonResponse({ id: "s-3", key: "agent:linus:session:3", channel: "web", agent: "linus", name: null, legacy: false, createdAt: "2026-10-02T09:01:00.000Z" }, 201),
    jsonResponse({ id: "s-4", key: "agent:linus:session:4", channel: "web", agent: "linus", name: null, legacy: false, createdAt: "2026-10-02T09:02:00.000Z" }, 201),
  ]);
  const sessions = createPanelSessions({ fetchImpl, csrfToken: "csrf-real" });

  const named = await sessions.create("linus", { name: "Nueva" });
  const unnamed = await sessions.create("linus");
  const unnamedWithEmptyOptions = await sessions.create("linus", {});

  assert.equal(named.id, "s-2");
  assert.equal(unnamed.id, "s-3");
  assert.equal(unnamedWithEmptyOptions.id, "s-4");
  assert.equal(requests.length, 3);
  for (const { url, init } of requests) {
    assert.equal(url, "/api/v1/agents/linus/sessions");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.headers["X-CSRF-Token"], "csrf-real");
    assert.equal(init.headers["content-type"], "application/json");
  }
  assert.equal(requests[0].init.body, JSON.stringify({ name: "Nueva" }));
  assert.equal(requests[1].init.body, JSON.stringify({}), "sin nombre el body no inventa claves");
  assert.equal(requests[2].init.body, JSON.stringify({}));
});

test("T7/3 sesiones: select mueve la superficie web por la ruta del id", async () => {
  const { requests, fetchImpl } = recorder([
    jsonResponse({
      agent: "linus",
      channel: "web",
      session: { id: "s-1", key: "agent:linus:session:1", channel: "web", agent: "linus", name: "Charla", legacy: false, createdAt: "2026-10-01T10:00:00.000Z" },
    }),
  ]);
  const sessions = createPanelSessions({ fetchImpl, csrfToken: "csrf-real" });

  const body = await sessions.select("linus", "s-1");

  assert.equal(body.channel, "web");
  assert.equal(body.session.id, "s-1");
  const [{ url, init }] = requests;
  assert.equal(url, "/api/v1/agents/linus/sessions/s-1/select");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-CSRF-Token"], "csrf-real");
  assert.equal(init.body, JSON.stringify({ channel: "web" }));
});

test("T7/3 sesiones: cada segmento de la ruta se escapa, también el id", async () => {
  const { requests, fetchImpl } = recorder([
    jsonResponse({ agent: "lin/ux agente", sessions: [], selection: { web: null, telegram: null } }),
    jsonResponse({ agent: "lin/ux agente", channel: "web", session: { id: "a/b", key: "k", channel: "web", agent: "lin/ux agente", name: null, legacy: false, createdAt: "2026-10-01T10:00:00.000Z" } }),
  ]);
  const sessions = createPanelSessions({ fetchImpl, csrfToken: "csrf-real" });

  await sessions.list("lin/ux agente");
  await sessions.select("lin/ux agente", "a/b");

  assert.equal(requests[0].url, "/api/v1/agents/lin%2Fux%20agente/sessions");
  assert.equal(requests[1].url, "/api/v1/agents/lin%2Fux%20agente/sessions/a%2Fb/select");
});

test("T7/3 sesiones: un envelope de error se convierte en PanelApiError con código", async () => {
  const { fetchImpl } = recorder([
    jsonResponse({ code: "AGENT_NOT_FOUND", message: "Agent not found", correlationId: "corr-404" }, 404),
    jsonResponse({ code: "CSRF_INVALID", message: "CSRF token invalid", correlationId: "corr-403" }, 403),
    jsonResponse({ code: "SESSION_NOT_FOUND", message: "Session not found", correlationId: "corr-404b" }, 404),
  ]);
  const sessions = createPanelSessions({ fetchImpl, csrfToken: "csrf-real" });

  await assert.rejects(
    () => sessions.list("linus"),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "AGENT_NOT_FOUND");
      assert.equal(error.correlationId, "corr-404");
      return true;
    },
  );
  await assert.rejects(
    () => sessions.create("linus", { name: "Nueva" }),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.isCsrfError, true);
      return true;
    },
  );
  await assert.rejects(
    () => sessions.select("linus", "desconocida"),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.code, "SESSION_NOT_FOUND");
      return true;
    },
  );
});

test("T7/3 sesiones: setCsrfToken cambia el token de las mutaciones siguientes", async () => {
  const { requests, fetchImpl } = recorder([
    jsonResponse({ id: "s-2", key: "k", channel: "web", agent: "linus", name: null, legacy: false, createdAt: "2026-10-02T09:00:00.000Z" }, 201),
  ]);
  const sessions = createPanelSessions({ fetchImpl });

  sessions.setCsrfToken("csrf-nuevo");
  await sessions.create("linus");

  assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-nuevo");
});
