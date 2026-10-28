import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentPaths, scaffoldAgentDirs, writeAgent } from "@pihub/shared";
import { Supervisor } from "../dist/supervisor.js";

/**
 * Host del ocupante del fixture = host que el Runner real ata
 * (`packages/runner/src/server.ts`: `hostname: "0.0.0.0"`). Medido en este host
 * (Darwin, node 22): un socket escuchando en `127.0.0.1:P` NO impide atar
 * `0.0.0.0:P` y al revés, así que el fixture tiene que ocupar la misma dirección
 * que el Runner para representar un puerto realmente ocupado.
 */
const RUNNER_HOST = "0.0.0.0";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: RUNNER_HOST, port, exclusive: true }, () =>
      resolve(server.address().port),
    );
  });
}

function close(occupant) {
  return new Promise((resolve) => {
    // `close()` solo llama a su callback cuando no le queda ningún cliente, y un
    // socket de `net` no expone `closeAllConnections`: se destruyen los que abrió
    // este mismo fixture antes de cerrar el servidor.
    for (const socket of occupant.sockets) socket.destroy();
    if (!occupant.server.listening) return resolve();
    occupant.server.close(() => resolve());
  });
}

/** Ocupante del puerto: acepta la conexión y contesta algo reconocible. */
function occupied() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.end("ocupado");
  });
  return { server, sockets };
}

/** Pregunta al ocupante y devuelve exactamente lo que responde. */
function ask(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () =>
      socket.end("hola"),
    );
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      socket.destroy();
      resolve(data);
    });
    socket.on("error", reject);
  });
}

/** Puerto libre en la dirección del Runner: se ata y se suelta, nada más. */
async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(() => resolve()));
  return port;
}

function supervisorFor(dataDir) {
  let issued = 0;
  const supervisor = new Supervisor(
    {
      dataDir,
      apiToken: "55".repeat(32),
      managerPort: 4893,
      memoryEnabled: true,
      sharedMemoryDefault: "none",
      telegramAllowedUsers: [],
    },
    () => {
      issued += 1;
      return "66".repeat(32);
    },
  );
  return { supervisor, issuedTokens: () => issued };
}

async function writeAgentOnPort(dataDir, name, port) {
  await scaffoldAgentDirs(dataDir, name);
  await writeAgent(dataDir, {
    name,
    port,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
}

test("un puerto ya ocupado no arranca el Runner: el ocupante sigue sirviendo y el Agent no figura en marcha", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-supervisor-fence-"),
  );
  const occupant = occupied();
  const { supervisor, issuedTokens } = supervisorFor(dataDir);
  try {
    const port = await listen(occupant.server);
    await writeAgentOnPort(dataDir, "fenced", port);

    await assert.rejects(() => supervisor.start("fenced"), /ocupado/);

    // El ocupante queda intacto: nadie lo adopta, nadie le manda nada, nadie lo mata.
    assert.equal(await ask(port), "ocupado");
    // Y el Agent no se presenta como en marcha.
    assert.equal(supervisor.runnerPortOf("fenced"), undefined);
    assert.equal(supervisor.state("fenced").state, "stopped");
    // No hubo spawn: ni credencial de callback emitida ni log del Runner abierto.
    assert.equal(issuedTokens(), 0);
    await assert.rejects(
      fs.access(path.join(agentPaths(dataDir, "fenced").root, "runner.log")),
      /ENOENT/,
    );
  } finally {
    await supervisor.stopAll();
    await close(occupant);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("liberar el puerto levanta el fence: el mismo puerto arranca un Runner real", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-supervisor-fence-released-"),
  );
  const occupant = occupied();
  const { supervisor } = supervisorFor(dataDir);
  let spawned;
  try {
    const port = await listen(occupant.server);
    await writeAgentOnPort(dataDir, "released", port);
    await assert.rejects(() => supervisor.start("released"), /ocupado/);

    await close(occupant);

    await supervisor.start("released");
    assert.equal(supervisor.state("released").state, "running");
    assert.equal(supervisor.runnerPortOf("released"), port);
    await fs.access(path.join(agentPaths(dataDir, "released").root, "runner.log"));
    // El ocupante efímero de este fixture se cierra; el hijo de este fixture, también.
    spawned = supervisor.processes.get("released");
  } finally {
    if (spawned) spawned.intentionalStop = true;
    await supervisor.stopAll();
    await close(occupant);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("un auto-reinicio contra un puerto ya ocupado no tumba el Manager: se registra y el Agent queda parado", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pihub-supervisor-fence-restart-"),
  );
  const occupant = occupied();
  const { supervisor } = supervisorFor(dataDir);
  try {
    const port = await freePort();
    await writeAgentOnPort(dataDir, "restarting", port);
    await supervisor.start("restarting");
    const spawned = supervisor.processes.get("restarting");
    assert.ok(spawned);

    // Solo el hijo de este fixture: muere como moriría un Runner real.
    const exited = once(spawned.proc, "exit");
    spawned.proc.kill("SIGKILL");
    await exited;

    // Otro proceso se queda con el puerto antes del auto-reinicio (1 s).
    assert.equal(await listen(occupant.server, port), port);
    await sleep(1_800);

    // El reinicio fallece en el fence y el rechazo se consume: sin esto sería un
    // `unhandledRejection` que tumba el Manager y este test fallaría por él.
    assert.equal(supervisor.state("restarting").state, "stopped");
    assert.equal(supervisor.runnerPortOf("restarting"), undefined);
    assert.equal(await ask(port), "ocupado");
  } finally {
    await supervisor.stopAll();
    await close(occupant);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
