import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  filesFromSkillZip,
  isMaterializedSkillSource,
  listMaterializedSkillIds,
  materializeSkillContent,
  SkillContentError,
} from "../dist/skill-content.js";

const SKILL_ID = "0d1c80cf-7889-4ab6-9a5c-8d5b32b3b530";

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pihub-skill-content-"));
}

test("materializa una Skill en un paquete pi persistente sin filtrar la ruta como identidad", async () => {
  const dataDir = await tempDataDir();
  try {
    const source = await materializeSkillContent(dataDir, SKILL_ID, [
      {
        path: "SKILL.md",
        content: "---\nname: contenido-prueba\ndescription: Prueba.\n---\n\n# Prueba\n",
      },
      { path: "references/guia.md", content: "# Guía\n" },
    ]);

    assert.equal(source, path.join(dataDir, "global", "imported-skills", SKILL_ID));
    assert.equal(
      await fs.readFile(path.join(source, "skills", SKILL_ID, "SKILL.md"), "utf8"),
      "---\nname: contenido-prueba\ndescription: Prueba.\n---\n\n# Prueba\n",
    );
    assert.equal(await fs.readFile(path.join(source, "skills", SKILL_ID, "references", "guia.md"), "utf8"), "# Guía\n");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("reinstalar el mismo skillId sustituye el contenido persistido sin acumular ficheros antiguos", async () => {
  const dataDir = await tempDataDir();
  try {
    const source = await materializeSkillContent(dataDir, SKILL_ID, [
      { path: "SKILL.md", content: "primera versión" },
      { path: "obsolete.md", content: "se debe borrar" },
    ]);
    await materializeSkillContent(dataDir, SKILL_ID, [{ path: "SKILL.md", content: "segunda versión" }]);

    assert.equal(await fs.readFile(path.join(source, "skills", SKILL_ID, "SKILL.md"), "utf8"), "segunda versión");
    await assert.rejects(fs.access(path.join(source, "skills", SKILL_ID, "obsolete.md")));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("la lista de Skills ignora contenido huérfano que pi no tiene registrado", async () => {
  const dataDir = await tempDataDir();
  try {
    const source = await materializeSkillContent(dataDir, SKILL_ID, [{ path: "SKILL.md", content: "contenido" }]);
    assert.deepEqual(await listMaterializedSkillIds(dataDir), []);

    await fs.writeFile(
      path.join(dataDir, "global", "settings.json"),
      JSON.stringify({ packages: [path.relative(path.join(dataDir, "global"), source)] }),
    );
    assert.deepEqual(await listMaterializedSkillIds(dataDir), [SKILL_ID]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("reconoce solo su propio source importado para que no se filtre por /packages", () => {
  const source = path.join("/data", "global", "imported-skills", SKILL_ID);
  assert.equal(isMaterializedSkillSource("/data", "imported-skills/" + SKILL_ID), true);
  assert.equal(isMaterializedSkillSource("/data", source), true);
  assert.equal(isMaterializedSkillSource("/data", "npm:example"), false);
  assert.equal(isMaterializedSkillSource("/data", path.join("/data", "global", "imported-skills", "not-a-uuid")), false);
});

test("un ZIP válido conserva todos los ficheros regulares necesarios para la Skill", () => {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from("---\nname: zip\ndescription: ZIP.\n---\n"));
  zip.addFile("references/api.json", Buffer.from('{"version":1}'));

  const files = filesFromSkillZip(zip.toBuffer());

  assert.deepEqual(
    files.map((file) => file.path).sort(),
    ["SKILL.md", "references/api.json"],
  );
});

test("un ZIP con traversal, symlink o tamaño declarado excesivo se rechaza antes de escribir", () => {
  const traversal = new AdmZip();
  traversal.addFile("placeholder", Buffer.from("x"));
  traversal.getEntries()[0].entryName = "../SKILL.md";
  assert.throws(
    () => filesFromSkillZip(traversal.toBuffer()),
    (error) => error instanceof SkillContentError && error.code === "path_traversal_detected",
  );

  const symlink = new AdmZip();
  symlink.addFile("SKILL.md", Buffer.from("../../etc/passwd"));
  symlink.getEntries()[0].attr = (0o120777 << 16) >>> 0;
  assert.throws(
    () => filesFromSkillZip(symlink.toBuffer()),
    (error) => error instanceof SkillContentError && error.code === "symlink_rejected",
  );

  const oversized = new AdmZip();
  oversized.addFile("SKILL.md", Buffer.from("small"));
  const reloaded = new AdmZip(oversized.toBuffer());
  reloaded.getEntries()[0].header.size = 5 * 1024 * 1024 + 1;
  assert.throws(
    () => filesFromSkillZip(reloaded.toBuffer()),
    (error) => error instanceof SkillContentError && error.code === "entry_too_large",
  );
});

test("rechaza traversal antes de crear el directorio persistente", async () => {
  const dataDir = await tempDataDir();
  try {
    await assert.rejects(
      materializeSkillContent(dataDir, SKILL_ID, [{ path: "../escape.md", content: "no" }]),
      (error) => error instanceof SkillContentError && error.code === "path_traversal_detected",
    );
    await assert.rejects(fs.access(path.join(dataDir, "global", "imported-skills", SKILL_ID)));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
