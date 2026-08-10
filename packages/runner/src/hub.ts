import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerWsMessage, SessionType } from "@pihub/shared";
import { ASK_HUMAN_TOOL_NAME } from "@pihub/shared";
import type { ResolvedModel, SessionFactory } from "./session.js";

type Listener = (message: ServerWsMessage) => void;

/** Sesión web compartida del agente: un AgentSession activo, N clientes suscritos. */
export class ChatHub {
  private readonly factory: SessionFactory;
  private session?: AgentSession;
  private creating?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private listeners = new Set<Listener>();
  /** Modelo cambiado en vivo desde la UI; no persiste, muere con el proceso. */
  private modelOverride?: ResolvedModel;
  /** Tipo de sesión (P3.1): se fija con el primer prompt y no cambia. */
  private _sessionType: SessionType = "human";
  /** Latch: solo una emisión Ask por prompt. */
  private _askEmittedThisPrompt = false;

  constructor(factory: SessionFactory) {
    this.factory = factory;
  }

  /** Tipo de sesión actual (P3.1). Inmutable tras el primer prompt. */
  get sessionType(): SessionType {
    return this._sessionType;
  }

  /**
   * Fija el tipo de sesión. Solo se acepta el primer valor; los posteriores
   * se rechazan para evitar que un prompt de tipo distinto cambie el tipo
   * sobre la misma clave.
   */
  setSessionType(type: SessionType): void {
    if (this._sessionType !== type && this.session) {
      // Ya hay sesión creada con un tipo distinto — rechazar
      throw new Error(`Cannot change session type from ${this._sessionType} to ${type} on an active session`);
    }
    this._sessionType = type;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(message: ServerWsMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    // Guard contra creación concurrente: si dos prompts llegan a la vez, comparten
    // la misma promesa en lugar de crear (y filtrar) dos AgentSession.
    if (!this.creating) {
      this.creating = (async () => {
        // P3.1: propagar el tipo de sesión a la factory antes de crear
        (this.factory as { sessionType: SessionType }).sessionType = this._sessionType;
        const session = await this.factory.create(this.modelOverride);
        this.unsubscribe = session.subscribe((event) => this.onEvent(event));
        this.session = session;
        return session;
      })().finally(() => {
        this.creating = undefined;
      });
    }
    return this.creating;
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.broadcast({ type: "agent_start" });
        break;
      case "agent_end":
        this.broadcast({ type: "agent_end" });
        break;
      case "message_update": {
        const e = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (e?.type === "text_delta" && e.delta) {
          this.broadcast({ type: "text_delta", delta: e.delta });
        } else if (e?.type === "thinking_delta" && e.delta) {
          this.broadcast({ type: "thinking_delta", delta: e.delta });
        }
        break;
      }
      case "tool_execution_start": {
        const toolName = (event as { toolName?: string }).toolName ?? "tool";
        this.broadcast({ type: "tool_start", toolName });
        break;
      }
      case "tool_execution_end": {
        const e = event as { toolName?: string; isError?: boolean; result?: { details?: { question?: string; summary?: string } }; toolCallId?: string };
        const toolName = e.toolName ?? "tool";

        // P3.1: emitir tool_end primero (el resultado ya está incorporado)
        this.broadcast({ type: "tool_end", toolName, isError: !!e.isError });

        // P3.1: ask_human — emitir human_input_required y abortar
        if (toolName === ASK_HUMAN_TOOL_NAME && !e.isError && !this._askEmittedThisPrompt) {
          this._askEmittedThisPrompt = true;
          this.broadcast({
            type: "human_input_required",
            question: e.result?.details?.question ?? "",
            summary: e.result?.details?.summary ?? "",
            toolCallId: e.toolCallId ?? "",
          });
          // Abortar el run después de tool_execution_end (cinturón de seguridad)
          void this.session?.abort();
        }
        break;
      }
      default:
        break;
    }
  }

  /** Lanza un prompt sin bloquear; los resultados llegan por eventos. */
  async prompt(text: string, context?: { kind: "human" | "initiative" }): Promise<void> {
    // P3.1: fijar tipo de sesión (solo el primer prompt cuenta)
    if (context?.kind === "initiative") {
      this._sessionType = "initiative";
    }
    // Resetear el latch Ask para este prompt
    this._askEmittedThisPrompt = false;

    const session = await this.ensureSession();
    const options = session.isStreaming ? ({ streamingBehavior: "followUp" } as const) : undefined;
    session.prompt(text, options).catch((error: unknown) => {
      this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Cambia el modelo de la sesión web en caliente. No persiste en agent.json:
   * las sesiones nuevas ("Nueva sesión") lo mantienen, el reinicio del runner
   * lo revierte al modelo por defecto. Lanza con mensaje legible si falla.
   */
  async setModel(spec: string): Promise<void> {
    if (this.isStreaming) {
      throw new Error("Hay una respuesta en curso; espera a que termine para cambiar de modelo");
    }
    const model = await this.factory.resolveModel(spec);
    if (!model) throw new Error(`Modelo desconocido: ${spec} (formato proveedor/id)`);
    const session = await this.ensureSession();
    await session.setModel(model); // lanza si no hay credenciales configuradas
    this.modelOverride = model;
    this.broadcast({ type: "model_changed", model: `${model.provider}/${model.id}` });
  }

  async newSession(): Promise<string> {
    this.reset();
    const session = await this.ensureSession();
    this.broadcast({ type: "session_new", sessionId: session.sessionId });
    return session.sessionId;
  }

  /** Descarta la sesión activa (se recrea perezosamente con recursos frescos). */
  reset(): void {
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
    this.unsubscribe = undefined;
    this._askEmittedThisPrompt = false;
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get modelId(): string | undefined {
    const model = this.session?.model as { provider?: string; id?: string } | undefined;
    if (model?.provider && model.id) return `${model.provider}/${model.id}`;
    if (this.modelOverride) return `${this.modelOverride.provider}/${this.modelOverride.id}`;
    return this.factory.config.model;
  }

  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }
}

/**
 * Registry de sesiones de un Agent. Cada Channel Session obtiene un ChatHub
 * y, por tanto, un AgentSession y un directorio de transcript propios.
 */
export class SessionHubRegistry {
  private readonly hubs = new Map<string, ChatHub>();
  private readonly factory: SessionFactory;

  constructor(factory: SessionFactory, defaultHub?: ChatHub) {
    this.factory = factory;
    if (defaultHub) this.hubs.set("default", defaultHub);
  }

  forKey(sessionKey: string): ChatHub {
    const key = sessionKey.trim() || "default";
    const existing = this.hubs.get(key);
    if (existing) return existing;

    const hub = new ChatHub(this.factory.forSession(key));
    this.hubs.set(key, hub);
    return hub;
  }

  get isStreaming(): boolean {
    return [...this.hubs.values()].some((hub) => hub.isStreaming);
  }

  reset(): void {
    for (const hub of this.hubs.values()) hub.reset();
    this.hubs.clear();
  }
}
