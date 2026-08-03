import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createRuntimeProviders, type ResolvedRuntimeModel } from "@pihub/providers";
import {
  agentPaths,
  dataPaths,
  readIndex,
  buildMemorySection,
  buildPlatformPrompt,
  resolveSharedMemoryAccess,
  type AgentConfig,
  type AgentPaths,
  type ModelInfo,
  type PihubEnv,
} from "@pihub/shared";

export type ResolvedModel = ResolvedRuntimeModel;

/**
 * Convierte una identidad de Channel Session en un directorio estable que
 * no puede escapar del workspace ni filtrar la clave original en el path.
 */
export function sessionStorageDirectory(sessionsDir: string, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest("hex");
  return path.join(sessionsDir, digest);
}

/** Crea AgentSessions del agente con system prompt (SYSTEM.md + memoria) y modelo configurados. */
export class SessionFactory {
  readonly runtimeProviders: ReturnType<typeof createRuntimeProviders>;
  readonly paths: AgentPaths;
  private readonly globalDir: string;

  private readonly env: PihubEnv;
  public readonly config: AgentConfig;

  constructor(env: PihubEnv, config: AgentConfig, sessionKey?: string) {
    this.env = env;
    this.config = config;
    const agent = agentPaths(env.dataDir, config.name);
    this.paths = sessionKey
      ? { ...agent, sessionsDir: sessionStorageDirectory(agent.sessionsDir, sessionKey) }
      : agent;
    this.globalDir = dataPaths(env.dataDir).globalDir;
    this.runtimeProviders = createRuntimeProviders({
      dataDir: env.dataDir,
      agentName: config.name,
      oauthProviders: env.oauthProviders,
    });
  }

  forSession(sessionKey: string): SessionFactory {
    return new SessionFactory(this.env, this.config, sessionKey);
  }

  async resolveModel(spec?: string): Promise<ResolvedModel | undefined> {
    const raw = spec ?? this.config.model;
    if (!raw) return undefined;
    return this.runtimeProviders.resolveModel(raw);
  }

  /**
   * Skills y prompt templates instalados (global + agente), invocables en el chat
   * como /skill:<nombre> y /<nombre> — pi los expande en session.prompt().
   */
  async listCommands(): Promise<{
    skills: Array<{ name: string; description: string }>;
    prompts: Array<{ name: string; description: string; argumentHint?: string }>;
  }> {
    const loader = new DefaultResourceLoader({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
    });
    await loader.reload();
    return {
      skills: loader.getSkills().skills.map((s) => ({ name: s.name, description: s.description })),
      prompts: loader.getPrompts().prompts.map((p) => ({
        name: p.name,
        description: p.description,
        ...(p.argumentHint ? { argumentHint: p.argumentHint } : {}),
      })),
    };
  }

  /** Modelos disponibles (models.json + built-ins de pi) con su estado de credenciales. */
  async listModels(): Promise<ModelInfo[]> {
    return (await this.runtimeProviders.snapshot()).models;
  }

  private async memorySection(): Promise<string> {
    if (!this.env.memoryEnabled) return "";
    const sharedAccess = resolveSharedMemoryAccess(this.config, this.env);
    const agentIndex = (await readIndex(this.paths.memoryDir)).trim();
    // Con "none" ni siquiera se lee el índice compartido: el agente no debe saber que existe.
    const sharedIndex =
      sharedAccess === "none" ? "" : (await readIndex(dataPaths(this.env.dataDir).globalMemoryDir)).trim();
    return buildMemorySection({ memoryEnabled: true, sharedAccess, agentIndex, sharedIndex });
  }

  private platformSection(): string {
    if (!this.env.platformPromptEnabled) return "";
    return buildPlatformPrompt({
      agentName: this.config.name,
      memoryEnabled: this.env.memoryEnabled,
      telegram: Boolean(this.config.telegramToken),
    });
  }

  async create(overrideModel?: ResolvedModel): Promise<AgentSession> {
    const custom = await fs.readFile(this.paths.systemPromptFile, "utf8").catch(() => "");
    const platform = this.platformSection();
    const memory = await this.memorySection();

    const loader = new DefaultResourceLoader({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
      // Capas del system prompt: persona (soul) → entorno pihub → memoria
      systemPromptOverride: (base) =>
        [custom.trim() || base || "", platform, memory]
          .filter((section) => section && section.trim())
          .join("\n\n"),
    });
    await loader.reload();

    const model = overrideModel ?? (await this.resolveModel());
    return this.runtimeProviders.createSession({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
      ...(model ? { model } : {}),
      ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.paths.workspaceDir, this.paths.sessionsDir),
    });
  }
}
