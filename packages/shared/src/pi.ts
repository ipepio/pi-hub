import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { dataPaths } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface PiCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Env base para cualquier proceso pi: agentDir global compartido. */
export function piEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: dataPaths(dataDir).globalDir,
    ...extra,
  };
}

export function agentPiEnv(dataDir: string, agentName: string): NodeJS.ProcessEnv {
  return piEnv(dataDir, {
    PI_CODING_AGENT_SESSION_DIR: path.join(dataPaths(dataDir).agentsDir, agentName, "sessions"),
  });
}

async function runPi(args: string[], dataDir: string, cwd?: string): Promise<PiCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("pi", args, {
      env: piEnv(dataDir),
      cwd: cwd ?? dataPaths(dataDir).globalDir,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(error) };
  }
}

/** Instala un paquete pi. scope global => settings del agentDir; agente => .pi/ del workspace. */
export async function piInstall(
  dataDir: string,
  source: string,
  agentWorkspace?: string,
): Promise<PiCommandResult> {
  const args = agentWorkspace ? ["install", "-l", source] : ["install", source];
  return runPi(args, dataDir, agentWorkspace);
}

export async function piRemove(
  dataDir: string,
  source: string,
  agentWorkspace?: string,
): Promise<PiCommandResult> {
  const args = agentWorkspace ? ["remove", "-l", source] : ["remove", source];
  return runPi(args, dataDir, agentWorkspace);
}

export async function piList(dataDir: string, agentWorkspace?: string): Promise<PiCommandResult> {
  return runPi(["list"], dataDir, agentWorkspace);
}

/** Fuentes de paquetes declaradas en un settings.json de pi (global o de proyecto). */
export async function readPackageSources(settingsFile: string): Promise<string[]> {
  const { promises: fs } = await import("node:fs");
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      packages?: Array<string | { source?: string }>;
    };
    return (raw.packages ?? [])
      .map((p) => (typeof p === "string" ? p : p.source ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function piVersion(dataDir: string): Promise<string> {
  const result = await runPi(["--version"], dataDir);
  return result.stdout.trim() || "unknown";
}
