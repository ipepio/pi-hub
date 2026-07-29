import { promises as fs } from "node:fs";
import path from "node:path";
import { agentPaths, dataPaths } from "./registry.js";

/**
 * Variables de entorno reservadas: no se pueden fijar ni pisar desde el store
 * (ni global ni por agente). Protegen la config de la plataforma y los secretos
 * de arranque del contenedor.
 */
export const PROTECTED_ENV_KEYS = ["API_TOKEN"];
export const PROTECTED_ENV_PREFIXES = ["PIHUB_", "PI_CODING_AGENT_"];

export function isProtectedEnvKey(key: string): boolean {
  if (PROTECTED_ENV_KEYS.includes(key)) return true;
  return PROTECTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables del entorno del sistema que un Runner necesita para comportarse
 * como un proceso normal. Todo lo demás debe entrar por un EnvStore explícito.
 */
const RUNNER_SYSTEM_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

export function isValidEnvKey(key: string): boolean {
  return KEY_RE.test(key);
}

export type EnvStore = Record<string, string>;

function globalEnvFile(dataDir: string): string {
  return path.join(dataPaths(dataDir).globalDir, "env.json");
}

function agentEnvFile(dataDir: string, agentName: string): string {
  return path.join(agentPaths(dataDir, agentName).root, "env.json");
}

function envFile(dataDir: string, agentName?: string): string {
  return agentName ? agentEnvFile(dataDir, agentName) : globalEnvFile(dataDir);
}

export async function readEnvStore(dataDir: string, agentName?: string): Promise<EnvStore> {
  try {
    const raw = JSON.parse(await fs.readFile(envFile(dataDir, agentName), "utf8")) as EnvStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function writeEnvStore(dataDir: string, store: EnvStore, agentName?: string): Promise<void> {
  const file = envFile(dataDir, agentName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** Fija una variable. Lanza si la clave es inválida o está protegida. */
export async function setEnv(
  dataDir: string,
  key: string,
  value: string,
  agentName?: string,
): Promise<void> {
  if (!isValidEnvKey(key)) throw new Error(`Nombre de variable inválido: ${key}`);
  if (isProtectedEnvKey(key)) throw new Error(`La variable "${key}" está protegida y no se puede fijar`);
  const store = await readEnvStore(dataDir, agentName);
  store[key] = value;
  await writeEnvStore(dataDir, store, agentName);
}

export async function unsetEnv(dataDir: string, key: string, agentName?: string): Promise<boolean> {
  const store = await readEnvStore(dataDir, agentName);
  if (!(key in store)) return false;
  delete store[key];
  await writeEnvStore(dataDir, store, agentName);
  return true;
}

/**
 * Env efectivo de un runner: allowlist del sistema + store global + store del
 * agente. Precedencia: agente > global > sistema. Las claves protegidas del
 * store se ignoran por seguridad (no deberían existir, pero se filtran por si
 * acaso). Las variables internas de pihub se inyectan después, en el
 * Supervisor, cuando ya se conoce el Agent concreto.
 */
export async function resolveRunnerEnv(
  dataDir: string,
  agentName: string,
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const globalStore = await readEnvStore(dataDir);
  const agentStore = await readEnvStore(dataDir, agentName);
  const merged: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_SYSTEM_ENV_KEYS) {
    const value = base[key];
    if (value !== undefined) merged[key] = value;
  }
  for (const store of [globalStore, agentStore]) {
    for (const [key, value] of Object.entries(store)) {
      if (isProtectedEnvKey(key)) continue;
      merged[key] = value;
    }
  }
  return merged;
}

/** Solo las claves (para no exponer secretos por la API). */
export async function listEnvKeys(dataDir: string, agentName?: string): Promise<string[]> {
  return Object.keys(await readEnvStore(dataDir, agentName)).sort();
}

/**
 * Reemplaza el store COMPLETO por `entries` — no un merge como `setEnv`.
 * Valida TODAS las claves antes de escribir nada: si una es inválida o
 * protegida, no se persiste ninguna, para no dejar el store a medias.
 */
export async function replaceEnvStore(
  dataDir: string,
  entries: EnvStore,
  agentName?: string,
): Promise<void> {
  for (const key of Object.keys(entries)) {
    if (!isValidEnvKey(key)) throw new Error(`Nombre de variable inválido: ${key}`);
    if (isProtectedEnvKey(key)) {
      throw new Error(`La variable "${key}" está protegida y no se puede fijar`);
    }
  }
  await writeEnvStore(dataDir, { ...entries }, agentName);
}
