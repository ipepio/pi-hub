import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { dataPaths, readEnvStore, type ModelInfo } from "@pihub/shared";

export interface RuntimeProvidersConfig {
  dataDir: string;
  /** Agent-specific Env Store layered over the global Store in a Runner. */
  agentName?: string;
  /** Optional image seed, owned and materialized by this Module. */
  modelsSeedPath?: string;
  overwriteModels?: boolean;
  /** IDs requested by PIHUB_OAUTH_PROVIDERS. Values are validated against Pi. */
  oauthProviders: readonly string[];
}

export interface RuntimeProviderConfigurationIssue {
  code: "UNKNOWN_OAUTH_PROVIDER" | "INVALID_MODELS_CONFIGURATION";
  providerId?: string;
}

export interface RuntimeOAuthProvider {
  id: string;
  name: string;
  loggedIn: boolean;
}

export type RuntimeOAuthFlowPhase =
  | "starting"
  | "auth_url"
  | "device_code"
  | "input"
  | "select"
  | "done"
  | "error";

export interface RuntimeOAuthFlowState {
  id: string;
  provider: string;
  phase: RuntimeOAuthFlowPhase;
  url?: string;
  instructions?: string;
  userCode?: string;
  message?: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string }>;
  progress?: string;
  error?: string;
}

export type RuntimeProviderOrigin = "built_in" | "models_json" | "managed" | "extension";
export type RuntimeProviderStatus = "connected" | "missing_credentials" | "error";

export interface RuntimeProviderSummary {
  id: string;
  name: string;
  origin: RuntimeProviderOrigin;
  authMethods: Array<"api_key" | "oauth">;
  status: RuntimeProviderStatus;
  models: ModelInfo[];
  capabilities: string[];
}

export interface RuntimeProviderSnapshot {
  models: ModelInfo[];
  providers: RuntimeProviderSummary[];
  oauthProviders: RuntimeOAuthProvider[];
  configurationIssues: RuntimeProviderConfigurationIssue[];
}

export interface RuntimeCustomProviderModelDefinition {
  id: string;
  name: string;
}

export interface RuntimeCustomProviderDefinition {
  baseUrl: string;
  models: RuntimeCustomProviderModelDefinition[];
}

export type RuntimeProviderCommand =
  | { type: "refresh" }
  | { type: "logout-oauth"; providerId: string }
  | { type: "start-oauth-login"; providerId: string }
  | { type: "submit-oauth-input"; flowId: string; value: string }
  | {
      type: "upsert-custom-provider";
      providerId: string;
      definition: RuntimeCustomProviderDefinition;
      apiKey?: string;
    }
  | { type: "delete-custom-provider"; providerId: string };

export type RuntimeProviderChange =
  | { kind: "refreshed"; snapshot: RuntimeProviderSnapshot }
  | { kind: "custom_provider_applied" | "custom_provider_deleted"; snapshot: RuntimeProviderSnapshot }
  | { kind: "oauth_logged_out"; snapshot: RuntimeProviderSnapshot }
  | {
      kind: "oauth_flow_started" | "oauth_flow_updated";
      flow: RuntimeOAuthFlowState;
      snapshot: RuntimeProviderSnapshot;
    };

/** Modelo de Pi resuelto por el catálogo efectivo, sin exponer su registro ni almacenamiento. */
export type ResolvedRuntimeModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

/**
 * Interface del Module de Runtime Provider Connections.
 *
 * Los callers solo conocen el catálogo seguro, los comandos de cambio y la
 * resolución/sesión. AuthStorage, ModelRegistry y los archivos globales quedan
 * dentro de la implementación.
 */
export interface RuntimeProviderMutation {
  kind: "credentials_changed" | "definition_changed";
  providerId: string;
  operation: "login" | "logout" | "definition";
}

export interface RuntimeProviders {
  snapshot(): Promise<RuntimeProviderSnapshot>;
  apply(command: RuntimeProviderCommand): Promise<RuntimeProviderChange>;
  resolveModel(spec: string): Promise<ResolvedRuntimeModel | undefined>;
  createSession(options?: Omit<CreateAgentSessionOptions, "authStorage" | "modelRegistry">): Promise<AgentSession>;
  oauthFlow(id: string): RuntimeOAuthFlowState | undefined;
  initialize(): Promise<void>;
  onChange(listener: (mutation: RuntimeProviderMutation) => void): () => void;
}

function oauthSnapshot(
  authStorage: AuthStorage,
  requested: readonly string[],
): Pick<RuntimeProviderSnapshot, "oauthProviders" | "configurationIssues"> {
  const known = new Map(authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
  const configurationIssues = requested
    .filter((providerId) => !known.has(providerId))
    .map((providerId) => ({ code: "UNKNOWN_OAUTH_PROVIDER" as const, providerId }));
  const enabled = new Set(requested);
  const oauthProviders = [...known.values()]
    .filter((provider) => enabled.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      loggedIn: authStorage.getAuthStatus(provider.id).configured && authStorage.has(provider.id),
    }));
  return { oauthProviders, configurationIssues };
}

function modelSnapshot(registry: ModelRegistry): ModelInfo[] {
  return registry.getAll().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    configured: registry.hasConfiguredAuth(model),
  }));
}

interface ModelsFile {
  providers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function validProviderId(providerId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId);
}

function validProviderDefinition(definition: RuntimeCustomProviderDefinition): boolean {
  try {
    const url = new URL(definition.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
  } catch {
    return false;
  }
  return (
    Array.isArray(definition.models) &&
    definition.models.length > 0 &&
    definition.models.every(
      (model) =>
        typeof model.id === "string" &&
        model.id.length > 0 &&
        model.id.length <= 200 &&
        typeof model.name === "string" &&
        model.name.length > 0 &&
        model.name.length <= 200,
    )
  );
}

async function readModelsFile(modelsPath: string): Promise<ModelsFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(modelsPath, "utf8")) as Partial<ModelsFile>;
    if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
      throw new Error("invalid");
    }
    return { ...parsed, providers: { ...parsed.providers } } as ModelsFile;
  } catch {
    try {
      await fs.access(modelsPath);
    } catch {
      return { providers: {} };
    }
    throw new Error("Provider catalog unavailable");
  }
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function providerSnapshot(
  authStorage: AuthStorage,
  registry: ModelRegistry,
  modelsPath: string,
  models: ModelInfo[],
  requestedOauth: readonly string[],
): Promise<{
  providers: RuntimeProviderSummary[];
  configurationIssues: RuntimeProviderConfigurationIssue[];
}> {
  const oauth = new Map(authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
  const modelsByProvider = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const current = modelsByProvider.get(model.provider) ?? [];
    current.push(model);
    modelsByProvider.set(model.provider, current);
  }

  let customProviderIds = new Set<string>();
  let invalidModelsConfiguration = false;
  try {
    const parsed = JSON.parse(await fs.readFile(modelsPath, "utf8")) as {
      providers?: Record<string, unknown>;
    };
    if (parsed.providers && typeof parsed.providers === "object") {
      customProviderIds = new Set(Object.keys(parsed.providers));
    }
  } catch {
    // A missing file is normal: Pi's built-ins are still a valid catalog.
    try {
      await fs.access(modelsPath);
      invalidModelsConfiguration = true;
    } catch {
      // Keep the built-in catalog without manufacturing an error.
    }
  }

  const providerIds = new Set([...modelsByProvider.keys(), ...oauth.keys()]);
  const providers = [...providerIds].sort().map((id): RuntimeProviderSummary => {
    const providerModels = modelsByProvider.get(id) ?? [];
    const authStatus = registry.getProviderAuthStatus(id);
    const oauthProvider = oauth.get(id);
    const hasConfiguredModel = providerModels.some((model) => model.configured);
    const authMethods: RuntimeProviderSummary["authMethods"] = [];
    if (oauthProvider) authMethods.push("oauth");
    if ((hasConfiguredModel || authStatus.configured) && !oauthProvider) authMethods.push("api_key");
    const status: RuntimeProviderStatus =
      invalidModelsConfiguration && customProviderIds.has(id)
        ? "error"
        : authMethods.length === 0 || hasConfiguredModel || authStatus.configured
          ? "connected"
          : "missing_credentials";
    return {
      id,
      name: oauthProvider?.name || registry.getProviderDisplayName(id) || id,
      origin: customProviderIds.has(id) ? "models_json" : "built_in",
      authMethods,
      status,
      models: providerModels,
      capabilities: [],
    };
  });

  const configurationIssues: RuntimeProviderConfigurationIssue[] = invalidModelsConfiguration
    ? [{ code: "INVALID_MODELS_CONFIGURATION" }]
    : [];
  // Keep the requested list observable through the same safe, typed issue shape.
  for (const providerId of requestedOauth) {
    if (!oauth.has(providerId)) configurationIssues.push({ code: "UNKNOWN_OAUTH_PROVIDER", providerId });
  }
  return { providers, configurationIssues };
}

/** Adapter filesystem real de RuntimeProviders para un User Runtime. */
export function createRuntimeProviders(config: RuntimeProvidersConfig): RuntimeProviders {
  const requestedOAuth = config.oauthProviders ?? [];
  let resources:
    | { authStorage: AuthStorage; modelRegistry: ModelRegistry }
    | undefined;
  const listeners = new Set<(mutation: RuntimeProviderMutation) => void>();
  const flows = new Map<
    string,
    {
      state: RuntimeOAuthFlowState;
      pendingInput?: (value: string) => void;
      abort: AbortController;
      createdAt: number;
    }
  >();

  const getResources = (): { authStorage: AuthStorage; modelRegistry: ModelRegistry } => {
    if (!resources) {
      const globalDir = dataPaths(config.dataDir).globalDir;
      const authStorage = AuthStorage.create(path.join(globalDir, "auth.json"));
      resources = {
        authStorage,
        modelRegistry: ModelRegistry.create(authStorage, path.join(globalDir, "models.json")),
      };
    }
    return resources;
  };

  const hydrateEnvCredentials = async (authStorage: AuthStorage): Promise<void> => {
    const [globalStore, agentStore] = await Promise.all([
      readEnvStore(config.dataDir),
      config.agentName
        ? readEnvStore(config.dataDir, config.agentName)
        : Promise.resolve({} as Record<string, string>),
    ]);
    const effectiveStore = { ...globalStore, ...agentStore };
    const configuredModels = await readModelsFile(modelsPath()).catch(() => ({ providers: {} }));
    for (const [providerId, definition] of Object.entries(configuredModels.providers)) {
      const reference = definition.apiKey;
      if (typeof reference !== "string" || !reference.startsWith("$")) {
        authStorage.removeRuntimeApiKey(providerId);
        continue;
      }
      const key = effectiveStore[reference.slice(1)];
      if (typeof key === "string" && key.length > 0) authStorage.setRuntimeApiKey(providerId, key);
      else authStorage.removeRuntimeApiKey(providerId);
    }
  };

  const refresh = async (): Promise<{ authStorage: AuthStorage; modelRegistry: ModelRegistry }> => {
    const { authStorage, modelRegistry } = getResources();
    authStorage.reload();
    modelRegistry.refresh();
    await hydrateEnvCredentials(authStorage);
    return { authStorage, modelRegistry };
  };

  const snapshot = async (): Promise<RuntimeProviderSnapshot> => {
    const { authStorage, modelRegistry } = await refresh();
    const models = modelSnapshot(modelRegistry);
    const oauth = oauthSnapshot(authStorage, requestedOAuth);
    const firstClass = await providerSnapshot(
      authStorage,
      modelRegistry,
      path.join(dataPaths(config.dataDir).globalDir, "models.json"),
      models,
      requestedOAuth,
    );
    return {
      models,
      providers: firstClass.providers,
      oauthProviders: oauth.oauthProviders,
      configurationIssues: firstClass.configurationIssues,
    };
  };

  const gc = (): void => {
    const now = Date.now();
    for (const [id, flow] of flows) {
      if (now - flow.createdAt > 10 * 60_000) {
        flow.abort.abort();
        flows.delete(id);
      }
    }
  };

  const oauthEnabled = (authStorage: AuthStorage, providerId: string): boolean => {
    const known = new Set(authStorage.getOAuthProviders().map((provider) => provider.id));
    return requestedOAuth.includes(providerId) && known.has(providerId);
  };

  const safeOAuthError = (): string => "OAuth login failed";
  const notify = (mutation: RuntimeProviderMutation): void => {
    for (const listener of listeners) {
      try {
        listener(mutation);
      } catch {
        // A reload observer must never change the effective credential result.
      }
    }
  };

  const modelsPath = (): string => path.join(dataPaths(config.dataDir).globalDir, "models.json");

  const restoreCredential = (authStorage: AuthStorage, providerId: string, credential: unknown): void => {
    if (credential && typeof credential === "object") {
      authStorage.set(providerId, credential as Parameters<AuthStorage["set"]>[1]);
    } else {
      authStorage.remove(providerId);
    }
  };

  const upsertCustomProvider = async (command: Extract<RuntimeProviderCommand, { type: "upsert-custom-provider" }>): Promise<RuntimeProviderChange> => {
    if (!validProviderId(command.providerId) || !validProviderDefinition(command.definition)) {
      throw new Error("Invalid custom Provider definition");
    }
    if (command.apiKey !== undefined && command.apiKey.length === 0) {
      throw new Error("Invalid custom Provider credential");
    }

    const { authStorage, modelRegistry } = await refresh();
    const file = modelsPath();
    const previous = await readModelsFile(file);
    const existed = Object.prototype.hasOwnProperty.call(previous.providers, command.providerId);
    if (!existed && modelRegistry.getAll().some((model) => model.provider === command.providerId)) {
      throw new Error("Custom Provider collides with a built-in Provider");
    }
    const previousCredential = authStorage.get(command.providerId);
    const next: ModelsFile = {
      ...previous,
      providers: {
        ...previous.providers,
        [command.providerId]: {
          baseUrl: command.definition.baseUrl,
          api: "openai-completions",
          models: command.definition.models.map((model) => ({
            id: model.id,
            name: model.name,
            api: "openai-completions",
          })),
        },
      },
    };

    try {
      if (command.apiKey !== undefined) {
        authStorage.set(command.providerId, { type: "api_key", key: command.apiKey });
      }
      await writeJsonAtomically(file, next);
      modelRegistry.refresh();
      if (modelRegistry.getError()) throw new Error("invalid");
    } catch {
      await writeJsonAtomically(file, previous).catch(() => {});
      restoreCredential(authStorage, command.providerId, previousCredential);
      modelRegistry.refresh();
      throw new Error("Custom Provider could not be applied");
    }

    notify({ kind: "definition_changed", providerId: command.providerId, operation: "definition" });
    return { kind: "custom_provider_applied", snapshot: await snapshot() };
  };

  const deleteCustomProvider = async (command: Extract<RuntimeProviderCommand, { type: "delete-custom-provider" }>): Promise<RuntimeProviderChange> => {
    if (!validProviderId(command.providerId)) throw new Error("Invalid custom Provider id");
    const { authStorage, modelRegistry } = await refresh();
    const file = modelsPath();
    const previous = await readModelsFile(file);
    if (!Object.prototype.hasOwnProperty.call(previous.providers, command.providerId)) {
      throw new Error("Custom Provider not found");
    }
    const previousCredential = authStorage.get(command.providerId);
    const nextProviders = { ...previous.providers };
    delete nextProviders[command.providerId];
    const next: ModelsFile = { ...previous, providers: nextProviders };

    try {
      await writeJsonAtomically(file, next);
      authStorage.remove(command.providerId);
      modelRegistry.refresh();
      if (modelRegistry.getError()) throw new Error("invalid");
    } catch {
      await writeJsonAtomically(file, previous).catch(() => {});
      restoreCredential(authStorage, command.providerId, previousCredential);
      modelRegistry.refresh();
      throw new Error("Custom Provider could not be deleted");
    }

    notify({ kind: "definition_changed", providerId: command.providerId, operation: "definition" });
    return { kind: "custom_provider_deleted", snapshot: await snapshot() };
  };

  const initialize = async (): Promise<void> => {
    if (!config.modelsSeedPath) return;
    const target = modelsPath();
    let targetExists = true;
    try {
      await fs.access(target);
    } catch {
      targetExists = false;
    }
    if (targetExists && !config.overwriteModels) return;

    const content = await fs.readFile(config.modelsSeedPath);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const startOAuthLogin = async (providerId: string): Promise<RuntimeProviderChange> => {
    const { authStorage } = await refresh();
    if (!oauthEnabled(authStorage, providerId)) {
      throw new Error(`OAuth provider "${providerId}" is not enabled`);
    }
    gc();
    const abort = new AbortController();
    const state: RuntimeOAuthFlowState = { id: randomUUID(), provider: providerId, phase: "starting" };
    const flow = { state, abort, createdAt: Date.now() } as {
      state: RuntimeOAuthFlowState;
      pendingInput?: (value: string) => void;
      abort: AbortController;
      createdAt: number;
    };
    flows.set(state.id, flow);

    const waitInput = (patch: Partial<RuntimeOAuthFlowState>): Promise<string> =>
      new Promise<string>((resolve) => {
        Object.assign(flow.state, patch);
        flow.pendingInput = (value) => {
          flow.pendingInput = undefined;
          resolve(value);
        };
      });

    void authStorage
      .login(providerId, {
        signal: abort.signal,
        onAuth: (info) => {
          flow.state.phase = "auth_url";
          flow.state.url = info.url;
          flow.state.instructions = info.instructions;
        },
        onDeviceCode: (info) => {
          flow.state.phase = "device_code";
          flow.state.url = info.verificationUri;
          flow.state.userCode = info.userCode;
        },
        onProgress: (message) => {
          flow.state.progress = message;
        },
        onPrompt: (prompt) => waitInput({ phase: "input", message: prompt.message, placeholder: prompt.placeholder }),
        onManualCodeInput: () => waitInput({ phase: "input", message: "Paste the authorization code" }),
        onSelect: (prompt) => waitInput({ phase: "select", message: prompt.message, options: prompt.options }),
      })
      .then(() => {
        flow.state.phase = "done";
        notify({ kind: "credentials_changed", providerId, operation: "login" });
      })
      .catch(() => {
        flow.state.phase = "error";
        flow.state.error = safeOAuthError();
      });

    return {
      kind: "oauth_flow_started",
      flow: { ...state },
      snapshot: await snapshot(),
    };
  };

  return {
    snapshot,

    async apply(command): Promise<RuntimeProviderChange> {
      if (command.type === "logout-oauth") {
        const { authStorage } = await refresh();
        authStorage.logout(command.providerId);
        notify({ kind: "credentials_changed", providerId: command.providerId, operation: "logout" });
        return { kind: "oauth_logged_out", snapshot: await snapshot() };
      }
      if (command.type === "upsert-custom-provider") return upsertCustomProvider(command);
      if (command.type === "delete-custom-provider") return deleteCustomProvider(command);
      if (command.type === "start-oauth-login") return startOAuthLogin(command.providerId);
      if (command.type === "submit-oauth-input") {
        const flow = flows.get(command.flowId);
        if (!flow) throw new Error("OAuth flow unavailable");
        if (!flow.pendingInput) throw new Error("OAuth flow is not waiting for input");
        flow.state.phase = "starting";
        flow.pendingInput(command.value);
        return {
          kind: "oauth_flow_updated",
          flow: { ...flow.state },
          snapshot: await snapshot(),
        };
      }
      return { kind: "refreshed", snapshot: await snapshot() };
    },

    async resolveModel(spec): Promise<ResolvedRuntimeModel | undefined> {
      const { modelRegistry } = await refresh();
      const separator = spec.indexOf("/");
      if (separator <= 0 || separator === spec.length - 1) return undefined;
      return modelRegistry.find(spec.slice(0, separator), spec.slice(separator + 1));
    },

    async createSession(options = {}): Promise<AgentSession> {
      const { authStorage, modelRegistry } = await refresh();
      const { session } = await createAgentSession({
        ...options,
        authStorage,
        modelRegistry,
      });
      return session;
    },

    oauthFlow(id): RuntimeOAuthFlowState | undefined {
      const flow = flows.get(id);
      return flow ? { ...flow.state } : undefined;
    },

    initialize,

    onChange(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
