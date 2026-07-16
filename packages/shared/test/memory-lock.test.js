import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveMemory, deleteMemory, readIndex, withMemoryLock } from "../dist/memory.js";

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pihub-memlock-"));
}

test("escrituras concurrentes no pierden entradas en MEMORY.md", async () => {
  const dir = await tmpDir();
  const titles = Array.from({ length: 10 }, (_, i) => `Entrada número ${i}`);
  await Promise.all(titles.map((t) => saveMemory(dir, t, `contenido de ${t}`)));
  const index = await readIndex(dir);
  for (let i = 0; i < titles.length; i++) {
    assert.match(index, new RegExp(`entrada-numero-${i}`), `falta la entrada ${i} en el índice`);
  }
});

test("save y delete concurrentes dejan el índice consistente con el directorio", async () => {
  const dir = await tmpDir();
  await saveMemory(dir, "estable", "no me borres");
  await saveMemory(dir, "victima", "me van a borrar");
  await Promise.all([
    saveMemory(dir, "nueva", "recién llegada"),
    deleteMemory(dir, "victima"),
  ]);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const index = await readIndex(dir);
  for (const f of files) {
    assert.match(index, new RegExp(f.replace(/\.md$/, "")), `el índice no refleja ${f}`);
  }
  assert.doesNotMatch(index, /victima/);
});

test("un lock huérfano (proceso muerto) se roba sin colgarse", async () => {
  const dir = await tmpDir();
  const lockDir = path.join(dir, ".lock");
  await fs.mkdir(lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockDir, old, old);
  const result = await withMemoryLock(dir, async () => "dentro");
  assert.equal(result, "dentro");
});

test("el lock se libera aunque la operación lance", async () => {
  const dir = await tmpDir();
  await assert.rejects(
    withMemoryLock(dir, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await assert.rejects(fs.stat(path.join(dir, ".lock")), { code: "ENOENT" });
  // y sigue siendo usable después
  assert.equal(await withMemoryLock(dir, async () => 42), 42);
});

test("el directorio .lock nunca aparece en el índice", async () => {
  const dir = await tmpDir();
  await saveMemory(dir, "única", "contenido");
  const index = await readIndex(dir);
  assert.doesNotMatch(index, /\.lock/);
});
