/*
 * Browser adapter for the Manager's versioned interface.
 *
 * panel.js knows product operations; this module knows HTTP, cookies, CSRF,
 * envelopes and the representation of each /api/v1 resource. There is
 * deliberately no generic legacy-path helper here.
 */

export class PanelApiError extends Error {
  constructor({ status, code, message, correlationId }) {
    super(message || `Manager request failed (${status})`);
    this.name = "PanelApiError";
    this.status = status;
    this.code = code || "INTERNAL_ERROR";
    this.correlationId = correlationId;
  }

  get requiresLogin() {
    return this.status === 401;
  }

  get isCsrfError() {
    return this.status === 403 || this.code === "CSRF_REQUIRED" || this.code === "CSRF_INVALID";
  }
}

export async function errorFromResponse(response) {
  const payload = await readResponseBody(response);
  return new PanelApiError({
    status: response.status,
    code: payload?.code || (response.status === 401 ? "INVALID_AUTH" : undefined),
    message: payload?.message || payload?.error || response.statusText,
    correlationId: payload?.correlationId,
  });
}

export function createPanelApi({ fetchImpl = globalThis.fetch, csrfToken = "" } = {}) {
  let currentCsrfToken = csrfToken;

  function setCsrfToken(token) {
    currentCsrfToken = token || "";
  }

  /** Only headers in this set are allowed through `extraHeaders`. Never Authorization. */
  const ALLOWLISTED_HEADERS = new Set(["Idempotency-Key"]);

  async function request(path, { method = "GET", body, formData = false, extraHeaders } = {}) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const headers = { accept: "application/json" };
    if (mutating) headers["X-CSRF-Token"] = currentCsrfToken;
    if (body !== undefined && !formData) headers["content-type"] = "application/json";
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (ALLOWLISTED_HEADERS.has(key)) {
          headers[key] = value;
        }
      }
    }

    const response = await fetchImpl(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : { body: formData ? body : JSON.stringify(body) }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    return readResponseBody(response);
  }

  const agentPath = (name, suffix = "") => `/api/v1/agents/${encodeURIComponent(name)}${suffix}`;

  const api = {
    setCsrfToken,

    status: () => request("/api/v1/status"),
    listModels: () => request("/api/v1/models"),
    listAgents: () => request("/api/v1/agents"),
    createAgent: (input) => request("/api/v1/agents", { method: "POST", body: input }),
    getAgent: (name) => request(agentPath(name)),
    updateAgent: (name, input) => request(agentPath(name), { method: "PATCH", body: input }),
    deleteAgent: (name) => request(agentPath(name), { method: "DELETE" }),
    startAgent: (name) => request(agentPath(name, "/start"), { method: "POST" }),
    stopAgent: (name) => request(agentPath(name, "/stop"), { method: "POST" }),
    restartAgent: (name) => request(agentPath(name, "/restart"), { method: "POST" }),
    abortTurn: (name, turnId) =>
      request(agentPath(name, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" }),

    listCommands: (name) => request(agentPath(name, "/commands")),
    upload: (name, file, filename) => {
      const form = new FormData();
      form.append("file", file, filename);
      return request(agentPath(name, "/uploads"), { method: "POST", body: form, formData: true });
    },
    transcribe: (name, blob, filename) => {
      const form = new FormData();
      form.append("file", blob, filename);
      return request(agentPath(name, "/transcribe"), { method: "POST", body: form, formData: true });
    },

    listAgentPackages: async (name) => (await request(agentPath(name, "/packages"))).packages || [],
    installAgentPackage: (name, source) =>
      request(agentPath(name, "/packages"), { method: "POST", body: { source } }),
    removeAgentPackage: (name, source) =>
      request(agentPath(name, "/packages"), { method: "DELETE", body: { source } }),
    listGlobalPackages: async () => (await request("/api/v1/packages")).packages || [],
    installGlobalPackage: (source) => request("/api/v1/packages", { method: "POST", body: { source } }),
    removeGlobalPackage: (source) => request("/api/v1/packages", { method: "DELETE", body: { source } }),

    listAgentEnv: async (name) => (await request(agentPath(name, "/env"))).keys || [],
    setAgentEnv: (name, key, value) =>
      request(agentPath(name, `/env/${encodeURIComponent(key)}`), { method: "PUT", body: { value } }),
    removeAgentEnv: (name, key) =>
      request(agentPath(name, `/env/${encodeURIComponent(key)}`), { method: "DELETE" }),
    listGlobalEnv: async () => (await request("/api/v1/env")).keys || [],
    setGlobalEnv: (key, value) =>
      request(`/api/v1/env/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),
    removeGlobalEnv: (key) => request(`/api/v1/env/${encodeURIComponent(key)}`, { method: "DELETE" }),

    getAutonomy: (name) => request(agentPath(name, "/autonomy")),

    createTrigger: (name, command, idempotencyKey) =>
      request(agentPath(name, "/triggers"), {
        method: "POST",
        body: command,
        extraHeaders: { "Idempotency-Key": idempotencyKey },
      }),

    revokeTrigger: (name, triggerId) =>
      request(agentPath(name, `/triggers/${encodeURIComponent(triggerId)}/revoke`), { method: "POST" }),

    cancelInitiative: (name, initiativeId) =>
      request(agentPath(name, `/initiatives/${encodeURIComponent(initiativeId)}/cancel`), { method: "POST" }),

    respondToInitiative: (name, initiativeId, answer, idempotencyKey) =>
      request(agentPath(name, `/initiatives/${encodeURIComponent(initiativeId)}/respond`), {
        method: "POST",
        body: { answer },
        extraHeaders: { "Idempotency-Key": idempotencyKey },
      }),

    oauth: {
      providers: () => request("/api/v1/auth/providers"),
      startLogin: (provider) => request(`/api/v1/auth/login/${encodeURIComponent(provider)}`, { method: "POST" }),
      getFlow: (id) => request(`/api/v1/auth/flows/${encodeURIComponent(id)}`),
      submitFlowInput: (id, value) =>
        request(`/api/v1/auth/flows/${encodeURIComponent(id)}/input`, { method: "POST", body: { value } }),
      logout: (provider) =>
        request(`/api/v1/auth/logout/${encodeURIComponent(provider)}`, { method: "POST" }),
    },
  };

  return api;
}

async function readResponseBody(response) {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
