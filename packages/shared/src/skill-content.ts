import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataPaths } from "./registry.js";

/** Coinciden con el import del dashboard: una Skill no puede agotar el Runtime. */
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;

const SKILL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SkillContentErrorCode =
  | "invalid_skill_id"
  | "path_traversal_detected"
  | "duplicate_path"
  | "entry_too_large"
  | "archive_too_large"
  | "missing_skill_markdown"
  | "symlink_rejected"
  | "corrupt_archive";

export class SkillContentError extends Error {
  constructor(
    readonly code: SkillContentErrorCode,
    readonly entryName: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillContentError";
  }
}

export interface SkillContentFile {
  /** Ruta relativa al directorio de la Skill; `SKILL.md` es obligatorio en la raíz. */
  path: string;
  content: Buffer | string;
}

/** El dashboard aporta su UUID: pihub nunca inventa una segunda identidad. */
export function isValidSkillId(skillId: string): boolean {
  return SKILL_ID_RE.test(skillId);
}

/**
 * Raíz de paquete pi persistente para una Skill importada. Los scopes no se
 * comparten: eliminar la instalación local de un Agent no puede borrar el
 * source que una instalación global (mismo skillId) todavía referencia.
 */
export function skillContentSourceDir(dataDir: string, skillId: string, agentWorkspace?: string): string {
  assertSkillId(skillId);
  const scopeDir = agentWorkspace
    ? path.join(agentWorkspace, ".pi", "imported-skills")
    : path.join(dataPaths(dataDir).globalDir, "imported-skills");
  return path.join(scopeDir, skillId);
}

/**
 * Materializa una Skill como paquete local que pi puede descubrir sin
 * manifiesto: `<source>/skills/<skillId>/SKILL.md`.
 *
 * Verificado manualmente contra pi 0.80.3 el 2026-08-01:
 * `pi install ./source` registra una referencia a `source` en settings.json
 * (no copia sus ficheros), y el layout convencional `skills/<dir>/SKILL.md`
 * es descubierto como Skill. Por eso el source vive en el volumen persistente
 * y no se limpia al terminar la petición.
 */
/**
 * Extrae un ZIP sin tocar el filesystem. Se valida el tamaño declarado en el
 * directorio central antes de `getData()`, por lo que un ZIP bomb no llega a
 * descomprimirse. A diferencia del importador Markdown del dashboard se
 * admiten assets/referencias regulares: pi no instala dependencias de un
 * source local, pero una Skill puede necesitar ficheros auxiliares.
 */
export function filesFromSkillZip(buffer: Buffer): SkillContentFile[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new SkillContentError("corrupt_archive", "", "Could not read skill ZIP");
  }

  const files: SkillContentFile[] = [];
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (isSymlink(entry)) {
      throw new SkillContentError("symlink_rejected", entry.entryName, "Symlinks are not allowed in skill ZIPs");
    }
    if (entry.isDirectory) continue;

    const entryPath = safeRelativePath(entry.entryName);
    const declaredSize = entry.header.size;
    if (declaredSize > MAX_SKILL_FILE_BYTES) {
      throw new SkillContentError("entry_too_large", entry.entryName, "Skill ZIP entry exceeds the per-file limit");
    }
    total += declaredSize;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw new SkillContentError("archive_too_large", entry.entryName, "Skill ZIP exceeds the total limit");
    }

    let content: Buffer;
    try {
      content = entry.getData();
    } catch {
      throw new SkillContentError("corrupt_archive", entry.entryName, "Could not extract skill ZIP entry");
    }
    // Defensa adicional contra un header mentiroso: no se escribe un byte que
    // exceda el contrato aunque la librería consiguiera descomprimirlo.
    if (content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillContentError("entry_too_large", entry.entryName, "Skill ZIP entry exceeds the per-file limit");
    }
    files.push({ path: entryPath, content });
  }

  // Reutiliza también duplicate paths y la presencia de SKILL.md.
  return validateFiles(files);
}

export async function materializeSkillContent(
  dataDir: string,
  skillId: string,
  files: readonly SkillContentFile[],
  agentWorkspace?: string,
): Promise<string> {
  const sourceDir = skillContentSourceDir(dataDir, skillId, agentWorkspace);
  const normalizedFiles = validateFiles(files);
  const parent = path.dirname(sourceDir);
  const staging = path.join(parent, `.staging-${skillId}-${randomUUID()}`);
  const backup = path.join(parent, `.backup-${skillId}-${randomUUID()}`);
  let previousMoved = false;

  await fs.mkdir(parent, { recursive: true });
  try {
    for (const file of normalizedFiles) {
      const target = path.join(staging, "skills", skillId, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // El contenido entrante nunca crea symlinks: writeFile crea un fichero
      // regular y las rutas se validaron antes de escribir el staging completo.
      await fs.writeFile(target, file.content, { mode: 0o600 });
    }

    await fs.lstat(sourceDir).then(
      async () => {
        await fs.rename(sourceDir, backup);
        previousMoved = true;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await fs.rename(staging, sourceDir);
    if (previousMoved) await fs.rm(backup, { recursive: true, force: true });
    return sourceDir;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (previousMoved) {
      await fs.rename(backup, sourceDir).catch(() => {});
    }
    throw error;
  }
}

export async function removeMaterializedSkillContent(
  dataDir: string,
  skillId: string,
  agentWorkspace?: string,
): Promise<void> {
  await fs.rm(skillContentSourceDir(dataDir, skillId, agentWorkspace), { recursive: true, force: true });
}

/** Verdadero solo para la raíz persistente de una Skill de contenido de pihub. */
export function isMaterializedSkillSource(dataDir: string, source: string, agentWorkspace?: string): boolean {
  const settingsDir = agentWorkspace ? path.join(agentWorkspace, ".pi") : dataPaths(dataDir).globalDir;
  const scopeDir = skillImportsScopeDir(dataDir, agentWorkspace);
  const relative = path.relative(scopeDir, path.resolve(settingsDir, source));
  return !relative.startsWith("..") && !path.isAbsolute(relative) && isValidSkillId(relative);
}

export async function listMaterializedSkillIds(dataDir: string, agentWorkspace?: string): Promise<string[]> {
  const scopeDir = skillImportsScopeDir(dataDir, agentWorkspace);
  const settingsDir = agentWorkspace ? path.join(agentWorkspace, ".pi") : dataPaths(dataDir).globalDir;
  const registeredIds = await readRegisteredSkillIds(path.join(settingsDir, "settings.json"), settingsDir, scopeDir);
  try {
    const entries = await fs.readdir(scopeDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && registeredIds.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readRegisteredSkillIds(settingsFile: string, settingsDir: string, scopeDir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      packages?: Array<string | { source?: string }>;
    };
    const ids = new Set<string>();
    for (const entry of raw.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry.source;
      if (!source) continue;
      const relative = path.relative(scopeDir, path.resolve(settingsDir, source));
      if (!relative.startsWith("..") && !path.isAbsolute(relative) && isValidSkillId(relative)) ids.add(relative);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function skillImportsScopeDir(dataDir: string, agentWorkspace?: string): string {
  return agentWorkspace
    ? path.join(agentWorkspace, ".pi", "imported-skills")
    : path.join(dataPaths(dataDir).globalDir, "imported-skills");
}

function assertSkillId(skillId: string): void {
  if (!isValidSkillId(skillId)) {
    throw new SkillContentError("invalid_skill_id", skillId, "skillId must be a UUID");
  }
}

function validateFiles(files: readonly SkillContentFile[]): Array<{ path: string; content: Buffer }> {
  const seen = new Set<string>();
  let total = 0;
  const result: Array<{ path: string; content: Buffer }> = [];

  for (const file of files) {
    const normalizedPath = safeRelativePath(file.path);
    if (seen.has(normalizedPath)) {
      throw new SkillContentError("duplicate_path", file.path, "Skill content contains a duplicate path");
    }
    seen.add(normalizedPath);

    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    if (content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillContentError("entry_too_large", file.path, "Skill file exceeds the per-file limit");
    }
    total += content.byteLength;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw new SkillContentError("archive_too_large", file.path, "Skill content exceeds the total limit");
    }
    result.push({ path: normalizedPath, content });
  }

  if (!seen.has("SKILL.md")) {
    throw new SkillContentError("missing_skill_markdown", "SKILL.md", "Skill content must contain root SKILL.md");
  }
  return result;
}

function isSymlink(entry: AdmZip.IZipEntry): boolean {
  const unixMode = (entry.attr >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function safeRelativePath(entryName: string): string {
  if (!entryName || entryName.includes("\0") || entryName.includes("\\")) {
    throw new SkillContentError("path_traversal_detected", entryName, "Unsafe skill content path");
  }
  const normalized = path.posix.normalize(entryName);
  if (
    path.posix.isAbsolute(entryName) ||
    entryName.includes(":") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new SkillContentError("path_traversal_detected", entryName, "Unsafe skill content path");
  }
  return normalized;
}
