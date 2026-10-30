/**
 * Gate de ejecución del Runner (T4c, S2).
 *
 * La regla de producto es «como máximo UNA ejecución por Agent», y el Manager la
 * aplica en su propio registro de turnos vivos. Ese registro es en memoria: si el
 * Manager se reinicia, si el cliente HTTP/SSE se va o si la conexión se cae, el
 * Manager puede creer que el Agent está libre mientras el Runner sigue
 * ejecutando. Por eso la defensa AUTORITATIVA vive aquí, en el proceso que tiene
 * la AgentSession.
 *
 * Invariantes:
 * - **Una por Runner**, no una por sesión: las hubs keyed (`?sessionKey=…`) y el
 *   hub por defecto comparten la misma instancia (`SessionHubRegistry` se la
 *   adjunta a todas), y hay una instancia por Agent — nunca un singleton global
 *   que mezcle Agents de procesos distintos.
 * - **Se toma de forma síncrona y antes del primer `await`**: la sesión del SDK
 *   todavía no existe cuando se reserva, así que dos prompts del mismo tick no
 *   pueden colarse entre «comprobar» y «crear».
 * - **No encola**: un segundo prompt se RECHAZA. Encolarlo como `followUp` del
 *   SDK lo convertiría en un turno que se ejecuta más tarde sin que nadie lo
 *   haya pedido en ese momento.
 * - **El titular es un token**: solo el titular que la tomó puede liberarla, así
 *   que el asentamiento tardío de un turno viejo no puede liberar la ejecución
 *   de otro. Un abort no la libera: lo hace el asentamiento real del SDK.
 */
export class ExecutionGate {
  private holder: string | undefined;

  /**
   * Intenta tomar la gate para `holder`. `false` = ya hay una ejecución en curso.
   * Nunca lanza ni espera: es una decisión de admisión, no una cola.
   */
  tryAcquire(holder: string): boolean {
    if (this.holder !== undefined) return false;
    this.holder = holder;
    return true;
  }

  /**
   * Libera la gate SOLO si `holder` es su titular actual. Devuelve si liberó.
   * Es la salida de un turno que ya se asentó, nunca la de un abort solicitado.
   */
  release(holder: string): boolean {
    if (this.holder !== holder) return false;
    this.holder = undefined;
    return true;
  }

  /** ¿Hay una ejecución en curso en este Runner? */
  get busy(): boolean {
    return this.holder !== undefined;
  }

  /** Titular actual (diagnóstico: la `sessionKey`/label de la hub que ejecuta). */
  get currentHolder(): string | undefined {
    return this.holder;
  }
}

/**
 * Rechazo de admisión del Runner. El `code` es interno (no es copy de UI): la
 * frontera HTTP/WS lo traduce a su propio mensaje. Reutiliza el vocabulario
 * `TURN_IN_PROGRESS` que el Manager ya usa para la misma situación.
 */
export class ExecutionBusyError extends Error {
  readonly code = "TURN_IN_PROGRESS";

  constructor(holder?: string) {
    super(
      holder
        ? `Ya hay una ejecución en curso en este Runner (${holder}); espera a que termine`
        : "Ya hay una ejecución en curso en este Runner; espera a que termine",
    );
    this.name = "ExecutionBusyError";
  }
}
