import {
  SHARED_MEMORY_ACCESS_VALUES,
  type SharedMemoryAccess,
} from "./types.js";

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
  /**
   * Chat privado primario de Telegram para la entrega de preguntas humanas
   * (PIHUB_TELEGRAM_PRIMARY_CHAT_ID, [ÁRBITRO-1]): ausente = panel-only y
   * cero llamadas a Telegram (fail-closed). Debe ser miembro de
   * `telegramAllowedUsers` y positivo (los IDs negativos son grupos/canales).
   */
  telegramPrimaryChatId?: number;
  /** Ruta a un manifiesto JSON de agentes a provisionar al arrancar (PIHUB_AGENTS_FILE) */
  agentsFile?: string;
  /**
   * Token efímero de callback Runner→Manager (PIHUB_RUNNER_CALLBACK_TOKEN). Se
   * captura en `loadEnv` en memoria y luego `scrubProtectedProcessEnv` lo borra
   * del `process.env`: es la única credencial de `POST /internal/runner/…`.
   */
  runnerCallbackToken?: string;
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
  /** Dial del Loop: cuántas Initiatives vuelan a la vez (PIHUB_LOOP_CONCURRENCY, entero ≥1, ADR 0004). */
  loopConcurrency: number;
  /** Periodicidad del `tick` del Loop en ms (PIHUB_LOOP_POLL_MS, entero positivo; §2.4). */
  loopPollMs: number;
  /** Gracia del shutdown del Loop en ms (PIHUB_LOOP_GRACE_MS; 0 = abort inmediato; §1.3). */
  loopGraceMs: number;
  /** Margen post-abort del shutdown en ms (PIHUB_LOOP_POST_ABORT_MARGIN_MS; §1.3). */
  loopPostAbortMarginMs: number;
  /**
   * Watchdog de apertura/silencio del turno en ms (PIHUB_TURN_DISPATCH_TIMEOUT_MS;
   * §4.6): si el Runner no produce `agent_start`/actividad en ese plazo, el turno
   * se aborta con `turn-error` (`runner_unavailable`). `0` lo desactiva. Calibración
   * (§10): el default es real y NO cero — `0` significaría watchdog desactivado.
   */
  turnDispatchTimeoutMs: number;
  /**
   * Caducidad de `waiting_human` en ms (PIHUB_WAITING_HUMAN_EXPIRY_MS; §6,
   * CONTEXT.md:39-40): cuánto espera una Initiative al humano antes de pasar
   * a `expired`. Positivo — cero significaría caducar al instante.
   */
  waitingHumanExpiryMs: number;
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

function positiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} inválido: ${value} (entero positivo)`);
  return n;
}

function nonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} inválido: ${value} (entero ≥ 0)`);
  return n;
}

/**
 * PIHUB_TELEGRAM_PRIMARY_CHAT_ID — [ÁRBITRO-1]: el enrutado de Telegram se
 * configura por variable de entorno, no por comando de bot. Fail-fast y
 * fail-closed: ausente → `undefined` (panel-only, cero llamadas a Telegram);
 * presente → chat privado positivo (entero seguro) y MIEMBRO de la allowlist,
 * que no puede estar vacía. Los IDs negativos son grupos/canales de Telegram
 * y se rechazan. Cualquier violación lanza con la variable y el motivo.
 */
export function parseTelegramPrimaryChatId(
  value: string | undefined,
  telegramAllowedUsers: number[],
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `PIHUB_TELEGRAM_PRIMARY_CHAT_ID inválido: ${value} (chat privado positivo, número entero seguro)`,
    );
  }
  if (telegramAllowedUsers.length === 0) {
    throw new Error(
      `PIHUB_TELEGRAM_PRIMARY_CHAT_ID=${value} requiere PIHUB_TELEGRAM_ALLOWED_USERS no vacía (fail-closed: sin allowlist no hay enrutado)`,
    );
  }
  if (!telegramAllowedUsers.includes(n)) {
    throw new Error(
      `PIHUB_TELEGRAM_PRIMARY_CHAT_ID=${value} no está en PIHUB_TELEGRAM_ALLOWED_USERS (${telegramAllowedUsers.join(", ")})`,
    );
  }
  return n;
}

export function parsePortRange(value: string | undefined): [number, number] {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(value ?? "");
  if (!match) return [4100, 4199];
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (lo >= hi) throw new Error(`PIHUB_AGENT_PORT_RANGE inválido: ${value}`);
  return [lo, hi];
}

export function parseSharedMemoryAccess(
  value: string | undefined,
): SharedMemoryAccess {
  if (value === undefined || value === "") return "none";
  if ((SHARED_MEMORY_ACCESS_VALUES as readonly string[]).includes(value))
    return value as SharedMemoryAccess;
  throw new Error(
    `PIHUB_SHARED_MEMORY_DEFAULT inválido: ${value} (valores: none | read | read-write)`,
  );
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): PihubEnv {
  const telegramAllowedUsers = list(env.PIHUB_TELEGRAM_ALLOWED_USERS)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
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
    sharedMemoryDefault: parseSharedMemoryAccess(
      env.PIHUB_SHARED_MEMORY_DEFAULT,
    ),
    platformPromptEnabled: bool(env.PIHUB_PLATFORM_PROMPT_ENABLED, true),
    oauthProviders: list(env.PIHUB_OAUTH_PROVIDERS),
    telegramAllowedUsers,
    telegramPrimaryChatId: parseTelegramPrimaryChatId(
      env.PIHUB_TELEGRAM_PRIMARY_CHAT_ID,
      telegramAllowedUsers,
    ),
    agentsFile: env.PIHUB_AGENTS_FILE || undefined,
    speechUrl: (env.PIHUB_SPEECH_URL || "").replace(/\/+$/, "") || undefined,
    speechApiKey: env.PIHUB_SPEECH_API_KEY || undefined,
    runnerCallbackToken: env.PIHUB_RUNNER_CALLBACK_TOKEN || undefined,
    sttModel: env.PIHUB_STT_MODEL || undefined,
    ttsModel: env.PIHUB_TTS_MODEL || undefined,
    ttsVoice: env.PIHUB_TTS_VOICE || undefined,
    uploadsRetentionHours:
      Number(env.PIHUB_UPLOADS_RETENTION_HOURS ?? 24) || 24,
    loopConcurrency: positiveInt(
      env.PIHUB_LOOP_CONCURRENCY,
      1,
      "PIHUB_LOOP_CONCURRENCY",
    ),
    loopPollMs: positiveInt(env.PIHUB_LOOP_POLL_MS, 1000, "PIHUB_LOOP_POLL_MS"),
    loopGraceMs: nonNegativeInt(
      env.PIHUB_LOOP_GRACE_MS,
      5000,
      "PIHUB_LOOP_GRACE_MS",
    ),
    loopPostAbortMarginMs: nonNegativeInt(
      env.PIHUB_LOOP_POST_ABORT_MARGIN_MS,
      1000,
      "PIHUB_LOOP_POST_ABORT_MARGIN_MS",
    ),
    turnDispatchTimeoutMs: nonNegativeInt(
      env.PIHUB_TURN_DISPATCH_TIMEOUT_MS,
      30_000,
      "PIHUB_TURN_DISPATCH_TIMEOUT_MS",
    ),
    waitingHumanExpiryMs: positiveInt(
      env.PIHUB_WAITING_HUMAN_EXPIRY_MS,
      604_800_000,
      "PIHUB_WAITING_HUMAN_EXPIRY_MS",
    ),
  };
}
