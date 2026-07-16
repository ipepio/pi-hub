import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pihubMemory from "../src/pihub-memory.ts";

/** Carga las tools con un stub del ExtensionAPI de pi. */
function loadTools() {
  const tools = new Map();
  pihubMemory({ registerTool: (def) => tools.set(def.name, def) });
  return tools;
}

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const ENV_KEYS = [
  "PIHUB_AGENT_MEMORY_DIR",
  "PIHUB_GLOBAL_MEMORY_DIR",
  "PIHUB_SHARED_MEMORY_ACCESS",
  "PI_CODING_AGENT_DIR",
];

/** Ejecuta fn con un process.env controlado y lo restaura al salir. */
async function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function text(result) {
  return result.content.map((c) => c.text).join("\n");
}

/** Entorno pihub: dirs de agente y compartido + nivel de acceso dado. */
async function pihubEnv(access) {
  const agentDir = await tmpDir("pihub-agent-mem-");
  const sharedDir = await tmpDir("pihub-shared-mem-");
  const env = { PIHUB_AGENT_MEMORY_DIR: agentDir, PIHUB_SHARED_MEMORY_ACCESS: access };
  if (access !== "none") env.PIHUB_GLOBAL_MEMORY_DIR = sharedDir;
  return { env, agentDir, sharedDir };
}

test("matriz de permisos: scope agent siempre operativo en los 3 niveles", async () => {
  for (const access of ["none", "read", "read-write"]) {
    const { env } = await pihubEnv(access);
    await withEnv(env, async () => {
      const tools = loadTools();
      const saved = await tools.get("memory_save").execute("id", { scope: "agent", title: "Dato", content: "x" });
      assert.match(text(saved), /agent\/dato\.md/, `save agent con acceso ${access}`);
      const read = await tools.get("memory_read").execute("id", { scope: "agent", name: "dato" });
      assert.match(text(read), /title: Dato/);
      const deleted = await tools.get("memory_delete").execute("id", { scope: "agent", name: "dato" });
      assert.match(text(deleted), /agent\/dato/);
    });
  }
});

test("none: toda operación shared se deniega con el error tipado y sin rutas", async () => {
  const { env, sharedDir } = await pihubEnv("none");
  await withEnv(env, async () => {
    const tools = loadTools();
    for (const [tool, params] of [
      ["memory_read", { scope: "shared" }],
      ["memory_save", { scope: "shared", title: "t", content: "c" }],
      ["memory_delete", { scope: "shared", name: "t" }],
    ]) {
      await assert.rejects(
        tools.get(tool).execute("id", params),
        (err) => {
          assert.match(err.message, /\[shared_memory_access_denied\]/, `${tool} sin código tipado`);
          assert.ok(!err.message.includes(sharedDir), `${tool} revela la ruta compartida`);
          assert.ok(!err.message.includes(os.tmpdir()), `${tool} revela rutas internas`);
          return true;
        },
      );
    }
  });
});

test("read: lectura shared permitida; save y delete shared denegados", async () => {
  const { env, sharedDir } = await pihubEnv("read");
  await fs.writeFile(path.join(sharedDir, "pista.md"), "---\ntitle: Pista\nupdatedAt: x\n---\n\nhola\n");
  await withEnv(env, async () => {
    const tools = loadTools();
    const read = await tools.get("memory_read").execute("id", { scope: "shared", name: "pista" });
    assert.match(text(read), /title: Pista/);
    await assert.rejects(
      tools.get("memory_save").execute("id", { scope: "shared", title: "no", content: "no" }),
      /requiere "read-write"/,
    );
    await assert.rejects(
      tools.get("memory_delete").execute("id", { scope: "shared", name: "pista" }),
      /requiere "read-write"/,
    );
  });
  const files = await fs.readdir(sharedDir);
  assert.ok(files.includes("pista.md"), "la entrada compartida no debe haberse borrado");
});

test("read-write: lectura, escritura y borrado shared permitidos", async () => {
  const { env, sharedDir } = await pihubEnv("read-write");
  await withEnv(env, async () => {
    const tools = loadTools();
    const saved = await tools.get("memory_save").execute("id", { scope: "shared", title: "Común", content: "para todos" });
    assert.match(text(saved), /shared\/comun\.md/);
    const read = await tools.get("memory_read").execute("id", { scope: "shared", name: "comun" });
    assert.match(text(read), /para todos/);
    const deleted = await tools.get("memory_delete").execute("id", { scope: "shared", name: "comun" });
    assert.match(text(deleted), /shared\/comun/);
  });
  const files = (await fs.readdir(sharedDir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  assert.equal(files.length, 0);
});

test('alias legacy: scope "global" se normaliza a shared y respeta el acceso', async () => {
  const rw = await pihubEnv("read-write");
  await withEnv(rw.env, async () => {
    const tools = loadTools();
    const saved = await tools.get("memory_save").execute("id", { scope: "global", title: "Vieja", content: "sesión antigua" });
    assert.match(text(saved), /shared\/vieja\.md/, "el mensaje debe usar el scope normalizado");
    assert.doesNotMatch(text(saved), /global/);
  });
  const none = await pihubEnv("none");
  await withEnv(none.env, async () => {
    const tools = loadTools();
    await assert.rejects(
      tools.get("memory_read").execute("id", { scope: "global" }),
      /\[shared_memory_access_denied\]/,
    );
  });
});

test("none + PI_CODING_AGENT_DIR presente: sin fallback al dir global (doble capa)", async () => {
  const agentDir = await tmpDir("pihub-agent-mem-");
  const piDir = await tmpDir("pihub-pi-dir-");
  await fs.mkdir(path.join(piDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(piDir, "memory", "secreto.md"), "---\ntitle: Secreto\n---\n\nno debes verme\n");
  await withEnv(
    { PIHUB_AGENT_MEMORY_DIR: agentDir, PIHUB_SHARED_MEMORY_ACCESS: "none", PI_CODING_AGENT_DIR: piDir },
    async () => {
      const tools = loadTools();
      await assert.rejects(tools.get("memory_read").execute("id", { scope: "shared" }), /\[shared_memory_access_denied\]/);
    },
  );
});

test("acceso inválido o ausente bajo pihub => fail-closed (none)", async () => {
  const agentDir = await tmpDir("pihub-agent-mem-");
  const sharedDir = await tmpDir("pihub-shared-mem-");
  for (const access of [undefined, "todo", "READ"]) {
    const env = { PIHUB_AGENT_MEMORY_DIR: agentDir, PIHUB_GLOBAL_MEMORY_DIR: sharedDir };
    if (access !== undefined) env.PIHUB_SHARED_MEMORY_ACCESS = access;
    await withEnv(env, async () => {
      const tools = loadTools();
      await assert.rejects(
        tools.get("memory_read").execute("id", { scope: "shared" }),
        /\[shared_memory_access_denied\]/,
        `acceso "${access}" no cerró la Shared Memory`,
      );
    });
  }
});

test("standalone (sin PIHUB_AGENT_MEMORY_DIR): shared read-write con fallback histórico", async () => {
  const piDir = await tmpDir("pihub-pi-dir-");
  await withEnv({ PI_CODING_AGENT_DIR: piDir }, async () => {
    const tools = loadTools();
    const saved = await tools.get("memory_save").execute("id", { scope: "shared", title: "Suelta", content: "modo pi" });
    assert.match(text(saved), /shared\/suelta\.md/);
    const read = await tools.get("memory_read").execute("id", { scope: "shared", name: "suelta" });
    assert.match(text(read), /modo pi/);
  });
  const files = await fs.readdir(path.join(piDir, "memory"));
  assert.ok(files.includes("suelta.md"));
});

test("none: los schemas y descripciones de las tools no revelan que existe la Shared Memory", async () => {
  const { env } = await pihubEnv("none");
  await withEnv(env, () => {
    const tools = loadTools();
    for (const def of tools.values()) {
      const serialized = JSON.stringify({ description: def.description, parameters: def.parameters });
      assert.doesNotMatch(serialized, /shared/i, `${def.name} menciona shared con acceso none`);
      assert.doesNotMatch(serialized, /global/i, `${def.name} menciona global con acceso none`);
    }
  });
});

test("read/read-write: los schemas ofrecen shared y aceptan el alias global", async () => {
  const { env } = await pihubEnv("read");
  await withEnv(env, () => {
    const tools = loadTools();
    const serialized = JSON.stringify(tools.get("memory_read").parameters);
    assert.match(serialized, /shared/);
    assert.match(serialized, /global/);
  });
});

test("escrituras concurrentes de memory_save no pierden entradas (lock inline)", async () => {
  const { env, sharedDir } = await pihubEnv("read-write");
  await withEnv(env, async () => {
    const tools = loadTools();
    const save = tools.get("memory_save");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        save.execute("id", { scope: "shared", title: `Concurrente ${i}`, content: `c${i}` }),
      ),
    );
  });
  const index = await fs.readFile(path.join(sharedDir, "MEMORY.md"), "utf8");
  for (let i = 0; i < 8; i++) {
    assert.match(index, new RegExp(`concurrente-${i}`), `falta concurrente-${i} en el índice`);
  }
});
