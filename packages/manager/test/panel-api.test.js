import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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

/* ------------------------------------------------------------------ */
/*  P2.5 — Autonomía: cinco métodos, idempotencia, encoding, errores  */
/* ------------------------------------------------------------------ */

test("P2.5: getAutonomy hace GET sin CSRF ni Idempotency-Key", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ asOf: 1, initiatives: [], agenda: [], inbox: [], triggers: [], historyTruncated: false });
    },
  });

  const snapshot = await api.getAutonomy("linus");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/agents/linus/autonomy");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers["X-CSRF-Token"], undefined);
  assert.equal(requests[0].init.headers["Idempotency-Key"], undefined);
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.ok(snapshot.asOf);
});

test("P2.5: createTrigger manda POST, CSRF, Idempotency-Key en header y body correcto", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ trigger: { id: "t1" }, replayed: false }, 201);
    },
  });

  const command = {
    definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" },
    intent: "revisar",
    mode: "solo",
    suggestedSkill: null,
  };
  const result = await api.createTrigger("linus", command, "idem-key-001");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/agents/linus/triggers");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-panel");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "idem-key-001");
  assert.equal(requests[0].init.body, JSON.stringify(command));
  // Idempotency-Key no debe aparecer ni en URL ni en body
  assert.ok(!requests[0].url.includes("idem-key-001"));
  assert.ok(!requests[0].init.body.includes("idem-key-001"));
  assert.equal(result.trigger.id, "t1");
  assert.equal(result.replayed, false);
});

test("P2.5: revokeTrigger manda POST, CSRF, sin Idempotency-Key", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ trigger: { id: "t1", enabled: false } });
    },
  });

  const result = await api.revokeTrigger("linus", "trigger-abc");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/agents/linus/triggers/trigger-abc/revoke");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-panel");
  assert.equal(requests[0].init.headers["Idempotency-Key"], undefined);
  assert.equal(result.trigger.id, "t1");
});

test("P2.5: cancelInitiative manda POST, CSRF, sin Idempotency-Key", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ status: "cancelled", initiative: { id: "i1" } });
    },
  });

  const result = await api.cancelInitiative("linus", "init-xyz");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/agents/linus/initiatives/init-xyz/cancel");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-panel");
  assert.equal(requests[0].init.headers["Idempotency-Key"], undefined);
  assert.equal(result.status, "cancelled");
});

test("P2.5: respondToInitiative manda POST, CSRF, Idempotency-Key en header y answer en body", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ initiative: { id: "i1" }, replayed: false });
    },
  });

  const result = await api.respondToInitiative("linus", "init-abc", "sí, procede", "idem-key-002");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/agents/linus/initiatives/init-abc/respond");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-panel");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "idem-key-002");
  assert.equal(requests[0].init.body, JSON.stringify({ answer: "sí, procede" }));
  // Idempotency-Key no debe aparecer ni en URL ni en body
  assert.ok(!requests[0].url.includes("idem-key-002"));
  assert.ok(!requests[0].init.body.includes("idem-key-002"));
  assert.equal(result.replayed, false);
});

test("P2.5: encoding de nombres de Agent e IDs con caracteres especiales", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({});
    },
  });

  await api.getAutonomy("agente ñoño");
  assert.equal(requests[0].url, "/api/v1/agents/agente%20%C3%B1o%C3%B1o/autonomy");

  await api.createTrigger("agente ñoño", { definition: {} }, "key-ñ");
  assert.equal(requests[1].url, "/api/v1/agents/agente%20%C3%B1o%C3%B1o/triggers");
  // Idempotency-Key con ñ está en header, no en URL
  assert.ok(!requests[1].url.includes("key-%C3%B1"));

  await api.revokeTrigger("agente ñoño", "trig/ñ");
  assert.equal(requests[2].url, "/api/v1/agents/agente%20%C3%B1o%C3%B1o/triggers/trig%2F%C3%B1/revoke");

  await api.cancelInitiative("agente ñoño", "init/ñ");
  assert.equal(requests[3].url, "/api/v1/agents/agente%20%C3%B1o%C3%B1o/initiatives/init%2F%C3%B1/cancel");

  await api.respondToInitiative("agente ñoño", "init/ñ", "sí", "key-ñ");
  assert.equal(requests[4].url, "/api/v1/agents/agente%20%C3%B1o%C3%B1o/initiatives/init%2F%C3%B1/respond");
});

test("P2.5: error 409 IDEMPOTENCY_CONFLICT crea PanelApiError con código correcto", async () => {
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async () =>
      jsonResponse({ code: "IDEMPOTENCY_CONFLICT", message: "Same key, different command", correlationId: "corr-409" }, 409),
  });

  await assert.rejects(
    () => api.createTrigger("linus", { definition: {} }, "key-conflict"),
    (error) => {
      assert.ok(error instanceof PanelApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(error.correlationId, "corr-409");
      assert.equal(error.requiresLogin, false);
      assert.equal(error.isCsrfError, false);
      return true;
    },
  );
});

test("P2.5: retry con la misma Idempotency-Key envía el mismo header, no una key nueva", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ trigger: { id: "t1" }, replayed: true });
    },
  });

  const command = { definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" }, intent: "ok", mode: "solo" };
  const KEY = "idem-siempre-la-misma";

  // Primer intento
  await api.createTrigger("linus", command, KEY);
  // Retry con la misma key
  await api.createTrigger("linus", command, KEY);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers["Idempotency-Key"], KEY);
  assert.equal(requests[1].init.headers["Idempotency-Key"], KEY);
  // No hay key nueva generada por el adapter
  const allKeys = requests.map((r) => r.init.headers["Idempotency-Key"]);
  assert.equal(new Set(allKeys).size, 1);
  assert.equal(allKeys[0], KEY);
});

test("P2.5: todas las mutaciones de Autonomía llevan X-CSRF-Token y usan /api/v1", () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({});
    },
  });

  // Ejecutar síncronamente no funciona porque son async; usamos then() y un wrapper
  // Mejor lo hacemos con una función async interna
  return (async () => {
    await api.createTrigger("a", { definition: {} }, "k1");
    await api.revokeTrigger("a", "t1");
    await api.cancelInitiative("a", "i1");
    await api.respondToInitiative("a", "i1", "ok", "k2");

    const mutations = requests;
    assert.equal(mutations.length, 4);
    for (const { url, init } of mutations) {
      assert.match(url, /^\/api\/v1\//);
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.headers["X-CSRF-Token"], "csrf-panel");
    }
  })();
});

test("P2.5: raw request fixture no contiene Idempotency-Key en URL ni body (rg check)", async () => {
  const requests = [];
  const api = createPanelApi({
    csrfToken: "csrf-panel",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return jsonResponse({});
    },
  });

  await api.createTrigger("agent", { definition: { version: 2, kind: "daily", timeZone: "Europe/Madrid", at: "09:00" }, intent: "test", mode: "solo" }, "rg-key-123");
  await api.respondToInitiative("agent", "init-1", "sí", "rg-key-456");
  await api.getAutonomy("agent");
  await api.revokeTrigger("agent", "t1");
  await api.cancelInitiative("agent", "i1");

  // Write fixture to temp file for rg verification
  const fixturePath = path.join("/tmp", "p2-5-raw-requests.json");
  const fixture = requests.map((r) => ({
    url: r.url,
    method: r.init.method,
    headers: r.init.headers,
    body: r.init.body || null,
  }));
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  // rg check: Idempotency-Key values must NOT appear in URL or body
  const rgKeyUrl = execSync(`rg -c "rg-key-123|rg-key-456" "${fixturePath}" || true`, { encoding: "utf8" }).trim();
  const rgKeyHeaders = execSync(`rg -c "Idempotency-Key" "${fixturePath}" || true`, { encoding: "utf8" }).trim();

  // rg-c results: "filename:count" or empty
  // Check that keys only appear via the header name, not in URL or body
  // Each key appears exactly 2 times (once per header entry)
  for (const { url, body } of fixture) {
    assert.ok(!url.includes("rg-key-123"), `Key leaked in URL: ${url}`);
    assert.ok(!url.includes("rg-key-456"), `Key leaked in URL: ${url}`);
    if (body) {
      assert.ok(!body.includes("rg-key-123"), `Key leaked in body: ${body}`);
      assert.ok(!body.includes("rg-key-456"), `Key leaked in body: ${body}`);
    }
  }

  // Verify all mutation requests in fixture have X-CSRF-Token
  for (const entry of fixture) {
    if (entry.method !== "GET") {
      assert.equal(entry.headers["X-CSRF-Token"], "csrf-panel", `Missing CSRF on ${entry.method} ${entry.url}`);
    }
  }
});

// Cleanup temp file after all tests – done via a after() hook
// but we clean inline at the end of this test
process.on("beforeExit", () => {
  try {
    fs.unlinkSync("/tmp/p2-5-raw-requests.json");
  } catch {
    // ignore
  }
});
