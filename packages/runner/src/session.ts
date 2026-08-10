import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
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
  ASK_HUMAN_TOOL_NAME,
  type SessionType,
} from "@pihub/shared";

import { askHumanTool } from "./ask-human.ts";

export type ResolvedModel = ResolvedRuntimeModel;

/**
 * P3.6: modo de creación de sesión.
 * - `resumeLatest`: reabre la sesión más reciente del directorio (factory keyed
 *   tras un restart); si no existe, el SDK crea una nueva.
 * - `fresh`: siempre crea una sesión nueva (new_session y standalone).
 */
export type SessionCreationMode = "resumeLatest" | "fresh";

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
  private extensionProvidersPrepared = false;
  public readonly config: AgentConfig;
  /** P3.1: human o initiative — controla la tool ask_human reservada. */
  public sessionType: SessionType = "human";
  /** P3.6: modo de creación de la siguiente sesión (ver SessionCreationMode). */
  public creationMode: SessionCreationMode;

  constructor(
    env: PihubEnv,
    config: AgentConfig,
    sessionKey?: string,
    sessionType?: SessionType,
    creationMode: SessionCreationMode = "fresh",
  ) {
    if (sessionType) this.sessionType = sessionType;
    this.env = env;
    this.config = config;
    const agent = agentPaths(env.dataDir, config.name);
    this.paths = sessionKey
      ? { ...agent, sessionsDir: sessionStorageDirectory(agent.sessionsDir, sessionKey) }
      : agent;
    this.globalDir = dataPaths(env.dataDir).globalDir;
    this.creationMode = creationMode;
    this.runtimeProviders = createRuntimeProviders({
      dataDir: env.dataDir,
      agentName: config.name,
      oauthProviders: env.oauthProviders,
    });
  }

  /**
   * P3.6: factory keyed — su primera creación reanuda la sesión más reciente
   * del directorio de esa sessionKey (tras un restart) en lugar de abrir una
   * nueva; si no hay ninguna sesión, el SDK crea una nueva.
   */
  forSession(sessionKey: string): SessionFactory {
    return new SessionFactory(this.env, this.config, sessionKey, this.sessionType, "resumeLatest");
  }

  /**
   * P3.6: la siguiente creación debe ser una sesión nueva (new_session), nunca
   * reabrir la conversación descartada por reset().
   */
  useFreshCreation(): void {
    this.creationMode = "fresh";
  }

  private async ensureExtensionProviders(): Promise<void> {
    if (this.extensionProvidersPrepared) return;
    const loader = new DefaultResourceLoader({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
    });
    await loader.reload();
    await this.runtimeProviders.registerExtensionProviders(loader);
    this.extensionProvidersPrepared = true;
  }

  async resolveModel(spec?: string): Promise<ResolvedModel | undefined> {
    await this.ensureExtensionProviders();
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
    await this.ensureExtensionProviders();
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
    await this.runtimeProviders.registerExtensionProviders(loader);
    this.extensionProvidersPrepared = true;

    const model = overrideModel ?? (await this.resolveModel());

    // P3.1: sesión human → excluye ask_human (incluso si una extensión la registra);
    //        sesión initiative → inyecta la tool SDK reservada.
    const sessionOptions: { excludeTools?: string[]; customTools?: ToolDefinition[] } =
      this.sessionType === "initiative"
        ? { customTools: [askHumanTool] }
        : { excludeTools: [ASK_HUMAN_TOOL_NAME] };

    return this.runtimeProviders.createSession({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
      ...sessionOptions,
      ...(model ? { model } : {}),
      ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
      resourceLoader: loader,
      // P3.6: keyed → reanuda la última sesión del directorio (o crea si no existe);
      //       fresh (new_session / standalone) → siempre una sesión nueva.
      sessionManager:
        this.creationMode === "resumeLatest"
          ? SessionManager.continueRecent(this.paths.workspaceDir, this.paths.sessionsDir)
          : SessionManager.create(this.paths.workspaceDir, this.paths.sessionsDir),
    });
  }
}
