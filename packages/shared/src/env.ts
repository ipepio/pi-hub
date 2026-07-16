import { SHARED_MEMORY_ACCESS_VALUES, type SharedMemoryAccess } from "./types.js";

export interface PihubEnv {
  dataDir: string;
  apiToken: string;
  managerPort: number;
  agentPortRange: [number, number];
  panelEnabled: boolean;
  globalPackages: string[];
  defaultModel?: string;
  overwriteModels: boolean;
  memoryEnabled: boolean;
  /** Acceso a Shared Memory para agentes sin override (memory.sharedAccess) */
  sharedMemoryDefault: SharedMemoryAccess;
  platformPromptEnabled: boolean;
  oauthProviders: string[];
  telegramAllowedUsers: number[];
  /** Ruta a un manifiesto JSON de agentes a provisionar al arrancar (PIHUB_AGENTS_FILE) */
  agentsFile?: string;
  /** URL base de un servidor de audio OpenAI-compatible (speaches, LocalAI...). Vacío = voz desactivada */
  speechUrl?: string;
  speechApiKey?: string;
  /** Modelo STT (p.ej. whisper-1 / Systran/faster-whisper-small). Requiere speechUrl */
  sttModel?: string;
  /** Modelo TTS (p.ej. kokoro). Requiere speechUrl */
  ttsModel?: string;
  /** Voz TTS por defecto de la plataforma (cada agente puede tener la suya) */
  ttsVoice?: string;
  /** Horas que se conservan los archivos subidos al workspace antes de borrarse */
  uploadsRetentionHours: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parsePortRange(value: string | undefined): [number, number] {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(value ?? "");
  if (!match) return [4100, 4199];
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (lo >= hi) throw new Error(`PIHUB_AGENT_PORT_RANGE inválido: ${value}`);
  return [lo, hi];
}

export function parseSharedMemoryAccess(value: string | undefined): SharedMemoryAccess {
  if (value === undefined || value === "") return "none";
  if ((SHARED_MEMORY_ACCESS_VALUES as readonly string[]).includes(value)) return value as SharedMemoryAccess;
  throw new Error(`PIHUB_SHARED_MEMORY_DEFAULT inválido: ${value} (valores: none | read | read-write)`);
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): PihubEnv {
  return {
    dataDir: env.PIHUB_DATA_DIR ?? "/data",
    apiToken: env.API_TOKEN ?? "",
    managerPort: Number(env.PIHUB_MANAGER_PORT ?? 4000),
    agentPortRange: parsePortRange(env.PIHUB_AGENT_PORT_RANGE),
    panelEnabled: bool(env.PIHUB_PANEL_ENABLED, true),
    globalPackages: list(env.PIHUB_GLOBAL_PACKAGES),
    defaultModel: env.PIHUB_DEFAULT_MODEL || undefined,
    overwriteModels: bool(env.PIHUB_OVERWRITE_MODELS, false),
    memoryEnabled: bool(env.PIHUB_MEMORY_ENABLED, true),
    sharedMemoryDefault: parseSharedMemoryAccess(env.PIHUB_SHARED_MEMORY_DEFAULT),
    platformPromptEnabled: bool(env.PIHUB_PLATFORM_PROMPT_ENABLED, true),
    oauthProviders: list(env.PIHUB_OAUTH_PROVIDERS),
    telegramAllowedUsers: list(env.PIHUB_TELEGRAM_ALLOWED_USERS).map(Number).filter((n) => !Number.isNaN(n)),
    agentsFile: env.PIHUB_AGENTS_FILE || undefined,
    speechUrl: (env.PIHUB_SPEECH_URL || "").replace(/\/+$/, "") || undefined,
    speechApiKey: env.PIHUB_SPEECH_API_KEY || undefined,
    sttModel: env.PIHUB_STT_MODEL || undefined,
    ttsModel: env.PIHUB_TTS_MODEL || undefined,
    ttsVoice: env.PIHUB_TTS_VOICE || undefined,
    uploadsRetentionHours: Number(env.PIHUB_UPLOADS_RETENTION_HOURS ?? 24) || 24,
  };
}
