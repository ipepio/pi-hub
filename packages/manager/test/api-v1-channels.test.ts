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
import { createApi } from "../dist/api.js";
import { createApiV1Router } from "../dist/api-v1/routes.js";
import { ChannelRuntimeRegistry } from "../dist/channels/registry.js";
import type { PihubEnv } from "@pihub/shared";
import type { RuntimeProviders } from "@pihub/providers";

// Slice (c) part 1: the Manager owns the ChannelAdapter lifecycle, so
// GET/PUT /agents/:name/channels is the only place a channel token can enter
// pihub. These tests pin the three invariants of the change on the P side:
//   I1 — the fingerprint moves on a token digest, never on plaintext, and no
//        plaintext token is ever written to disk or echoed in a response;
//   I2 — PUT with `[]` stops every adapter and clears the state (replace-all,
//        never "undefined means keep");
//   I3 — an adapter failure is OBSERVED (`observedStatus: "error"`), it does
//        not turn into a fake desired state and does not leak the token.
// Pairing and the outbox are part 2: nothing here may require them.
//
// Contract alignment (slice (c)): the D→P projection is exactly
// `{kind, label?, token?, tokenDigest?, pairingWindowEndsAt?}` — `sessionKey`
// and `status` are gone (the Manager resolves the Agent main session and owns
// pairing state), a channel with no secret OMITS both token fields, and
// `pairingWindowEndsAt: null` means the auto-pair window is CLOSED.

const SERVICE_TOKEN = "service-token";
const CHANNEL_TOKEN = "771234:AA-secreto-de-bot-telegram";
const OTHER_TOKEN = "771234:AA-otro-secreto-de-bot";

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface FakeAdapter extends ChannelAdapter {
  starts: Array<{ token: string }>;
  stopCount: number;
  sends: Array<{ chatId: string; text: string }>;
  failStart?: Error;
}

function createFakeRegistrySink() {
  const created: FakeAdapter[] = [];
  const control: { failNextStart?: Error } = {};
  const adapterFactory = (): ChannelAdapter => {
    const adapter: FakeAdapter = {
      kind: "telegram",
      starts: [],
      stopCount: 0,
      sends: [],
      async start({ token }) {
        if (adapter.failStart) throw adapter.failStart;
        if (control.failNextStart) throw control.failNextStart;
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
  return { created, adapterFactory, control };
}

async function setup(agentName = "agent") {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-api-v1-channels-"),
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

/** Only `hasLiveTurnForAgent` is read by the channel routes. */
function turnsWithLiveTurn(live: boolean): TurnExecution {
  return {
    hasLiveTurnForAgent: () => live,
    hasAnyLiveTurn: () => live,
  } as unknown as TurnExecution;
}

function router(
  dataDir: string,
  supervisor: Supervisor,
  deps: { adapterFactory: () => ChannelAdapter | undefined },
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

function request(app: ReturnType<typeof router>, method: string, body?: unknown) {
  return app.request(`http://pihub.test/agents/agent/channels`, {
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

async function channelsFile(dataDir: string): Promise<string> {
  try {
    return await fs.readFile(
      path.join(agentPaths(dataDir, "agent").root, "channels.json"),
      "utf8",
    );
  } catch {
    return "";
  }
}

// --- auth / existence -------------------------------------------------------

test("GET /agents/:name/channels exige la credencial de servicio", async () => {
  const dataDir = await setup();
  try {
    const app = router(dataDir, supervisorRecording([]), createFakeRegistrySink());
    const response = await app.request("http://pihub.test/agents/agent/channels", {
      method: "GET",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "MISSING_AUTH");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET y PUT de un Agent inexistente devuelven AGENT_NOT_FOUND", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-api-v1-channels-"));
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);
    const get = await app.request("http://pihub.test/agents/no-existe/channels", {
      method: "GET",
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const put = await app.request("http://pihub.test/agents/no-existe/channels", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channels: [] }),
    });
    assert.equal(get.status, 404);
    assert.equal((await get.json()).code, "AGENT_NOT_FOUND");
    assert.equal(put.status, 404);
    assert.equal((await put.json()).code, "AGENT_NOT_FOUND");
    assert.equal(sink.created.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- payload validation -----------------------------------------------------

test("PUT rechaza payloads sin el conjunto completo, kinds desconocidos, duplicados y campos extra", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording(actions), sink);

    const bodies: unknown[] = [
      {},
      { channels: "telegram" },
      { channels: [{ kind: "discord" }] },
      { channels: [{ kind: "telegram" }, { kind: "telegram" }] },
      { channels: [{ kind: "telegram", token: "x", unexpected: true }] },
      // `token: ""` no es «sin credencial»: el contrato la expresa OMITIENDO
      // el campo, y `min(1)` sigue vigente para el token que sí llega.
      { channels: [{ kind: "telegram", token: "" }] },
      { channels: [{ kind: "telegram", tokenDigest: "" }] },
      // sessionKey y status NO forman parte del contrato D→P: la sesión la
      // resuelve el Manager (sesión unificada) y el estado de pairing es
      // observable suyo — recibirlos aquí sería aceptar un segundo amo.
      { channels: [{ kind: "telegram", sessionKey: "agent:telegram:1" }] },
      { channels: [{ kind: "telegram", status: "active" }] },
      {
        channels: [
          { kind: "telegram", token: CHANNEL_TOKEN, status: "unpaired" },
        ],
      },
      // pairingWindowEndsAt solo admite ISO 8601 o null (null = ventana cerrada).
      { channels: [{ kind: "telegram", pairingWindowEndsAt: "mañana" }] },
      { channels: [{ kind: "telegram", pairingWindowEndsAt: 1_761_100_800_000 }] },
    ];
    for (const body of bodies) {
      const response = await request(app, "PUT", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).code, "BAD_REQUEST");
    }
    assert.equal(sink.created.length, 0);
    assert.deepEqual(actions, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT acepta la forma exacta del contrato: cinco campos y ventana de auto-pair abierta", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);

    const response = await request(app, "PUT", {
      channels: [
        {
          kind: "telegram",
          label: "personal",
          token: CHANNEL_TOKEN,
          tokenDigest: digestOf(CHANNEL_TOKEN),
          pairingWindowEndsAt: "2026-10-22T11:00:00.000Z",
        },
      ],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels.length, 1);
    assert.equal(body.channels[0].pairingWindowEndsAt, "2026-10-22T11:00:00.000Z");
    assert.equal(body.channels[0].observedStatus, "active");
    assert.deepEqual(sink.created[0].starts, [{ token: CHANNEL_TOKEN }]);
    // I1: la ventana viaja al disco, el token en claro no.
    const persisted = await channelsFile(dataDir);
    assert.equal(persisted.includes("2026-10-22T11:00:00.000Z"), true);
    assert.equal(persisted.includes(CHANNEL_TOKEN), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT con pairingWindowEndsAt null se acepta: null = ventana CERRADA (tombstone H4)", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);

    // Canal sin credencial: token y tokenDigest se OMITEN, nunca van a "".
    const closed = await request(app, "PUT", {
      channels: [{ kind: "telegram", pairingWindowEndsAt: null }],
    });
    assert.equal(closed.status, 202);
    const closedBody = await closed.json();
    assert.equal(closedBody.channels[0].pairingWindowEndsAt, null);
    assert.equal(closedBody.channels[0].observedStatus, "unpaired");
    assert.equal(closedBody.channels[0].tokenDigest, undefined);
    assert.equal(sink.created.length, 0, "sin credencial no arranca ningún adapter");

    // Campo ausente = mismo significado (cerrado): la proyección es opcional.
    const absent = await request(app, "PUT", {
      channels: [{ kind: "telegram" }],
    });
    assert.equal(absent.status, 202);
    const absentBody = await absent.json();
    assert.equal(absentBody.channels[0].pairingWindowEndsAt, undefined);

    const get = await request(app, "GET");
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.channels[0].pairingWindowEndsAt, undefined);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- replace-all lifecycle --------------------------------------------------

test("PUT configura el canal: arranca el adapter con el token y reporta la superficie observada", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording(actions), sink);

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", label: "personal", token: CHANNEL_TOKEN }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels.length, 1);
    assert.deepEqual(
      {
        kind: body.channels[0].kind,
        label: body.channels[0].label,
        tokenDigest: body.channels[0].tokenDigest,
        observedStatus: body.channels[0].observedStatus,
      },
      {
        kind: "telegram",
        label: "personal",
        tokenDigest: digestOf(CHANNEL_TOKEN),
        observedStatus: "active",
      },
    );
    assert.equal(sink.created.length, 1);
    assert.deepEqual(sink.created[0].starts, [{ token: CHANNEL_TOKEN }]);
    // El Agent estaba corriendo y la huella cambió (canal añadido) => restart.
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT sin token deja el canal registrado como unpaired y no arranca ningún adapter", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", label: "sin credencial" }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels[0].observedStatus, "unpaired");
    assert.equal(body.channels[0].tokenDigest, undefined);
    assert.equal(sink.created.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("GET devuelve la superficie observada y ni el cuerpo ni el fichero llevan el token en claro (I1)", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });

    const response = await request(app, "GET");
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.channels.length, 1);
    assert.equal(json.channels[0].kind, "telegram");
    assert.equal(json.channels[0].observedStatus, "active");

    const raw = JSON.stringify(json);
    assert.equal(raw.includes(CHANNEL_TOKEN), false);
    assert.equal(raw.includes('"token"'), false);
    const persisted = await channelsFile(dataDir);
    assert.notEqual(persisted, "");
    assert.equal(persisted.includes(CHANNEL_TOKEN), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT replace-all: rotar el token para el adapter viejo y arranca el nuevo en silencio (I1)", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", token: OTHER_TOKEN }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels[0].tokenDigest, digestOf(OTHER_TOKEN));

    assert.equal(sink.created.length, 2);
    assert.equal(sink.created[0].stopCount, 1);
    assert.deepEqual(sink.created[1].starts, [{ token: OTHER_TOKEN }]);
    // Teardown silencioso: ni un despedida ni ningún envío.
    assert.deepEqual(sink.created[0].sends, []);
    assert.deepEqual(sink.created[1].sends, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT replace-all idempotente: el mismo digest no para ni vuelve a arrancar el adapter", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording([]), sink);
    await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });
    assert.equal(response.status, 202);
    assert.equal(sink.created.length, 1);
    assert.equal(sink.created[0].starts.length, 1);
    assert.equal(sink.created[0].stopCount, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT con [] para todos los adapters y vacía el estado (I2: replace-all, no keep)", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording(actions), sink);
    await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });
    actions.length = 0;

    const response = await request(app, "PUT", { channels: [] });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { channels: [] });
    assert.equal(sink.created[0].stopCount, 1);
    assert.deepEqual(sink.created[0].sends, []);

    const get = await request(app, "GET");
    assert.deepEqual(await get.json(), { channels: [] });
    assert.equal(await channelsFile(dataDir), "[]\n");
    // Quitar el último canal cambia la huella: el Runner se reinicia.
    assert.deepEqual(actions, ["restart"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("PUT que solo cambia la etiqueta no reinicia el Runner (restart-policy: label no es estado de arranque)", async () => {
  const dataDir = await setup();
  try {
    const actions: string[] = [];
    const sink = createFakeRegistrySink();
    const app = router(dataDir, supervisorRecording(actions), sink);
    await request(app, "PUT", {
      channels: [{ kind: "telegram", label: "una", token: CHANNEL_TOKEN }],
    });
    actions.length = 0;

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", label: "otra", token: CHANNEL_TOKEN }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels[0].label, "otra");
    assert.deepEqual(actions, []);
    assert.equal(sink.created.length, 1);
    assert.equal(sink.created[0].stopCount, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- guard / failure observation --------------------------------------------

test("PUT con un turno en curso se rechaza con TURN_IN_PROGRESS sin tocar adapters ni estado", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const app = router(
      dataDir,
      supervisorRecording([]),
      sink,
      turnsWithLiveTurn(true),
    );

    const response = await request(app, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "TURN_IN_PROGRESS");
    assert.equal(sink.created.length, 0);
    assert.equal(await channelsFile(dataDir), "");

    const get = await request(app, "GET");
    assert.deepEqual((await get.json()).channels, []);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("un adapter que falla se OBSERVA como error sin convertirse en estado deseado ni filtrar el token (I3)", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    sink.control.failNextStart = new Error(
      `telegram token rejected: ${CHANNEL_TOKEN}`,
    );
    const appWithFailure = router(
      dataDir,
      supervisorRecording([]),
      sink,
    );

    const response = await request(appWithFailure, "PUT", {
      channels: [{ kind: "telegram", token: CHANNEL_TOKEN }],
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.channels[0].observedStatus, "error");
    assert.equal(typeof body.channels[0].lastError, "string");
    assert.equal(
      JSON.stringify(body).includes(CHANNEL_TOKEN),
      false,
      "el error no puede llevar el token",
    );
    assert.equal(
      (await channelsFile(dataDir)).includes(CHANNEL_TOKEN),
      false,
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// --- composición del arranque (part 2b, item 2) --------------------------------
//
// `index.ts` es quien construye el ChannelRuntimeRegistry, porque es también
// quien lo PARA en el SIGTERM (`shutdownRuntime`). Si el router se fabricara el
// suyo — el default de `createApiV1Router` cuando no llega `channels.registry` —
// el apagado llamaría a `stopAll()` sobre un registry vacío mientras el que tiene
// los adapters vivos sigue sondeando. Estos dos tests fijan el puente
// `createApi` → router y que ese mismo objeto es el que se apaga.

test("createApi inyecta el registry al router de /api/v1 (no deja que se fabrique el suyo)", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: sink.adapterFactory });
    const app = createApi(
      { dataDir, apiToken: SERVICE_TOKEN, panelEnabled: false } as PihubEnv,
      supervisorRecording([]),
      {} as OAuthService,
      {} as RuntimeProviders,
      undefined,
      undefined,
      { registry },
    );

    const response = await app.request("http://pihub.test/api/v1/agents/agent/channels", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channels: [{ kind: "telegram", token: CHANNEL_TOKEN }] }),
    });
    assert.equal(response.status, 202);

    // El adapter vivo está en EL registry, no en uno privado del router.
    assert.deepEqual(registry.liveAgents(), ["agent"]);
    assert.deepEqual(sink.created[0].starts, [{ token: CHANNEL_TOKEN }]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("stopAll() del registry del arranque para de verdad los adapters que arrancó", async () => {
  const dataDir = await setup();
  try {
    const sink = createFakeRegistrySink();
    const registry = new ChannelRuntimeRegistry({ adapterFactory: sink.adapterFactory });
    const app = createApi(
      { dataDir, apiToken: SERVICE_TOKEN, panelEnabled: false } as PihubEnv,
      supervisorRecording([]),
      {} as OAuthService,
      {} as RuntimeProviders,
      undefined,
      undefined,
      { registry },
    );
    await app.request("http://pihub.test/api/v1/agents/agent/channels", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channels: [{ kind: "telegram", token: CHANNEL_TOKEN }] }),
    });

    await registry.stopAll();

    assert.deepEqual(registry.liveAgents(), []);
    assert.equal(sink.created[0].stopCount, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
