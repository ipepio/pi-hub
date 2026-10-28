// T4a — admisión HTTP: un turno ocupado responde 409 JSON ANTES de abrir el SSE.
//
// La ruta `POST /agents/:name/turns` es el adaptador fino del puente compartido
// (`TurnExecution.startTurn`). Este test la cruza de verdad: router REAL de
// `/api/v1`, ejecutor REAL inyectado (el mismo tipo que usa producción) y un
// `WebSocketServer` que hace de Runner en un puerto efímero.
//
// Las tres cosas que se prueban aquí y no en `agenda-turn-admission.test.ts`:
//   1. un rechazo por ocupado es `409 TURN_IN_PROGRESS` en JSON, no un `200`
//      con un stream vacío ni una excepción sin capturar;
//   2. la key de un turno RECHAZADO no queda recordada: el mismo caller puede
//      reintentar cuando el Agent quede libre y su turno ejecuta de verdad;
//   3. un replay con la key de un turno YA ACEPTADO sigue siendo idempotente
//      (PRESERVE: el comportamiento de la spec §5 no cambia).
//
// Los imports del router y del ejecutor vienen de `dist` (patrón de los suites
// de canales): el router comprueba `instanceof DomainError` contra la clase
// construida, así que el ejecutor inyectado tiene que ser la MISMA copia.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgentDirs, scaffoldGlobalDirs, writeAgent } from "@pihub/shared";
import { WebSocket, WebSocketServer } from "ws";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { TurnExecution } from "../dist/agenda/turn-execution.js";
import type { Supervisor } from "../src/supervisor.ts";

const dataDirs: string[] = [];
const runners: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of runners.splice(0)) await close();
  for (const dataDir of dataDirs.splice(0)) {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

interface RunnerHarness {
  readonly port: number;
  connections(): number;
  sessions(): string[];
  waitForSockets(count: number): Promise<void>;
  finishAll(): void;
  close(): Promise<void>;
}

async function startRunner(): Promise<RunnerHarness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const sockets: WebSocket[] = [];
  const sessions: string[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  server.on("connection", (socket, request) => {
    sockets.push(socket);
    const sessionKey = new URL(request.url ?? "/", "ws://runner").searchParams.get(
      "sessionKey",
    );
    sessions.push(sessionKey ?? "");
    socket.send(
      JSON.stringify({
        type: "ready",
        agent: "agent",
        sessionId: sessionKey,
        capabilities: ["prompt_context_v1", "ask_human_v1"],
      }),
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      // Acepta el prompt y no cierra: el test decide cuándo llega el terminal.
      if (message.type === "prompt") socket.send(JSON.stringify({ type: "agent_start" }));
    });
    for (const waiter of waiters.splice(0)) {
      if (sessions.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  runners.push(close);

  return {
    port: address.port,
    connections: () => sessions.length,
    sessions: () => [...sessions],
    waitForSockets: (count) =>
      new Promise<void>((resolve) => {
        if (sessions.length >= count) {
          resolve();
          return;
        }
        waiters.push({ count, resolve });
      }),
    finishAll: () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "agent_end" }));
        }
      }
    },
    close,
  };
}

async function setup(port: number) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-admission-"));
  dataDirs.push(dataDir);
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, "agent");
  await writeAgent(dataDir, {
    name: "agent",
    port,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const supervisor = {
    state: () => ({ state: "running", pid: 42 }),
    statusOf: async () => ({ state: "running", port, pid: 42 }),
  } as unknown as Supervisor;
  const turns = new TurnExecution({ apiToken: "service-token" });
  // `oauth` y `providers` no participan en esta ruta; el quinto argumento
  // inyecta el ejecutor compartido REAL (seam público confirmado por el usuario).
  const app = createApiV1Router(
    { dataDir, apiToken: "service-token" },
    supervisor,
    undefined as never,
    undefined as never,
    turns,
  );
  return { app, turns };
}

function turnRequest(
  app: ReturnType<typeof createApiV1Router>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("http://pihub.test/agents/agent/turns", {
    method: "POST",
    headers: { authorization: "Bearer service-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SseEvento {
  event: string;
  data: Record<string, unknown>;
}

async function readSse(response: Response): Promise<SseEvento[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "la respuesta debería traer un stream SSE");
  const decoder = new TextDecoder();
  const eventos: SseEvento[] = [];
  let pendiente = "";
  for (;;) {
    const read = await reader.read();
    if (read.value) pendiente += decoder.decode(read.value, { stream: !read.done });
    pendiente = pendiente.replace(/\r\n/g, "\n");
    let separador = pendiente.indexOf("\n\n");
    while (separador >= 0) {
      const bloque = pendiente.slice(0, separador);
      pendiente = pendiente.slice(separador + 2);
      separador = pendiente.indexOf("\n\n");
      const event = bloque.match(/^event: (.+)$/m)?.[1];
      const data = bloque.match(/^data: (.+)$/m)?.[1];
      if (event && data) eventos.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
    if (read.done) return eventos;
  }
}

describe("POST /agents/:name/turns con un turno vivo del mismo Agent (S2)", () => {
  it("responde 409 TURN_IN_PROGRESS en JSON antes de abrir el SSE", async () => {
    const runner = await startRunner();
    const { app } = await setup(runner.port);

    const primero = await turnRequest(app, {
      sessionKey: "sk-1",
      turnId: "turn-1",
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
      message: "hola",
    });
    assert.equal(primero.status, 200);
    await runner.waitForSockets(1);

    const segundo = await turnRequest(app, {
      sessionKey: "sk-2",
      turnId: "turn-2",
      idempotencyKey: "idem-2",
      correlationId: "corr-2",
      message: "hola",
    });
    assert.equal(segundo.status, 409, "un turno ocupado nunca abre un SSE 200");
    assert.match(segundo.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(
      ((await segundo.json()) as { code?: string }).code,
      "TURN_IN_PROGRESS",
      "el código es el del catálogo cerrado, no un texto",
    );
    assert.equal(runner.connections(), 1, "el rechazo no abre un segundo socket");
    assert.deepEqual(runner.sessions(), ["sk-1"]);

    // El turno admitido sigue siendo el único que ejecuta, y termina entero.
    runner.finishAll();
    assert.deepEqual((await readSse(primero)).at(-1), {
      event: "turn-complete",
      data: { turnId: "turn-1", totalTokens: 0 },
    });
  });

  it("la key rechazada por ocupado se puede reintentar tras el terminal", async () => {
    const runner = await startRunner();
    const { app } = await setup(runner.port);

    const primero = await turnRequest(app, {
      sessionKey: "sk-1",
      turnId: "turn-1",
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
      message: "hola",
    });
    await runner.waitForSockets(1);

    const rechazado = await turnRequest(app, {
      sessionKey: "sk-2",
      turnId: "turn-2",
      idempotencyKey: "idem-reintento",
      correlationId: "corr-2",
      message: "hola",
    });
    assert.equal(rechazado.status, 409);

    runner.finishAll();
    assert.equal((await readSse(primero)).at(-1)?.event, "turn-complete");

    const reintento = await turnRequest(app, {
      sessionKey: "sk-2",
      turnId: "turn-2",
      idempotencyKey: "idem-reintento",
      correlationId: "corr-2",
      message: "hola",
    });
    assert.equal(reintento.status, 200, "una key rechazada no queda envenenada");
    assert.match(reintento.headers.get("content-type") ?? "", /text\/event-stream/);

    await runner.waitForSockets(2);
    runner.finishAll();
    assert.deepEqual((await readSse(reintento)).at(-1), {
      event: "turn-complete",
      data: { turnId: "turn-2", totalTokens: 0 },
    });
    assert.deepEqual(runner.sessions(), ["sk-1", "sk-2"], "el reintento ejecutó de verdad");
  });

  it("un replay con la key de un turno aceptado sigue siendo idempotente", async () => {
    const runner = await startRunner();
    const { app } = await setup(runner.port);

    const primero = await turnRequest(app, {
      sessionKey: "sk-1",
      turnId: "turn-1",
      idempotencyKey: "idem-1",
      correlationId: "corr-1",
      message: "hola",
    });
    await runner.waitForSockets(1);
    runner.finishAll();
    await readSse(primero);

    const replay = await turnRequest(app, {
      sessionKey: "sk-1",
      turnId: "turn-otro",
      idempotencyKey: "idem-1",
      correlationId: "corr-replay",
      message: "hola",
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { turnId: "turn-1", duplicate: true });
    assert.equal(runner.connections(), 1, "un replay idempotente no abre un socket nuevo");
  });
});
