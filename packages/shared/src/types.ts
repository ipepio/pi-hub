export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Nivel de acceso de un agente a la Shared Memory del User Runtime */
export type SharedMemoryAccess = "none" | "read" | "read-write";

export const SHARED_MEMORY_ACCESS_VALUES: readonly SharedMemoryAccess[] = ["none", "read", "read-write"];

export interface AgentMemoryConfig {
  /** Acceso a la Shared Memory; si falta, aplica PIHUB_SHARED_MEMORY_DEFAULT */
  sharedAccess?: SharedMemoryAccess;
}

/** Metadatos de un agente, persistidos en /data/agents/<name>/agent.json */
export interface AgentConfig {
  name: string;
  port: number;
  /** "provider/id", p.ej. "anthropic/claude-sonnet-5" */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  telegramToken?: string;
  /** Voz TTS propia del agente; si falta se usa la global (PIHUB_TTS_VOICE) */
  ttsVoice?: string;
  /** Configuración de memoria del agente (solo acceso, nunca contenido) */
  memory?: AgentMemoryConfig;
  enabled: boolean;
  createdAt: string;
}

export type AgentRunState = "running" | "stopped" | "errored";

export interface AgentStatus extends AgentConfig {
  state: AgentRunState;
  pid?: number;
  telegram: boolean;
}

export type PackageScope = "global" | "agent";

export interface InstallRequest {
  source: string;
  scope: PackageScope;
  /** requerido cuando scope === "agent" */
  agent?: string;
}

/** Un modelo disponible según models.json + credenciales configuradas */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  /** true si hay credenciales (API key u OAuth) para usarlo */
  configured: boolean;
}

/** Mensajes WS cliente -> runner */
export type ClientWsMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "new_session" }
  /** Cambio de modelo en vivo: no persiste, se revierte al reiniciar el runner */
  | { type: "set_model"; model: string };

/** Mensajes WS runner -> cliente */
export type ServerWsMessage =
  | { type: "ready"; agent: string; model?: string; sessionId: string; stt?: boolean; tts?: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "session_new"; sessionId: string }
  | { type: "model_changed"; model: string }
  | { type: "error"; message: string };
