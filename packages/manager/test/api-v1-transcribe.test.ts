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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-transcribe-"));
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

async function requestTranscription(
  port: number,
  dataDir: string,
): Promise<Response> {
  const app = createApiV1Router({ dataDir, apiToken: "service-token" }, runningSupervisor(port));
  const form = new FormData();
  form.append("file", new File(["audio"], "voice.webm", { type: "audio/webm" }));
  return app.request("http://pihub.test/agents/agent/transcribe", {
    method: "POST",
    headers: { authorization: "Bearer service-token" },
    body: form,
  });
}

test("POST /agents/:name/transcribe proxya multipart y devuelve el texto", async () => {
  const runner = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/transcribe");
    assert.equal(request.headers.authorization, "Bearer service-token");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.match(Buffer.concat(chunks).toString(), /filename="voice\.webm"/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: " hola " }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const response = await requestTranscription(port, dataDir);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: " hola " });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("transcribe conserva 501 cuando el STT no está configurado", async () => {
  const runner = createServer((_request, response) => {
    response.statusCode = 501;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "STT no configurado" }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const response = await requestTranscription(port, dataDir);
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error, "STT no configurado");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("transcribe traduce 413 a PAYLOAD_TOO_LARGE sin filtrar el body del Runner", async () => {
  const runner = createServer((_request, response) => {
    response.statusCode = 413;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Audio demasiado grande /data/runner" }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const response = await requestTranscription(port, dataDir);
    const rawText = await response.text();
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(rawText).code, "PAYLOAD_TOO_LARGE");
    assert.doesNotMatch(rawText, /Audio demasiado grande|\/data\/runner/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});

test("transcribe traduce el fallo del proveedor a VOICE_PROVIDER_ERROR", async () => {
  const runner = createServer((_request, response) => {
    response.statusCode = 502;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Provider secret /data/provider" }));
  });
  const port = await listen(runner);
  const dataDir = await setupAgent(port);

  try {
    const response = await requestTranscription(port, dataDir);
    const rawText = await response.text();
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(rawText).code, "VOICE_PROVIDER_ERROR");
    assert.doesNotMatch(rawText, /Provider secret|\/data\/provider/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await close(runner);
  }
});
