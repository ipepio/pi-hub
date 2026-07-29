import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import type { Supervisor } from "../src/supervisor.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function setupAgent(port: number): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-uploads-"));
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function runningSupervisor(port: number): Supervisor {
  return {
    statusOf: async (config: { name: string; port: number }) => ({
      ...config,
      state: "running",
      port,
      pid: 42,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

test("POST /agents/:name/uploads reenvía el multipart y conserva un path relativo al workspace", async () => {
  const runner = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/upload");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.match(Buffer.concat(chunks).toString(), /filename="informe\.csv"/);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        path: "uploads/1234-informe.csv",
        name: "informe.csv",
        size: 8,
        type: "text/csv",
      }),
    );
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(port));
    const form = new FormData();
    form.append("file", new File(["contenido"], "informe.csv", { type: "text/csv" }));

    const response = await app.request("http://pihub.test/agents/agent/uploads", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
      body: form,
    });
    const rawText = await response.text();
    assert.equal(response.status, 200, `la ruta todavía no existe: ${response.status} ${rawText}`);
    const body = JSON.parse(rawText) as Record<string, unknown>;

    assert.deepEqual(body, {
      path: "uploads/1234-informe.csv",
      name: "informe.csv",
      size: 8,
      type: "text/csv",
    });
    assert.match(String(body.path), /^uploads\/[0-9]+-informe\.csv$/);
    assert.doesNotMatch(String(body.path), /^\//);
    assert.doesNotMatch(rawText, /\/data\b/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("un 413 del Runner se traduce a BAD_REQUEST sin filtrar su body", async () => {
  const runner = createServer((_request, response) => {
    response.statusCode = 413;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Archivo demasiado grande (máx. 50 MB) /data/runner" }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(port));
    const form = new FormData();
    form.append("file", new File(["contenido"], "grande.csv", { type: "text/csv" }));

    const response = await app.request("http://pihub.test/agents/agent/uploads", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
      body: form,
    });
    const rawText = await response.text();
    assert.equal(response.status, 400, `el error no se tradujo: ${rawText}`);
    const body = JSON.parse(rawText) as { code?: string; message?: string };

    assert.equal(body.code, "BAD_REQUEST");
    assert.equal(body.message, "File too large");
    assert.doesNotMatch(rawText, /Archivo demasiado grande|\/data\/runner/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("un Agent inexistente se resuelve antes de leer el multipart", async () => {
  const dataDir = await setupAgent(4100);
  try {
    const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(4100));
    const response = await app.request("http://pihub.test/agents/no-existe/uploads", {
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "content-type": "multipart/form-data; boundary=not-read",
      },
      body: "este body no es multipart valido",
    });
    const rawText = await response.text();
    assert.equal(response.status, 404, `respuesta actual: ${rawText}`);
    let body: { code?: string } = {};
    try {
      body = JSON.parse(rawText) as { code?: string };
    } catch {
      // Antes de implementar la ruta, Hono devuelve un 404 plano.
    }
    assert.equal(body.code, "AGENT_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
