export type ThinkingLevel =
 | "off"
 | "minimal"
 | "low"
 | "medium"
 | "high"
 | "xhigh";

/** Nivel de acceso de un agente a la Shared Memory del User Runtime */
export type SharedMemoryAccess = "none" | "read" | "read-write";

export const SHARED_MEMORY_ACCESS_VALUES: readonly SharedMemoryAccess[] = [
 "none",
 "read",
 "read-write",
];

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
 /**
  * Dashboard Agent Policy: the agent-level gate for autonomous trigger
  * creation (v1). The dashboard (ADR 0036 role maxima) may tighten `enabled`
  * and `maxActiveAgentTriggers` later; this is the v1 agent-level gate.
  * Absent = defaults described in the Manager (enabled=true,
  * maxActiveAgentTriggers=5).
  */
 autonomy?: {
  triggers?: {
   /** Whether agents may create triggers at all. Default true. */
   enabled?: boolean;
   /** Max concurrently active agent-created triggers. Default 5. */
   maxActiveAgentTriggers?: number;
  };
 };
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

/** Capacidades que un Runner anuncia al conectar (P3.1). */
export type RunnerCapability = "prompt_context_v1" | "ask_human_v1";

/** Contexto de origen del turno que el Manager envía al Runner (P3.1). */
export type PromptContext = { kind: "human" } | { kind: "initiative" };

/** Mensajes WS cliente -> runner */
export type ClientWsMessage =
 | { type: "prompt"; text: string; context?: PromptContext }
 | { type: "abort" }
 | { type: "new_session" }
 /** Cambio de modelo en vivo: no persiste, se revierte al reiniciar el runner */
 | { type: "set_model"; model: string };

/** Mensajes WS runner -> cliente */
export type ServerWsMessage =
 | {
    type: "ready";
    agent: string;
    model?: string;
    sessionId: string;
    stt?: boolean;
    tts?: boolean;
    capabilities?: RunnerCapability[];
   }
 | { type: "agent_start" }
 | { type: "agent_end" }
 | { type: "text_delta"; delta: string }
 | { type: "thinking_delta"; delta: string }
 | { type: "tool_start"; toolName: string }
 | { type: "tool_end"; toolName: string; isError: boolean }
 | { type: "session_new"; sessionId: string }
 | { type: "model_changed"; model: string }
 | { type: "error"; message: string }
 /** P3.1: el Runner necesita respuesta humana */
 | {
    type: "human_input_required";
    question: string;
    summary: string;
    toolCallId: string;
   };

// --- Constantes del protocolo P3.1 ---

/** Longitud máxima de `question` en la tool ask_human (P3.1). */
export const ASK_HUMAN_QUESTION_MAX = 1000;

/** Longitud máxima de `summary` en la tool ask_human (P3.1). */
export const ASK_HUMAN_SUMMARY_MAX = 500;

/** Nombre reservado de la tool ask_human (P3.1). */
export const ASK_HUMAN_TOOL_NAME = "ask_human";

/** Nombre reservado de la tool schedule_trigger (pihub step 2b). */
export const SCHEDULE_TRIGGER_TOOL_NAME = "schedule_trigger";

/** Nombre reservado de la tool revoke_trigger (pihub step 2b). */
export const REVOKE_TRIGGER_TOOL_NAME = "revoke_trigger";

// --- Constantes de principal Runner (pihub step 2a, R1-008/R2-009) ---

/** Header con el que el Runner declara su principal sobre un Bearer de servicio. */
export const PIHUB_PRINCIPAL_HEADER = "X-Pihub-Principal";

/** Valor de `PIHUB_PRINCIPAL_HEADER` que identifica a un Runner (authority agent). */
export const PIHUB_RUNNER_PRINCIPAL = "runner";

/** Header con el que el Runner liga la petición al Agent que la emite. */
export const PIHUB_AGENT_HEADER = "X-Pihub-Agent";

/** Tipo de sesión interna del Runner: human o initiative (P3.1). */
export type SessionType = "human" | "initiative";
