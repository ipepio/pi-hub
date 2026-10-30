import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerWsMessage, SessionType } from "@pihub/shared";
import { ASK_HUMAN_TOOL_NAME } from "@pihub/shared";
import { ExecutionBusyError, ExecutionGate } from "./execution-gate.ts";
import type { ResolvedModel, SessionFactory } from "./session.js";

type Listener = (message: ServerWsMessage) => void;

/** Sesión web compartida del agente: un AgentSession activo, N clientes suscritos. */
export class ChatHub {
  private readonly factory: SessionFactory;
  /** Gate de ejecución compartida con TODAS las hubs del Runner (ver `execution-gate.ts`). */
  private gate: ExecutionGate;
  /** Identidad de esta hub dentro de la gate (diagnóstico y token de liberación). */
  private readonly label: string;
  /** true desde la admisión hasta el asentamiento real del SDK (incluye la creación). */
  private executing = false;
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

  constructor(factory: SessionFactory, gate?: ExecutionGate, label = "default") {
    this.factory = factory;
    this.gate = gate ?? new ExecutionGate();
    this.label = label;
  }

  /**
   * El registry de producción adjunta la MISMA gate a todas sus hubs: una
   * ejecución por Runner, no por `sessionKey`. Una hub que ya ejecuta no puede
   * cambiar de gate (se quedaría sin su latch de admisión).
   */
  attachExecutionGate(gate: ExecutionGate): void {
    if (this.gate === gate) return;
    if (this.isStreaming) {
      throw new Error(
        `No se puede cambiar la gate de ejecución de ${this.label} con un turno en curso`,
      );
    }
    this.gate = gate;
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

  /**
   * Lanza un prompt sin bloquear; los resultados llegan por eventos.
   *
   * **Admisión (T4c, S2)**: la gate se toma de forma SÍNCRONA, antes del primer
   * `await` — es decir, antes de crear la sesión. Si ya hay una ejecución en
   * curso, este prompt se RECHAZA con `ExecutionBusyError` en vez de encolarse
   * como `followUp` del SDK: encolarlo lo ejecutaría más tarde, sin que nadie lo
   * haya pedido en ese momento, y el cliente creería que su turno corre ya.
   *
   * La gate se mantiene hasta que la promesa del SDK se asienta (resuelve o
   * rechaza), que es el único punto en el que el Runner confirma que dejó de
   * ejecutar. El contrato de retorno no cambia: resuelve cuando el prompt fue
   * ACEPTADO, no cuando la generación termina.
   */
  async prompt(text: string, context?: { kind: "human" | "initiative" }): Promise<void> {
    if (!this.gate.tryAcquire(this.label)) {
      throw new ExecutionBusyError(this.gate.currentHolder);
    }
    this.executing = true;

    let run: Promise<void>;
    try {
      // P3.1: fijar tipo de sesión (solo el primer prompt cuenta)
      if (context?.kind === "initiative") {
        this._sessionType = "initiative";
      }
      // Resetear el latch Ask para este prompt
      this._askEmittedThisPrompt = false;

      const session = await this.ensureSession();
      // Sin `streamingBehavior`: si el SDK ya está streaming, eso es un error real
      // y se propaga; nunca se encola un turno ajeno en la sesión en curso.
      run = session.prompt(text);
    } catch (error) {
      this.finishExecution();
      throw error;
    }

    // Un fallo de la generación es del turno: se avisa a los suscriptores de
    // ESTA hub (no rompe el proceso) y se libera la gate igual que un éxito.
    void run.then(
      () => this.finishExecution(),
      (error: unknown) => {
        this.finishExecution();
        this.broadcastRunError(error);
      },
    );
  }

  /** Suelta el latch y la gate: SOLO con el prompt ya asentado (o nunca empezado). */
  private finishExecution(): void {
    this.executing = false;
    this.gate.release(this.label);
  }

  /**
   * Avisa del fallo de una generación a los suscriptores de esta hub. Un
   * listener que lanza no puede dejar una promesa rechazada sin consumidor: la
   * gate ya está liberada y el turno ya terminó.
   */
  private broadcastRunError(error: unknown): void {
    try {
      this.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } catch (cause) {
      console.error(`[runner] no se pudo emitir el error del turno de ${this.label}:`, cause);
    }
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
    if (this.isStreaming) {
      // Descartar la AgentSession en ejecución la mataría por debajo y liberaría
      // la admisión sin terminal real: la ruta que lo pide responde 409.
      throw new Error(
        "Hay una ejecución en curso; espera a que termine para crear una sesión nueva",
      );
    }
    this.reset();
    // P3.6: tras reset, la siguiente creación debe ser fresh: nunca reabrir la
    // sesión descartada aunque sea la más reciente del directorio.
    this.factory.useFreshCreation();
    const session = await this.ensureSession();
    this.broadcast({ type: "session_new", sessionId: session.sessionId });
    return session.sessionId;
  }

  /**
   * Descarta la sesión activa (se recrea perezosamente con recursos frescos).
   *
   * Nunca descarta una ejecución en curso: `reset()` también lo invocan la
   * recarga de recursos, el cierre del servidor y el apagado, así que rechaza en
   * silencio (con log) en vez de lanzar. La sesión se descarta cuando la
   * ejecución se asienta y la siguiente creación la reemplaza.
   */
  reset(): void {
    if (this.isStreaming) {
      console.warn(
        `[runner] reset() ignorado en ${this.label}: hay una ejecución en curso`,
      );
      return;
    }
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

  /**
   * ¿Hay trabajo en curso en esta hub? Incluye la CREACIÓN de la sesión y la
   * ventana entre el terminal del SDK y el asentamiento de su promesa, no solo
   * `AgentSession.isStreaming`.
   */
  get isStreaming(): boolean {
    return this.executing || this.session?.isStreaming === true;
  }
}

/**
 * Registry de sesiones de un Agent. Cada Channel Session obtiene un ChatHub
 * y, por tanto, un AgentSession y un directorio de transcript propios.
 */
export class SessionHubRegistry {
  private readonly hubs = new Map<string, ChatHub>();
  private readonly factory: SessionFactory;
  /** UNA gate por Runner/registry: la comparten el hub por defecto y todas las keyed. */
  private readonly gate = new ExecutionGate();

  constructor(factory: SessionFactory, defaultHub?: ChatHub) {
    this.factory = factory;
    if (defaultHub) {
      // Producción pasa una hub ya construida: se le adjunta la gate del registry
      // ANTES de que pueda recibir ningún prompt.
      defaultHub.attachExecutionGate(this.gate);
      this.hubs.set("default", defaultHub);
    }
  }

  forKey(sessionKey: string): ChatHub {
    const key = sessionKey.trim() || "default";
    const existing = this.hubs.get(key);
    if (existing) return existing;

    const hub = new ChatHub(this.factory.forSession(key), this.gate, key);
    this.hubs.set(key, hub);
    return hub;
  }

  /**
   * ¿Hay trabajo pendiente en el Runner? La gate manda (incluye la creación de
   * la sesión y el asentamiento); el barrido de hubs es la red de seguridad.
   */
  get isStreaming(): boolean {
    return this.gate.busy || [...this.hubs.values()].some((hub) => hub.isStreaming);
  }

  /**
   * Estado de la gate COMPARTIDA, tal y como lo publica `GET /api/status` (T4-D/2).
   *
   * Existe porque el Manager necesita reconciliar al arrancar las reservas de
   * admisión durables (`agent_live_turns`): para saber si el Runner sigue ejecutando
   * ESE turno tiene que ver desde fuera si hay una ejecución en curso y de quién es.
   * El `holder` es el `label` de la hub que tomó la gate — la `sessionKey` con la que
   * el Manager abrió el turno (`default` cuando no mandó ninguna) —, es decir, la
   * MISMA identidad que el Manager guarda en la fila durable. `isStreaming` no sirve
   * para esto: incluye el hub por defecto y no dice quién ejecuta.
   */
  get execution(): { busy: boolean; holder: string | null } {
    return { busy: this.gate.busy, holder: this.gate.currentHolder ?? null };
  }

  reset(): void {
    for (const hub of this.hubs.values()) hub.reset();
    this.hubs.clear();
  }
}
