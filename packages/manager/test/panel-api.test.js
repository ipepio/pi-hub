import test from "node:test";
import assert from "node:assert/strict";
import { createPanelApi, PanelApiError } from "../public/panel-api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("panel API construye lecturas versionadas sin filtrar CSRF en URL ni body", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-secreto",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({});
    },
  });

  await api.status();
  await api.listModels();
  await api.listAgents();
  await api.getAgent("linus");

  assert.deepEqual(requests.map((request) => request.url), [
    "/api/v1/status",
    "/api/v1/models",
    "/api/v1/agents",
    "/api/v1/agents/linus",
  ]);
  for (const { init } of requests) {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["X-CSRF-Token"], undefined);
  }
});

test("todas las mutaciones mandan X-CSRF-Token y no usan URLs legacy", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-real",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ packages: [], keys: [], providers: [] });
    },
  });

  await api.createAgent({ name: "linus" });
  await api.updateAgent("linus", { model: "anthropic/claude" });
  await api.startAgent("linus");
  await api.stopAgent("linus");
  await api.restartAgent("linus");
  await api.deleteAgent("linus");
  await api.setAgentEnv("linus", "KEY", "value");
  await api.removeAgentEnv("linus", "KEY");
  await api.installAgentPackage("linus", "npm:skill");
  await api.removeAgentPackage("linus", "npm:skill");
  await api.setGlobalEnv("KEY", "value");
  await api.removeGlobalEnv("KEY");
  await api.installGlobalPackage("npm:skill");
  await api.removeGlobalPackage("npm:skill");
  await api.oauth.startLogin("github");
  await api.oauth.submitFlowInput("flow-1", "code");
  await api.oauth.logout("github");

  assert.ok(requests.length > 0);
  for (const { url, init } of requests) {
    assert.match(url, /^\/api\/v1\//);
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.headers["X-CSRF-Token"], "csrf-real");
  }
  assert.equal(requests.find(({ url }) => url.endsWith("/agents"))?.init.body, JSON.stringify({ name: "linus" }));
});

test("DELETE de Agent acepta 204 y el cliente no exige un JSON", async () => {
  const api = createPanelApi({
    csrfToken: "csrf-real",
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  await assert.doesNotReject(() => api.deleteAgent("linus"));
});

test("401 y 403 conservan código, mensaje y la distinción para el caller", async () => {
  const responses = [
    jsonResponse({ code: "INVALID_AUTH", message: "Service credential required", correlationId: "corr-401" }, 401),
    jsonResponse({ code: "CSRF_INVALID", message: "CSRF token invalid", correlationId: "corr-403" }, 403),
  ];
  const api = createPanelApi({ fetchImpl: async () => responses.shift() });

  await assert.rejects(
    () => api.status(),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "INVALID_AUTH");
      assert.equal(error.correlationId, "corr-401");
      assert.equal(error.requiresLogin, true);
      assert.equal(error.isCsrfError, false);
      return true;
    },
  );
  await assert.rejects(
    () => api.setGlobalEnv("KEY", "value"),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "CSRF_INVALID");
      assert.equal(error.message, "CSRF token invalid");
      assert.equal(error.requiresLogin, false);
      assert.equal(error.isCsrfError, true);
      return true;
    },
  );
});

test("multipart usa la ruta versionada sin imponer Content-Type manual", async () => {
  let request;
  const api = createPanelApi({
    csrfToken: "csrf-real",
    fetchImpl: async (input, init = {}) => {
      request = { url: String(input), init };
      return jsonResponse({ path: "uploads/file.txt", name: "file.txt", size: 4, type: "text/plain" });
    },
  });

  await api.upload("linus", new Blob(["hola"], { type: "text/plain" }), "file.txt");

  assert.equal(request.url, "/api/v1/agents/linus/uploads");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["X-CSRF-Token"], "csrf-real");
  assert.equal(request.init.headers["content-type"], undefined);
});
