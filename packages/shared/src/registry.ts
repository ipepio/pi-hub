import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./types.js";

export interface AgentPaths {
  root: string;
  configFile: string;
  systemPromptFile: string;
  memoryDir: string;
  sessionsDir: string;
  workspaceDir: string;
  workspacePiDir: string;
}

export interface DataPaths {
  dataDir: string;
  globalDir: string;
  globalMemoryDir: string;
  agentsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    globalDir: path.join(dataDir, "global"),
    globalMemoryDir: path.join(dataDir, "global", "memory"),
    agentsDir: path.join(dataDir, "agents"),
  };
}

export function agentPaths(dataDir: string, name: string): AgentPaths {
  const root = path.join(dataDir, "agents", name);
  return {
    root,
    configFile: path.join(root, "agent.json"),
    systemPromptFile: path.join(root, "SYSTEM.md"),
    memoryDir: path.join(root, "memory"),
    sessionsDir: path.join(root, "sessions"),
    workspaceDir: path.join(root, "workspace"),
    workspacePiDir: path.join(root, "workspace", ".pi"),
  };
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function isValidAgentName(name: string): boolean {
  return NAME_RE.test(name);
}

export async function listAgents(dataDir: string): Promise<AgentConfig[]> {
  const { agentsDir } = dataPaths(dataDir);
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return [];
  }
  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    const config = await readAgent(dataDir, entry);
    if (config) agents.push(config);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readAgent(dataDir: string, name: string): Promise<AgentConfig | undefined> {
  try {
    const raw = await fs.readFile(agentPaths(dataDir, name).configFile, "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return undefined;
  }
}

export async function writeAgent(dataDir: string, config: AgentConfig): Promise<void> {
  const paths = agentPaths(dataDir, config.name);
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(paths.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Crea el árbol de directorios de un agente (idempotente). */
export async function scaffoldAgentDirs(dataDir: string, name: string): Promise<AgentPaths> {
  const paths = agentPaths(dataDir, name);
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(path.join(paths.workspacePiDir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(paths.workspacePiDir, "skills"), { recursive: true });
  await fs.mkdir(path.join(paths.workspacePiDir, "prompts"), { recursive: true });
  return paths;
}

export async function scaffoldGlobalDirs(dataDir: string): Promise<DataPaths> {
  const paths = dataPaths(dataDir);
  await fs.mkdir(paths.globalMemoryDir, { recursive: true });
  for (const sub of ["extensions", "skills", "prompts"]) {
    await fs.mkdir(path.join(paths.globalDir, sub), { recursive: true });
  }
  await fs.mkdir(paths.agentsDir, { recursive: true });
  return paths;
}

export async function allocatePort(dataDir: string, range: [number, number]): Promise<number> {
  const used = new Set((await listAgents(dataDir)).map((a) => a.port));
  for (let port = range[0]; port <= range[1]; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No quedan puertos libres en el rango ${range[0]}-${range[1]}`);
}
