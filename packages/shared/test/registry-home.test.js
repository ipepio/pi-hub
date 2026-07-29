import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPaths, scaffoldGlobalDirs } from "../dist/registry.js";

// H10: HOME apuntaba a /home/ubuntu, dentro del filesystem de solo lectura del
// User Runtime gestionado. npx/uv necesitan un HOME escribible para su caché
// (~/.npm, ~/.cache) — sin él, cualquier MCP muere con ENOENT al ejecutarse,
// aunque su instalación (que sí escribe en el workspace) haya funcionado.
test("dataPaths expone un homeDir dentro del volumen persistente", () => {
  const paths = dataPaths("/data");
  assert.equal(paths.homeDir, "/data/home");
});

test("scaffoldGlobalDirs crea el homeDir, escribible por el proceso actual", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pihub-registry-home-"));
  try {
    const paths = await scaffoldGlobalDirs(dataDir);

    const stat = await fs.stat(paths.homeDir);
    assert.ok(stat.isDirectory());

    const probe = path.join(paths.homeDir, ".npm", "probe");
    await fs.mkdir(path.dirname(probe), { recursive: true });
    await fs.writeFile(probe, "ok");
    assert.equal(await fs.readFile(probe, "utf8"), "ok");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
