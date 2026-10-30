import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentPaths,
  scaffoldAgentDirs,
  scaffoldGlobalDirs,
  writeAgent,
} from "@pihub/shared";
import type { ChannelAdapter } from "@pihub/channels";
import type { OAuthService } from "../src/oauth.ts";
import type { Supervisor } from "../src/supervisor.ts";
import type { TurnExecution } from "../src/agenda/turn-execution.ts";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { ChannelRuntimeRegistry } from "../dist/channels/registry.js";

// Slice (c) part 2a — the pairing routes and channel removal, on top of the
// part-1 GET/PUT surface:
//   POST   /agents/:name/channels/:kind/pairing   request a pairing (auto-pair
//          inside the window, code outside it) and, with `decision`, resolve a
//          pending request the way the design table freezes it
//   POST   /agents/:name/channels/:kind/approve   {code, externalChatId}
//   DELETE /agents/:name/channels/:kind           stop the adapter, drop the
//          record and its pairing state, restart decision by fingerprint
// Everything runs against an in-process router and a fake adapter factory: the
// whole pairing surface must be testable with zero network.
//
// Secret discipline under test: the plaintext code crosses the HTTP response
// only (the sender has to read it), never the disk; no route may echo a token.

const SERVICE_TOKEN = "service-token";
const CHANNEL_TOKEN = "771234:AA-secreto-de-bot-telegram";
const HOUR = 3_600_000;

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function futureWindow(): string {
  return new Date(Date.now() + HOUR).toISOString();
}

interface FakeAdapter extends ChannelAdapter {
  starts: Array<{ token: string }>;
  stopCount: number;
  sends: Array<{ chatId: string; text: string }>;
}

function createFakeSink() {
  const created: FakeAdapter[] = [];
  const adapterFactory = (): ChannelAdapter => {
    const adapter: FakeAdapter = {
      kind: "telegram",
      starts: [],
      stopCount: 0,
      sends: [],
      async start({ token }) {
        adapter.starts.push({ token });
      },
      async send({ chatId, text }) {
        adapter.sends.push({ chatId, text });
        return { messageId: `msg-${adapter.sends.length}` };
      },
      async stop() {
        adapter.stopCount += 1;
      },
    };
    created.push(adapter);
    return adapter;
  };
  return { created, adapterFactory };
}

async function setup(agentName = "agent") {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-api-v1-pairing-"),
  );
  await scaffoldGlobalDirs(dataDir);
  await scaffoldAgentDirs(dataDir, agentName);
  await writeAgent(dataDir, {
    name: agentName,
    port: 4100,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return dataDir;
}

function supervisorRecording(actions: string[], state = "running"): Supervisor {
  return {
    state: () => ({ state, pid: state === "running" ? 42 : undefined }),
    start: async () => {
      actions.push("start");
    },
    stop: async () => {
      actions.push("stop");
    },
    restart: async () => {
      actions.push("restart");
    },
    statusOf: async (config: { name: string }) => ({
      ...config,
      state,
      port: 4100,
      pid: 42,
      telegram: false,
    }),
  } as unknown as Supervisor;
}

function turnsWithLiveTurn(live: boolean): TurnExecution {
  return {
    hasLiveTurnForAgent: () => live,
    hasAnyLiveTurn: () => live,
  } as unknown as TurnExecution;
}

function router(
  dataDir: string,
  supervisor: Supervisor,
  deps: {
    adapterFactory: () => ChannelAdapter | undefined;
    registry?: ChannelRuntimeRegistry;
  },
  turns?: TurnExecution,
) {
  return createApiV1Router(
    { dataDir, apiToken: SERVICE_TOKEN },
    supervisor,
    undefined as unknown as OAuthService,
    undefined,
    turns,
    undefined,
    deps,
  );
}

/** `urlSuffix: ""` addresses the collection route `…/channels` itself. */
function call(
  app: ReturnType<typeof router>,
  method: string,
  urlSuffix: string,
  body?: unknown,
) {
  const url = urlSuffix
    ? `http://pihub.test/agents/agent/channels/${urlSuffix}`
    : "http://pihub.test/agents/agent/channels";
  return app.request(url, {
    method,
    headers:
      body === undefined
        ? { authorization: `Bearer ${SERVICE_TOKEN}` }
        : {
            authorization: `Bearer ${SERVICE_TOKEN}`,
            "content-type": "application/json",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readPairingFile(dataDir: string): Promise<string> {
  try {
    return await fs.readFile(
      path.join(agentPaths(dataDir, "agent").root, "channel-pairing.json"),
      "utf8",
    );
  } catch {
    return "";
  }
}

async function readChannelsFile(dataDir: string): Promise<string> {
  try {
    return await fs.readFile(
      path.join(agentPaths(dataDir, "agent").root, "channels.json"),
      "utf8",
    );
  } catch {
    return "";
  }
}

async function projectChannel(
  app: ReturnType<typeof router>,
  body: Record<string, unknown>,
) {
  return call(app, "PUT", "", { channels: [body] });
}

// --- auth and existence ------------------------------------------------------

test("POST pairing exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir, supervisorRecording([]), createFakeSink());
    const response = await app.request(
      "http://pihub.test/agents/agent/channels/telegram/pairing",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalChatId: "10001" }),
      },
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "MISSING_AUTH");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("las rutas de pairing de un Agent inexistente devuelven AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-pairing-"));
  try {
    const app = router(dataDir, supervisorRecording([]), createFakeSink());
    for (const [method, suffix, body] of [
      ["POST", "telegram/pairing", { externalChatId: "1" }],
      ["POST", "telegram/approve", { code: "ABCDEFGH", externalChatId: "1" }],
      ["DELETE", "telegram", undefined],
    ] as const) {
      const response = await app.request(
        `http://pihub.test/agents/no-existe/channels/${suffix}`,
        {
          method,
          headers: body
            ? {
                authorization: `Bearer ${SERVICE_TOKEN}`,
                "content-type": "application/json",
              }
            : { authorization: `Bearer ${SERVICE_TOKEN}` },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      assert.equal(response.status, 404, method);
      assert.equal((await response.json()).code, "AGENT_NOT_FOUND", method);
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST pairing rechaza un kind desconocido y un payload inválido", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir, supervisorRecording([]), createFakeSink());
    const badKind = await app.request(
      "http://pihub.test/agents/agent/channels/discord/pairing",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ externalChatId: "10001" }),
      },
    );
    assert.equal(badKind.status, 400);
    assert.equal((await badKind.json()).code, "BAD_REQUEST");

    const bodies: unknown[] = [
      {},
      { externalChatId: "" },
      { externalChatId: 10001 },
      { externalChatId: "10001", decision: "maybe" },
      { externalChatId: "10001", unexpected: true },
    ];
    for (const body of bodies) {
      const response = await call(app, "POST", "telegram/pairing", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).code, "BAD_REQUEST", JSON.stringify(body));
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST pairing sin canal proyectado es CHANNEL_NOT_FOUND", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir, supervisorRecording([]), createFakeSink());
    const response = await call(app, "POST", "telegram/pairing", {
      externalChatId: "10001",
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "CHANNEL_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- auto-pair window --------------------------------------------------------

test("POST pairing con la ventana abierta auto-vincula el chat y no emite código", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    const projected = await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: futureWindow(),
    });
    assert.equal(projected.status, 202);

    const response = await call(app, "POST", "telegram/pairing", {
      externalChatId: "10001",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.kind, "telegram");
    assert.equal(body.state, "active");
    assert.equal(body.externalChatId, "10001");
    assert.equal(body.code, undefined);

    // I1: nada de código ni token en disco; el chat vinculado sí se observa.
    const persisted = await readPairingFile(dataDir);
    assert.equal(persisted.includes(CHANNEL_TOKEN), false);
    assert.equal(persisted.includes('"token"'), false);
    assert.equal((await readChannelsFile(dataDir)).includes(CHANNEL_TOKEN), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST pairing con la ventana cerrada emite un código que no se persiste en claro", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });

    const response = await call(app, "POST", "telegram/pairing", {
      externalChatId: "10001",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "pending");
    assert.match(body.code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);

    const persisted = await readPairingFile(dataDir);
    assert.equal(persisted.includes(body.code), false, "el código en claro no toca disco");
    assert.equal(persisted.includes('"codeHash"'), true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- approval ----------------------------------------------------------------

test("POST approve con código correcto vincula; con código incorrecto es 403", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });
    const issued = await (
      await call(app, "POST", "telegram/pairing", { externalChatId: "10001" })
    ).json();

    const wrong = await call(app, "POST", "telegram/approve", {
      code: "ZZZZZZZZ",
      externalChatId: "10001",
    });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).code, "CHANNEL_PAIRING_CODE_INVALID");

    const ok = await call(app, "POST", "telegram/approve", {
      code: issued.code,
      externalChatId: "10001",
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.state, "active");
    assert.equal(body.externalChatId, "10001");

    // Single use: el mismo código ya no vuelve a aprobar.
    const replay = await call(app, "POST", "telegram/approve", {
      code: issued.code,
      externalChatId: "10001",
    });
    assert.equal(replay.status, 403);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST pairing con decision=reject descarta la solicitud pendiente", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });
    await call(app, "POST", "telegram/pairing", { externalChatId: "10001" });

    const rejected = await call(app, "POST", "telegram/pairing", {
      externalChatId: "10001",
      decision: "reject",
    });
    assert.equal(rejected.status, 200);
    const body = await rejected.json();
    assert.equal(body.state, "unpaired");
    assert.deepEqual(body.pendingChatIds, []);

    // El límite de 3 pidiendas por canal también se observa por HTTP.
    for (const chatId of ["20001", "20002", "20003"]) {
      const issued = await call(app, "POST", "telegram/pairing", { externalChatId: chatId });
      assert.equal(issued.status, 200);
    }
    const fourth = await call(app, "POST", "telegram/pairing", { externalChatId: "20004" });
    assert.equal(fourth.status, 409);
    assert.equal((await fourth.json()).code, "CHANNEL_PAIRING_LIMIT");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("POST pairing en un canal ya vinculado a otro chat no roba el vínculo", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });
    const issued = await (
      await call(app, "POST", "telegram/pairing", { externalChatId: "10001" })
    ).json();
    await call(app, "POST", "telegram/approve", {
      code: issued.code,
      externalChatId: "10001",
    });

    const thief = await call(app, "POST", "telegram/pairing", { externalChatId: "99999" });
    assert.equal(thief.status, 409);
    assert.equal((await thief.json()).code, "CHANNEL_ALREADY_BOUND");
    const still = await call(app, "POST", "telegram/pairing", { externalChatId: "10001" });
    assert.equal((await still.json()).state, "active");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- DELETE /agents/:name/channels/:kind -------------------------------------

test("DELETE detiene el adapter, borra el registro y su estado de pairing", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeSink();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: sink.adapterFactory });
    const projectApp = router(
      dataDir,
      supervisorRecording(actions),
      { adapterFactory: sink.adapterFactory, registry },
    );
    await projectChannel(projectApp, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });
    await call(projectApp, "POST", "telegram/pairing", { externalChatId: "10001" });
    actions.length = 0;

    const response = await call(projectApp, "DELETE", "telegram");
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.deepEqual(body.channels, []);
    assert.equal(sink.created[0].stopCount, 1, "adapter parado");
    assert.deepEqual(sink.created[0].sends, [], "sin despedida (I2)");
    assert.equal(await readChannelsFile(dataDir), "[]\n");
    assert.equal((await readPairingFile(dataDir)).includes("10001"), false);
    // Quitar el último canal cambia la huella: reinicio del Runner.
    assert.deepEqual(actions, ["restart"]);

    // El canal ya no existe: pairing lo vuelve a decir con CHANNEL_NOT_FOUND.
    const after = await call(projectApp, "POST", "telegram/pairing", {
      externalChatId: "10001",
    });
    assert.equal(after.status, 404);
    assert.equal((await after.json()).code, "CHANNEL_NOT_FOUND");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("DELETE de un kind sin canal es CHANNEL_NOT_FOUND y no reinicia", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording(actions), sink);
    const response = await call(app, "DELETE", "telegram");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "CHANNEL_NOT_FOUND");
    assert.deepEqual(actions, []);
    assert.equal(sink.created.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("DELETE con un turno en curso se rechaza con TURN_IN_PROGRESS sin tocar nada", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: sink.adapterFactory });
    const live = router(dataDir, supervisorRecording([]), {
      adapterFactory: sink.adapterFactory,
      registry,
    });
    await projectChannel(live, { kind: "telegram", token: CHANNEL_TOKEN });

    // Otro proceso del Manager ve el mismo registry persistido en disco.
    const guarded = router(
      dataDir,
      supervisorRecording([]),
      { adapterFactory: sink.adapterFactory, registry },
      turnsWithLiveTurn(true),
    );
    const response = await call(guarded, "DELETE", "telegram");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "TURN_IN_PROGRESS");
    assert.equal(sink.created[0].stopCount, 0, "el adapter sigue vivo");
    assert.equal((await readChannelsFile(dataDir)).includes("telegram"), true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- replace-all prunes pairing state ----------------------------------------

test("PUT replace-all que retira el canal borra también su estado de pairing", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: sink.adapterFactory });
    const app = router(dataDir, supervisorRecording([]), {
      adapterFactory: sink.adapterFactory,
      registry,
    });
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null,
    });
    await call(app, "POST", "telegram/pairing", { externalChatId: "10001" });
    assert.equal((await readPairingFile(dataDir)).includes("10001"), true);

    const response = await call(app, "PUT", "", { channels: [] });
    assert.equal(response.status, 202);
    assert.equal((await readPairingFile(dataDir)).includes("10001"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- GET /agents/:name (describe) — la superficie observada de canales ---------
//
// tasks c-I12: el Dashboard lee el estado de un Agent en UNA sola llamada. El
// describe proyecta el canal con la lista blanca observada — y el vínculo de
// pairing es la parte que `channels.json` no contiene: vive en la máquina de
// pairing, así que la ruta lo consulta allí, no en el registro de transporte.

test("GET /agents/:name refleja el vínculo de pairing en channels[]", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    const projected = await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: futureWindow(),
    });
    assert.equal(projected.status, 202);
    assert.equal(
      (await call(app, "POST", "telegram/pairing", { externalChatId: "10001" })).status,
      200,
    );

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const raw = await response.text();
    const body = JSON.parse(raw) as { channels: unknown };

    assert.equal(response.status, 200);
    const row = (body.channels as Array<Record<string, unknown>>)[0];
    assert.equal(row.kind, "telegram");
    assert.equal(row.pairingState, "active");
    assert.equal(row.externalChatId, "10001");
    assert.equal(row.observedStatus, "active");
    assert.equal(row.lastError, null);
    assert.equal(typeof row.lastSeenAt, "number");
    // La lista blanca es EXACTA: ningún campo extra (ni `tokenDigest`, ni `label`,
    // ni `pairedAt`) entra en el describe.
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "externalChatId",
        "kind",
        "lastError",
        "lastSeenAt",
        "observedStatus",
        "pairingState",
      ],
    );

    // El token nunca cruza la frontera: ni en claro ni como digest.
    assert.equal(raw.includes(CHANNEL_TOKEN), false);
    assert.doesNotMatch(raw, /tokenDigest/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET /agents/:name reporta pending en un canal vinculado pero sin aprobar", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeSink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await projectChannel(app, {
      kind: "telegram",
      token: CHANNEL_TOKEN,
      pairingWindowEndsAt: null, // ventana cerrada => emite código, no vincula
    });
    assert.equal(
      (await call(app, "POST", "telegram/pairing", { externalChatId: "10001" })).status,
      200,
    );

    const response = await app.request("http://pihub.test/agents/agent", {
      method: "GET",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const raw = await response.text();
    const body = JSON.parse(raw) as { channels: Array<Record<string, unknown>> };

    assert.equal(body.channels.length, 1);
    assert.equal(body.channels[0].pairingState, "pending");
    assert.equal(body.channels[0].externalChatId, null);
    // El chat pendiente NO se lista aquí: el describe da el estado, la lista de
    // solicitudes pendientes es de `…/channels` (pendingPairings[]).
    assert.equal(JSON.stringify(body.channels[0]).includes("10001"), false);
    assert.equal(raw.includes(CHANNEL_TOKEN), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
