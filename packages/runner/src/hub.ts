import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerWsMessage } from "@pihub/shared";
import type { ResolvedModel, SessionFactory } from "./session.js";

type Listener = (message: ServerWsMessage) => void;

/** Sesión web compartida del agente: un AgentSession activo, N clientes suscritos. */
export class ChatHub {
  private session?: AgentSession;
  private creating?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private listeners = new Set<Listener>();
  /** Modelo cambiado en vivo desde la UI; no persiste, muere con el proceso. */
  private modelOverride?: ResolvedModel;

  constructor(private factory: SessionFactory) {}

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
        const e = event as { toolName?: string; isError?: boolean };
        this.broadcast({ type: "tool_end", toolName: e.toolName ?? "tool", isError: !!e.isError });
        break;
      }
      default:
        break;
    }
  }

  /** Lanza un prompt sin bloquear; los resultados llegan por eventos. */
  async prompt(text: string): Promise<void> {
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
    const model = this.factory.resolveModel(spec);
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
