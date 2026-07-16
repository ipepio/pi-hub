import { promises as fs } from "node:fs";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  agentPaths,
  allocatePort,
  dataPaths,
  isValidAgentName,
  piInstall,
  readAgent,
  scaffoldAgentDirs,
  writeAgent,
  type AgentConfig,
  type AgentMemoryConfig,
  type PihubEnv,
  type ThinkingLevel,
} from "@pihub/shared";

export interface CreateAgentInput {
  name: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  telegramToken?: string;
  ttsVoice?: string;
  memory?: AgentMemoryConfig;
  packages?: string[];
}

export interface UpdateAgentInput {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  telegramToken?: string | null;
  ttsVoice?: string | null;
  /** null elimina el override: el agente vuelve a PIHUB_SHARED_MEMORY_DEFAULT */
  memory?: AgentMemoryConfig | null;
  enabled?: boolean;
}

export async function createAgent(env: PihubEnv, input: CreateAgentInput): Promise<AgentConfig> {
  if (!isValidAgentName(input.name)) {
    throw new Error("Nombre inválido: usa minúsculas, números, guiones (máx. 64)");
  }
  if (await readAgent(env.dataDir, input.name)) {
    throw new Error(`El agente "${input.name}" ya existe`);
  }
  const paths = await scaffoldAgentDirs(env.dataDir, input.name);
  // El workspace lo crea pihub: se marca confiado para que el runner no se bloquee en el prompt de trust
  new ProjectTrustStore(dataPaths(env.dataDir).globalDir).set(paths.workspaceDir, true);
  const config: AgentConfig = {
    name: input.name,
    port: await allocatePort(env.dataDir, env.agentPortRange),
    model: input.model ?? env.defaultModel,
    thinkingLevel: input.thinkingLevel,
    telegramToken: input.telegramToken,
    ttsVoice: input.ttsVoice,
    // Sin override no se materializa el default: así los cambios futuros de
    // PIHUB_SHARED_MEMORY_DEFAULT aplican a este agente.
    memory: input.memory,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  await writeAgent(env.dataDir, config);
  if (input.systemPrompt) {
    await fs.writeFile(paths.systemPromptFile, input.systemPrompt, "utf8");
  }
  for (const source of input.packages ?? []) {
    const result = await piInstall(env.dataDir, source, paths.workspaceDir);
    if (!result.ok) {
      console.error(`[agents] fallo instalando ${source} en ${input.name}: ${result.stderr.slice(0, 300)}`);
    }
  }
  return config;
}

export async function updateAgent(
  env: PihubEnv,
  name: string,
  input: UpdateAgentInput,
): Promise<AgentConfig> {
  const config = await readAgent(env.dataDir, name);
  if (!config) throw new Error(`Agente desconocido: ${name}`);
  const paths = agentPaths(env.dataDir, name);

  if (input.model !== undefined) config.model = input.model;
  if (input.thinkingLevel !== undefined) config.thinkingLevel = input.thinkingLevel;
  if (input.enabled !== undefined) config.enabled = input.enabled;
  if (input.telegramToken !== undefined) config.telegramToken = input.telegramToken ?? undefined;
  if (input.ttsVoice !== undefined) config.ttsVoice = input.ttsVoice ?? undefined;
  if (input.memory !== undefined) config.memory = input.memory ?? undefined;
  await writeAgent(env.dataDir, config);

  if (input.systemPrompt !== undefined) {
    if (input.systemPrompt) {
      await fs.writeFile(paths.systemPromptFile, input.systemPrompt, "utf8");
    } else {
      await fs.unlink(paths.systemPromptFile).catch(() => {});
    }
  }
  return config;
}

export async function readSystemPrompt(env: PihubEnv, name: string): Promise<string> {
  return fs.readFile(agentPaths(env.dataDir, name).systemPromptFile, "utf8").catch(() => "");
}

export async function deleteAgent(env: PihubEnv, name: string): Promise<void> {
  const paths = agentPaths(env.dataDir, name);
  await fs.rm(paths.root, { recursive: true, force: true });
}

/** Paquetes declarados en settings de pi (global o del agente). */
export async function listPackages(env: PihubEnv, agentName?: string): Promise<string[]> {
  const settingsFile = agentName
    ? path.join(agentPaths(env.dataDir, agentName).workspacePiDir, "settings.json")
    : path.join(dataPaths(env.dataDir).globalDir, "settings.json");
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
