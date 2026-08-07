import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { WebSocketServer } from "ws";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

// Bug 3: abortSignal está en createTurnV1Schema y nunca se lee — no hay
// forma de cortar un turno en curso desde /api/v1. El envío real del
// mensaje {type:"abort"} por el WS del Runner requiere un Runner de verdad
// (contract-red, contra el Manager real); estos dos casos —Agent
// inexistente y turno no vivo— no necesitan WS y se prueban aquí.

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-abort-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function fakeSupervisor(port = 4100): Supervisor {
  return {
    state: () => ({ state: "running", pid: 42 }),
    statusOf: async () => ({ state: "running", port, pid: 42 }),
  } as unknown as Supervisor;
}

test("POST /agents/:name/turns/:turnId/abort en un Agent inexistente da AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-abort-"));
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/no-existe/turns/turn-1/abort", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/turns/:turnId/abort de un turno que no está vivo da TURN_NOT_FOUND", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    // Ningún turno se registró como vivo: ni se creó por POST /turns, ni ya
    // terminó y se limpió del registro.
    const response = await app.request("http://pihub.test/agents/agent/turns/turn-fantasma/abort", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "TURN_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/turns rechaza un eventProfile desconocido", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent/turns?eventProfile=diagnostic", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: "session-1",
        turnId: "turn-1",
        idempotencyKey: "idem-1",
        correlationId: "corr-1",
        message: "hola",
      }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "BAD_REQUEST");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("un WS que muere después del abort sin agent_end publica turn-aborted", async () => {
  const dataDir = await setup();
  const runner = new WebSocketServer({ port: 0 });
  try {
    await new Promise<void>((resolve) => runner.once("listening", () => resolve()));
    const address = runner.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await writeAgent(dataDir, {
      name: "agent",
      port,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    runner.on("connection", (socket) => {
      // P3.1: enviar ready con capabilities para completar el handshake
      socket.send(JSON.stringify({ type: "ready", agent: "agent", sessionId: "test-session", capabilities: ["prompt_context_v1", "ask_human_v1"] }));
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
        if (message.type === "abort") socket.close();
      });
    });

    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor(port));
    const response = await app.request("http://pihub.test/agents/agent/turns", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionKey: "session-1",
        turnId: "turn-close-abort",
        idempotencyKey: "idem-close-abort",
        correlationId: "corr-close-abort",
        message: "hola",
      }),
    });
    assert.equal(response.status, 200);

    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let pending = "";
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let done = false;
    while (!done) {
      const read = await reader!.read();
      done = read.done;
      if (read.value) pending += decoder.decode(read.value, { stream: !done });
      pending = pending.replace(/\r\n/g, "\n");
      let separator = pending.indexOf("\n\n");
      while (separator >= 0) {
        const block = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        separator = pending.indexOf("\n\n");
        const eventName = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!eventName || !data) continue;
        const event = { event: eventName, data: JSON.parse(data) as Record<string, unknown> };
        events.push(event);
        if (event.event === "turn-start") {
          const abort = await app.request("http://pihub.test/agents/agent/turns/turn-close-abort/abort", {
            method: "POST",
            headers: { authorization: "Bearer service-token" },
          });
          assert.equal(abort.status, 202);
        }
      }
    }

    assert.deepEqual(events.at(-1), {
      event: "turn-aborted",
      data: { turnId: "turn-close-abort" },
    });
  } finally {
    await new Promise<void>((resolve) => runner.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /agents/:name/turns/:turnId/abort exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, fakeSupervisor());

    const response = await app.request("http://pihub.test/agents/agent/turns/turn-1/abort", {
      method: "POST",
    });

    assert.equal(response.status, 401);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
