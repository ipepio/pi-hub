import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfig, SharedMemoryAccess } from "./types.js";
import type { PihubEnv } from "./env.js";

export interface MemoryEntry {
  name: string;
  title: string;
  description: string;
  updatedAt: string;
}

/**
 * Única fuente de verdad del nivel de acceso a Shared Memory: la usan el
 * supervisor (env inyectada al runner) y el runner (system prompt) para que
 * enforcement y prompt nunca diverjan.
 */
export function resolveSharedMemoryAccess(
  config: Pick<AgentConfig, "memory">,
  env: Pick<PihubEnv, "sharedMemoryDefault">,
): SharedMemoryAccess {
  return config.memory?.sharedAccess ?? env.sharedMemoryDefault;
}

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Serializa escrituras en un directorio de memoria entre procesos (varios
 * runners escriben la Shared Memory a la vez). Lock por directorio `.lock`
 * (mkdir es atómico); locks huérfanos se roban por antigüedad de mtime.
 * Mantener en sync con la copia inline de packages/memory-extension/src/pihub-memory.ts.
 */
export async function withMemoryLock<T>(memoryDir: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(memoryDir, { recursive: true });
  const lockDir = path.join(memoryDir, ".lock");
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

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "memoria";
}

export async function saveMemory(
  memoryDir: string,
  title: string,
  content: string,
): Promise<MemoryEntry> {
  // Entrada + índice bajo el mismo lock: si no, dos escritores pueden indexar sin verse.
  return withMemoryLock(memoryDir, async () => {
    const name = slugify(title);
    const updatedAt = new Date().toISOString();
    const description = content.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
    const body = `---\ntitle: ${title}\nupdatedAt: ${updatedAt}\n---\n\n${content.trim()}\n`;
    await fs.writeFile(path.join(memoryDir, `${name}.md`), body, "utf8");
    const entry = { name, title, description, updatedAt };
    await updateIndex(memoryDir);
    return entry;
  });
}

export async function readMemory(memoryDir: string, name: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(memoryDir, sanitize(name)), "utf8");
  } catch {
    return undefined;
  }
}

export async function deleteMemory(memoryDir: string, name: string): Promise<boolean> {
  return withMemoryLock(memoryDir, async () => {
    try {
      await fs.unlink(path.join(memoryDir, sanitize(name)));
    } catch {
      return false;
    }
    await updateIndex(memoryDir);
    return true;
  });
}

export async function listMemories(memoryDir: string): Promise<MemoryEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(memoryDir);
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    const raw = await fs.readFile(path.join(memoryDir, file), "utf8").catch(() => "");
    const title = /^title:\s*(.+)$/m.exec(raw)?.[1] ?? file.replace(/\.md$/, "");
    const updatedAt = /^updatedAt:\s*(.+)$/m.exec(raw)?.[1] ?? "";
    const bodyStart = raw.indexOf("---", 3);
    const body = bodyStart > 0 ? raw.slice(bodyStart + 3) : raw;
    const description = body.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
    entries.push({ name: file.replace(/\.md$/, ""), title, description, updatedAt });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Regenera MEMORY.md, el índice que se inyecta en el system prompt. */
export async function updateIndex(memoryDir: string): Promise<void> {
  const entries = await listMemories(memoryDir);
  const lines = entries.map((e) => `- **${e.name}**: ${e.title} — ${e.description}`);
  const content = lines.length ? lines.join("\n") + "\n" : "";
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), content, "utf8");
}

export async function readIndex(memoryDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
  } catch {
    return "";
  }
}

function sanitize(name: string): string {
  const base = path.basename(name);
  return base.endsWith(".md") ? base : `${base}.md`;
}
