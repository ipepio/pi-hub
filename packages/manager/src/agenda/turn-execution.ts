/**
 * TurnExecution — Fase 3.1 + Fase 3.2 del plan de Fase 3
 * (`docs/design-autonomia-loop-schedule.md` §4, §9.3.1-3.2).
 *
 * El puente WS→eventos→terminal que vivía inline en la ruta
 * `POST /agents/:name/turns` (`routes.ts:991-1066`) se extrajo aquí **sin
 * cambiar comportamiento** en la Fase 3.1. La ruta HTTP es un adaptador fino
 * que llama `startTurn` y traduce los eventos a SSE (`streamSSE`); el Loop
 * (Fase 3.5) llamará al mismo `startTurn` y consumirá solo `completion`, sin
 * traducir SSE.
 *
 * Fase 3.2 — "Cerrar el hueco del terminal" (§9.3.2): **todo turno aceptado
 * produce exactamente un terminal**. `completion` resuelve siempre con un
 * evento terminal, nunca con `undefined`:
 * - `agent_end` → `turn-complete` (o `turn-aborted` si hubo abort);
 * - `error` del Runner → `turn-error` (causa `turn_failed`);
 * - `close` del Runner sin terminal limpio, error de conexión o timeout de
 *   despacho → `turn-error` (causa `runner_unavailable`) — el cierre mudo de
 *   la ruta original (§4.6) desaparece;
 * - un envío del prompt que falla tras aceptar el turno → `turn-error`
 *   (causa `dispatch_failed`);
 * - `disconnect()` (el cliente se fue) → `turn-error` (`runner_unavailable`).
 *
 * Cuando se inyecta el repositorio durable (Fase 3.2: tests y futuro Loop),
 * el terminal se escribe además con `turns.complete` en la misma transacción
 * de T6, con la causa del catálogo `turn_failed|runner_unavailable|
 * dispatch_failed` (§5.2). La ruta HTTP de esta fase no lo inyecta (la
 * idempotencia sigue en el `Map` en memoria; el claim unificado es la Fase
 * 3.4), así que un turno humano sin reserva durable se tolera: el SSE ya
 * entregó el evento y `TURN_NOT_FOUND`/`TURN_ALREADY_TERMINAL` no son fallos.
 *
 * El registro de turnos vivos vive aquí (`turnosVivos`): es el que consultan
 * las rutas para rechazar stop/restart/reload con `TURN_IN_PROGRESS` (§6.3,
 * sin distinguir el origen del turno) y el que sirve el abort
 * (`routes.ts:1103-1134` → `abort`).
 */

import WebSocket from "ws";
import { hasLiveTurnForAgent } from "../api-v1/restart-policy.ts";
import {
  toTurnEvent,
  type TurnEventProfile,
  type TurnSseEvent,
} from "../api-v1/turns.ts";
import { DomainError } from "./errors.ts";
import { TurnRepository, type FailureCause, type TurnFinalState } from "./turns.ts";

/** Turno vivo con WS abierto contra el Runner (clave `agentName:turnId`). */
interface TurnoVivo {
  ws: WebSocket;
  abortRequested: boolean;
}

/**
 * Mensaje crudo del Runner por WS (superficie mínima de `ServerWsMessage` de
 * `@pihub/shared`). `toTurnEvent` lo traduce al vocabulario público.
 */
interface MensajeRunner {
  type: string;
  delta?: unknown;
  message?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

/**
 * Origen del turno (ADR 0013, plan §4.3): para Initiatives lleva la
 * Initiative y su causa; para turnos humanos, `{ kind: 'human' }`. La ruta
 * HTTP pasa `human`; el Loop pasará el de la Initiative. En Fase 3.1/3.2 es
 * metadata de despacho: no cambia el puente ni el mensaje `prompt` que el
 * Runner recibe.
 */
export type TurnOrigin =
  | { kind: "human" }
  | { kind: "initiative"; initiativeId: string; cause: "trigger" | "callback" | "human" };

/** Comando de `startTurn`: todo lo que el puente necesita para abrir el turno. */
export interface StartTurnCommand {
  /** Agent que ejecuta el turno (nombre de dominio; cualifica `turnId`). */
  readonly agentName: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  /** Correlation ID de despacho (§4.7), distinto de `ask_correlation` (pendiente 11). */
  readonly correlationId: string;
  /** `sessionKey` aislada que se pasa al Runner por WS. */
  readonly sessionKey: string;
  /** Prompt que se envía al Runner (`{type:"prompt", text}`). */
  readonly message: string;
  /** Puerto del Runner (`supervisor.statusOf`); nunca sale hacia el caller. */
  readonly runnerPort: number;
  /** Perfil de eventos SSE (`basic` omite razonamiento y tools). */
  readonly eventProfile: TurnEventProfile;
  readonly origin: TurnOrigin;
  /** Canal de eventos traducidos; la ruta HTTP los escribe como SSE. */
  readonly onEvent?: (event: TurnSseEvent) => void | Promise<void>;
}

/** Handle de un turno en curso (plan §4.2). */
export interface TurnHandle {
  /**
   * Resuelve **exactamente una vez**, siempre con el terminal del turno
   * (Fase 3.2: ningún `startTurn` aceptado queda sin terminal).
   */
  readonly completion: Promise<TurnSseEvent>;
  /** El cliente se fue (abort del stream SSE): corta el WS contra el Runner y produce terminal. */
  disconnect(): void;
}

/** Handle de temporizador del scheduler inyectable (tests sin `sleep`). */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Opciones de `TurnExecution` (todo lo temporal y durable es inyectable, §7.1). */
export interface TurnExecutionOptions {
  /** Token de servicio para autenticar el WS contra el Runner. */
  readonly apiToken: string;
  /**
   * Repositorio durable del terminal (T6). Opcional en Fase 3.2: la ruta aún
   * usa el `Map` en memoria y el claim unificado (T7+T2) es la Fase 3.4; el
   * Loop (Fase 3.5) compartirá la misma instancia. Presente, escribe cada
   * terminal con `turns.complete` y su causa.
   */
  readonly repository?: Pick<TurnRepository, "complete">;
  /** Reloj para el `now` del terminal durable (tests sin tiempo real). */
  readonly now?: () => number;
  /**
   * Watchdog de apertura/silencio (§4.6): si no llega `agent_start` en este
   * plazo desde `startTurn`, el turno se aborta con `turn-error`
   * (`runner_unavailable`). Valor de calibración (§10); `0`/`undefined` lo
   * desactiva (la ruta de Fase 3.2 conserva el "sin timeout" actual).
   */
  readonly dispatchTimeoutMs?: number;
  /** Scheduler inyectable para el watchdog (tests sin tiempo real). */
  readonly schedule?: (callback: () => void, ms: number) => TimerHandle;
  /** Cancelador inyectable del scheduler. */
  readonly cancel?: (handle: TimerHandle) => void;
  /**
   * Factory del socket contra el Runner (seam de test, §7.1). Por defecto
   * `new WebSocket(url, { headers: { authorization: Bearer <apiToken> } })`.
   * El test inyecta un fake cuyo `send` lanza para cubrir `dispatch_failed`.
   */
  readonly createWebSocket?: (url: string) => WebSocket;
}

/** `final_state` del terminal de T6 a partir del evento SSE (§8.1, §5.2). */
function finalStateOf(eventName: TurnSseEvent["event"]): TurnFinalState | undefined {
  switch (eventName) {
    case "turn-complete":
      return "succeeded";
    case "turn-aborted":
      return "cancelled";
    case "turn-error":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Puente compartido WS→eventos→terminal (plan §4.2). La ruta HTTP y el Loop
 * consumen la misma instancia; el registro de turnos vivos es la única
 * fuente para `TURN_IN_PROGRESS` y para el abort.
 */
export class TurnExecution {
  /** Turnos con WS abierto contra el Runner, por instancia del Manager. */
  private readonly turnosVivos = new Map<string, TurnoVivo>();
  private readonly apiToken: string;
  private readonly repository: Pick<TurnRepository, "complete"> | undefined;
  private readonly now: () => number;
  private readonly dispatchTimeoutMs: number;
  private readonly schedule: (callback: () => void, ms: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly createWebSocket: (url: string) => WebSocket;

  constructor(options: TurnExecutionOptions) {
    this.apiToken = options.apiToken;
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 0;
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.createWebSocket =
      options.createWebSocket ??
      ((url) =>
        new WebSocket(url, { headers: { authorization: `Bearer ${this.apiToken}` } }));
  }
  /** ¿Hay algún turno vivo del Agent? (rechaza stop/restart/reload con TURN_IN_PROGRESS). */
  hasLiveTurnForAgent(agentName: string): boolean {
    return hasLiveTurnForAgent(this.turnosVivos.keys(), agentName);
  }

  /** ¿Hay algún turno vivo, de cualquier Agent? (rechaza recargas globales). */
  hasAnyLiveTurn(): boolean {
    return this.turnosVivos.size > 0;
  }

  /**
   * Abre el WS contra el Runner, registra el turno como vivo y traduce los
   * mensajes del Runner a eventos. Todo turno aceptado resuelve `completion`
   * con **exactamente un** terminal (Fase 3.2): un `close` del Runner sin
   * terminal limpio, un error de conexión o un timeout de despacho publican
   * `turn-error` en vez del cierre mudo de la ruta original.
   */
  startTurn(command: StartTurnCommand): TurnHandle {
    const {
      agentName,
      turnId,
      sessionKey,
      message,
      runnerPort,
      eventProfile,
      onEvent,
    } = command;

    const ws = this.createWebSocket(
      `ws://127.0.0.1:${runnerPort}/ws?sessionKey=${encodeURIComponent(sessionKey)}`,
    );

    const clave = `${agentName}:${turnId}`;

    let resolveCompletion!: (terminal: TurnSseEvent) => void;
    const completion = new Promise<TurnSseEvent>((resolve) => {
      resolveCompletion = resolve;
    });

    let cerrado = false;
    let timeoutHandle: TimerHandle | undefined;

    /** `turn-error` público de una causa del catálogo (el código identifica la clase). */
    const turnError = (cause: FailureCause): TurnSseEvent => ({
      event: "turn-error",
      data: {
        turnId,
        code: cause === "turn_failed" ? "INTERNAL_ERROR" : "RESOURCE_UNAVAILABLE",
        message: cause === "turn_failed" ? "Runner error" : "Runner unavailable",
      },
    });

    const cancelarTimeout = () => {
      if (timeoutHandle !== undefined) {
        this.cancel(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    // Las escrituras se ENCADENAN: `writeSSE` del consumidor es asíncrona y
    // los mensajes del WS llegan en ráfaga. Sin esta cadena, el evento
    // terminal cerraría el stream antes de que su propia escritura se
    // vaciara y `turn-complete` NO llegaría nunca al cliente — encontrado
    // con un turno real, no en los tests unitarios.
    let escrituras: Promise<void> = Promise.resolve();
    const emitir = (evento: TurnSseEvent): Promise<void> => {
      escrituras = escrituras.then(() => onEvent?.(evento) ?? Promise.resolve());
      return escrituras;
    };

    const cerrarSocket = () => {
      try {
        ws.close();
      } catch {
        // El socket ya podía estar cerrado; da igual.
      }
    };

    /**
     * Escribe el terminal durable (T6) con su causa, cuando hay repositorio.
     * Un turno sin reserva durable (turno humano de la ruta en Fase 3.2) o un
     * doble terminal (write-once) no son fallos: el SSE ya entregó el evento.
     * Cualquier otro error se loguea sin romper la entrega del terminal.
     */
    const escribirTerminalDurable = (
      terminal: TurnSseEvent,
      failureCause: FailureCause | undefined,
    ): void => {
      if (!this.repository) return;
      const finalState = finalStateOf(terminal.event);
      if (!finalState) return;
      try {
        this.repository.complete(
          agentName,
          turnId,
          finalState,
          null,
          this.now(),
          failureCause,
        );
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "TURN_NOT_FOUND" || error.code === "TURN_ALREADY_TERMINAL")
        ) {
          return;
        }
        console.error(`[pihub] TURN_TERMINAL_WRITE_FAILED ${clave}:`, error);
      }
    };

    /** Emite el terminal, cierra el socket, escribe T6 y resuelve `completion`. */
    const finalizar = (terminal: TurnSseEvent, failureCause?: FailureCause) => {
      if (cerrado) return;
      cerrado = true;
      cancelarTimeout();
      this.turnosVivos.delete(clave);
      const escrituraFinal = emitir(terminal);
      void escrituraFinal.then(
        () => {
          cerrarSocket();
          escribirTerminalDurable(terminal, failureCause);
          resolveCompletion(terminal);
        },
        () => {
          cerrarSocket();
          escribirTerminalDurable(terminal, failureCause);
          resolveCompletion(terminal);
        },
      );
    };

    ws.on("open", () => {
      if (cerrado) {
        cerrarSocket();
        return;
      }
      // Registrado solo tras `open`: mandar `{type:"abort"}` antes de que el
      // WS esté realmente conectado no es seguro.
      this.turnosVivos.set(clave, { ws, abortRequested: false });
      try {
        ws.send(JSON.stringify({ type: "prompt", text: message }));
      } catch {
        // Un envío que falla tras aceptar el turno es un fallo de despacho
        // (§5.2 `dispatch_failed`): el `close`/`error` del WS también emitiría
        // terminal, pero este camino no deja el turno pendiente del socket.
        finalizar(turnError("dispatch_failed"), "dispatch_failed");
      }
    });

    ws.on("message", (raw: unknown) => {
      let mensaje: MensajeRunner;
      try {
        mensaje = JSON.parse(String(raw)) as MensajeRunner;
      } catch {
        return;
      }
      const turno = this.turnosVivos.get(clave);
      const evento = toTurnEvent(mensaje, turnId, eventProfile, turno?.abortRequested === true);
      if (!evento) return;

      // El watchdog se apaga con la primera actividad del Runner.
      if (evento.event === "turn-start") cancelarTimeout();

      const terminal =
        evento.event === "turn-complete" ||
        evento.event === "turn-aborted" ||
        evento.event === "turn-error";
      if (terminal) {
        // `agent_end` y `error` son terminales: se cierra DESPUÉS de que el
        // evento haya salido de verdad. El `error` del Runner es causa
        // `turn_failed`; los demás terminales no llevan `failure_reason`.
        finalizar(evento, evento.event === "turn-error" ? "turn_failed" : undefined);
      } else {
        void emitir(evento);
      }
    });

    ws.on("error", () => {
      const turno = this.turnosVivos.get(clave);
      if (turno?.abortRequested) {
        finalizar({ event: "turn-aborted", data: { turnId } });
        return;
      }
      finalizar(turnError("runner_unavailable"), "runner_unavailable");
    });

    ws.on("close", () => {
      const turno = this.turnosVivos.get(clave);
      // Un Runner que cierra el socket sin agent_end después de un abort
      // sigue teniendo una terminal pública: no dejamos al consumidor con un
      // SSE colgado ni disfrazamos la cancelación de error. Sin abort, el
      // cierre sin terminal ya NO es mudo (Fase 3.2): `turn-error`.
      if (turno?.abortRequested) {
        finalizar({ event: "turn-aborted", data: { turnId } });
      } else {
        finalizar(turnError("runner_unavailable"), "runner_unavailable");
      }
    });

    // Watchdog de apertura/silencio (§4.6): el Runner que acepta pero no
    // produce `agent_start` en `dispatchTimeoutMs` se aborta con `turn-error`.
    if (this.dispatchTimeoutMs > 0) {
      timeoutHandle = this.schedule(() => {
        timeoutHandle = undefined;
        const turno = this.turnosVivos.get(clave);
        if (turno?.abortRequested) {
          finalizar({ event: "turn-aborted", data: { turnId } });
          return;
        }
        finalizar(turnError("runner_unavailable"), "runner_unavailable");
      }, this.dispatchTimeoutMs);
    }

    return {
      completion,
      disconnect: () => finalizar(turnError("runner_unavailable"), "runner_unavailable"),
    };
  }

  /**
   * Aborta un turno en curso (bug 3). Se marca `abortRequested` antes de
   * enviar el comando: tanto el próximo `agent_end` como un `close`/`error`
   * sin `agent_end` publican `turn-aborted`. Si el envío falla se cierra el
   * socket (el `close` resolverá el turno con `turn-aborted` igualmente).
   * Devuelve `false` si no hay ningún turno vivo con ese `(agentName, turnId)`.
   */
  abort(agentName: string, turnId: string): boolean {
    const turno = this.turnosVivos.get(`${agentName}:${turnId}`);
    if (!turno) return false;

    turno.abortRequested = true;
    try {
      turno.ws.send(JSON.stringify({ type: "abort" }));
    } catch {
      // El close del socket resolverá el turno con turn-aborted igualmente.
      try {
        turno.ws.close();
      } catch {
        // Ya estaba cerrado.
      }
    }
    return true;
  }
}
