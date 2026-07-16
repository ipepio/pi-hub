/**
 * pihub-memory — memoria privada del agente y Shared Memory del User Runtime,
 * en ficheros markdown.
 *
 * Fichero autocontenido: pihub lo copia a <global>/extensions/ en cada arranque.
 * Config por env (la inyecta el supervisor de pihub al arrancar el runner):
 *   PIHUB_AGENT_MEMORY_DIR      dir de la memoria privada (scope "agent")
 *   PIHUB_GLOBAL_MEMORY_DIR     dir de la Shared Memory (solo se inyecta si el acceso no es "none")
 *   PIHUB_SHARED_MEMORY_ACCESS  none | read | read-write (ausente o inválida => none bajo pihub)
 *
 * Sin PIHUB_AGENT_MEMORY_DIR se asume `pi` standalone (fuera de pihub): una única
 * memoria en $PI_CODING_AGENT_DIR/memory con acceso completo (comportamiento
 * histórico). Quien tiene shell en el contenedor ya ve /data entero, así que el
 * modo standalone no debilita el aislamiento entre agentes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SharedAccess = "none" | "read" | "read-write";
type PublicScope = "agent" | "shared";

function sharedAccess(): SharedAccess {
  const raw = process.env.PIHUB_SHARED_MEMORY_ACCESS;
  if (raw === "none" || raw === "read" || raw === "read-write") return raw;
  // Bajo pihub (hay memoria de agente inyectada) el default es cerrado;
  // en `pi` standalone se conserva la memoria única histórica.
  return process.env.PIHUB_AGENT_MEMORY_DIR ? "none" : "read-write";
}

function sharedMemoryDir(): string | undefined {
  if (process.env.PIHUB_GLOBAL_MEMORY_DIR) return process.env.PIHUB_GLOBAL_MEMORY_DIR;
  // Fallback SOLO standalone: bajo pihub el dir compartido llega exclusivamente
  // por env inyectada (con acceso "none" no existe para este proceso).
  if (!process.env.PIHUB_AGENT_MEMORY_DIR && process.env.PI_CODING_AGENT_DIR) {
    return path.join(process.env.PI_CODING_AGENT_DIR, "memory");
  }
  return undefined;
}

function memoryDir(scope: PublicScope): string {
  const dir = scope === "shared" ? sharedMemoryDir() : process.env.PIHUB_AGENT_MEMORY_DIR;
  if (!dir) throw new Error(`No hay directorio de memoria para el ámbito "${scope}"`);
  return dir;
}

/** "global" se acepta solo como alias legacy de sesiones antiguas. */
function normalizeScope(scope: "agent" | "shared" | "global"): PublicScope {
  return scope === "global" ? "shared" : scope;
}

function authorizeShared(op: "read" | "write"): void {
  const access = sharedAccess();
  const allowed = op === "read" ? access !== "none" : access === "read-write";
  if (allowed) return;
  const required = op === "read" ? '"read" o "read-write"' : '"read-write"';
  throw new Error(
    `[shared_memory_access_denied] Este agente tiene acceso "${access}" a la Shared Memory; ` +
      `esta operación requiere ${required}. Un administrador puede cambiarlo con memory.sharedAccess.`,
  );
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "memoria"
  );
}

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

// Mantener en sync con withMemoryLock de packages/shared/src/memory.ts.
async function withMemoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockDir).catch(() => undefined);
      const stale = !stat || Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      if (stale || Date.now() > deadline) {
        await fs.rmdir(lockDir).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockDir).catch(() => {});
  }
}

async function listEntries(dir: string): Promise<Array<{ name: string; title: string; firstLine: string }>> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: Array<{ name: string; title: string; firstLine: string }> = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
    const title = /^title:\s*(.+)$/m.exec(raw)?.[1] ?? file.replace(/\.md$/, "");
    const bodyStart = raw.indexOf("---", 3);
    const body = bodyStart > 0 ? raw.slice(bodyStart + 3) : raw;
    const firstLine = body.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
    entries.push({ name: file.replace(/\.md$/, ""), title, firstLine });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function updateIndex(dir: string): Promise<void> {
  const entries = await listEntries(dir);
  const lines = entries.map((e) => `- **${e.name}**: ${e.title} — ${e.firstLine}`);
  await fs.writeFile(path.join(dir, "MEMORY.md"), lines.length ? lines.join("\n") + "\n" : "", "utf8");
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

// El env es fijo durante la vida del runner (cambiar el acceso lo reinicia), así
// que el schema puede construirse en el registro. Con acceso "none" el scope solo
// ofrece "agent": las tools no deben revelar que la Shared Memory existe.
// "global" sigue en la unión (si hay acceso) para que validen las llamadas de
// sesiones antiguas, pero ya no se documenta como opción.
function buildScopeParam() {
  if (sharedAccess() === "none") {
    return Type.Union([Type.Literal("agent")], {
      description: 'Ámbito de la memoria: "agent" (memoria privada de este agente)',
    });
  }
  return Type.Union([Type.Literal("agent"), Type.Literal("shared"), Type.Literal("global")], {
    description: 'Ámbito: "agent" (memoria privada de este agente) o "shared" (memoria compartida del User Runtime)',
  });
}

export default function pihubMemory(pi: ExtensionAPI) {
  const withShared = sharedAccess() !== "none";
  const scopeParam = buildScopeParam();
  pi.registerTool(
    defineTool({
      name: "memory_save",
      label: "Guardar memoria",
      description:
        "Guarda un hecho duradero en la memoria persistente (fichero markdown). Úsalo cuando detectes información que merezca recordarse entre sesiones: datos del usuario, del proyecto, preferencias o decisiones. " +
        (withShared
          ? "Usa scope `agent` por defecto; `shared` solo para hechos útiles a todos los agentes (requiere acceso de escritura compartida). "
          : "") +
        "Sobrescribe si ya existe una memoria con el mismo título.",
      parameters: Type.Object({
        scope: scopeParam,
        title: Type.String({ description: "Título corto y descriptivo de la memoria" }),
        content: Type.String({ description: "Contenido en markdown del hecho a recordar" }),
      }),
      async execute(_id, params) {
        const scope = normalizeScope(params.scope);
        if (scope === "shared") authorizeShared("write");
        const dir = memoryDir(scope);
        const name = slugify(params.title);
        await withMemoryLock(dir, async () => {
          const body = `---\ntitle: ${params.title}\nupdatedAt: ${new Date().toISOString()}\n---\n\n${params.content.trim()}\n`;
          await fs.writeFile(path.join(dir, `${name}.md`), body, "utf8");
          await updateIndex(dir);
        });
        return ok(`Memoria guardada: ${scope}/${name}.md`);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_read",
      label: "Leer memoria",
      description:
        "Lee el contenido completo de una memoria guardada (por nombre, ver índice de memoria del system prompt). Si no pasas nombre, devuelve el índice del ámbito.",
      parameters: Type.Object({
        scope: scopeParam,
        name: Type.Optional(Type.String({ description: "Nombre (slug) de la memoria a leer" })),
      }),
      async execute(_id, params) {
        const scope = normalizeScope(params.scope);
        if (scope === "shared") authorizeShared("read");
        const dir = memoryDir(scope);
        if (!params.name) {
          const entries = await listEntries(dir);
          if (entries.length === 0) return ok("(memoria vacía)");
          return ok(entries.map((e) => `- ${e.name}: ${e.title} — ${e.firstLine}`).join("\n"));
        }
        const file = path.join(dir, `${path.basename(params.name).replace(/\.md$/, "")}.md`);
        try {
          return ok(await fs.readFile(file, "utf8"));
        } catch {
          return ok(`No existe la memoria "${params.name}" en el ámbito ${scope}`);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_delete",
      label: "Borrar memoria",
      description:
        "Elimina una memoria guardada que haya quedado obsoleta o sea incorrecta." +
        (withShared ? " Borrar en `shared` requiere acceso de escritura compartida." : ""),
      parameters: Type.Object({
        scope: scopeParam,
        name: Type.String({ description: "Nombre (slug) de la memoria a borrar" }),
      }),
      async execute(_id, params) {
        const scope = normalizeScope(params.scope);
        if (scope === "shared") authorizeShared("write");
        const dir = memoryDir(scope);
        const file = path.join(dir, `${path.basename(params.name).replace(/\.md$/, "")}.md`);
        const deleted = await withMemoryLock(dir, async () => {
          try {
            await fs.unlink(file);
          } catch {
            return false;
          }
          await updateIndex(dir);
          return true;
        });
        if (!deleted) return ok(`No existe la memoria "${params.name}" en el ámbito ${scope}`);
        return ok(`Memoria borrada: ${scope}/${params.name}`);
      },
    }),
  );
}
