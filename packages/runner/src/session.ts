import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
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

export type ResolvedModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

/** Crea AgentSessions del agente con system prompt (SYSTEM.md + memoria) y modelo configurados. */
export class SessionFactory {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly paths: AgentPaths;
  private readonly globalDir: string;

  constructor(
    private env: PihubEnv,
    public config: AgentConfig,
  ) {
    this.paths = agentPaths(env.dataDir, config.name);
    this.globalDir = dataPaths(env.dataDir).globalDir;
    this.authStorage = AuthStorage.create(path.join(this.globalDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.globalDir, "models.json"));
  }

  resolveModel(spec?: string): ReturnType<ModelRegistry["find"]> {
    const raw = spec ?? this.config.model;
    if (!raw) return undefined;
    const slash = raw.indexOf("/");
    if (slash < 0) return undefined;
    return this.modelRegistry.find(raw.slice(0, slash), raw.slice(slash + 1));
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
  listModels(): ModelInfo[] {
    this.modelRegistry.refresh();
    return this.modelRegistry.getAll().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      configured: this.modelRegistry.hasConfiguredAuth(model),
    }));
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

    const model = overrideModel ?? this.resolveModel();
    const { session } = await createAgentSession({
      cwd: this.paths.workspaceDir,
      agentDir: this.globalDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      ...(model ? { model } : {}),
      ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.paths.workspaceDir, this.paths.sessionsDir),
    });
    return session;
  }
}
