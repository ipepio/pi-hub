import { randomUUID } from "node:crypto";
import type { ChannelKind, InboundMessage } from "@pihub/channels";
import { DomainError } from "../agenda/errors.ts";
import type { TurnExecution, TurnHandle } from "../agenda/turn-execution.ts";
import { PairingError, type PairingMachine } from "./pairing.ts";
import { readChannelRecords } from "./store.ts";
import { systemLabel } from "./labels.ts";
import type { AgentSessionCatalogue, SessionSurface } from "../sessions/catalogue.ts";

/**
 * Inbound handler (design §1.4, tasks c-I6) — the consumer of the `onInbound`
 * seam the registry has carried since part 1.
 *
 * It is the place where the pairing machine stops being a library and becomes
 * the state machine the spec describes: an inbound message on an UNBOUND channel
 * is consumed here (open window ⇒ auto-pair with zero clicks and the message is
 * then processed; closed window ⇒ a pairing code goes back through the transport
 * and the message is NOT processed — §2.1 `pending --> pending`), and an inbound
 * message on a BOUND channel becomes an Agent turn.
 *
 * Three ownership decisions this file makes, each with one owner:
 * - **Delivery is not decided here.** The turn carries
 *   `origin: { kind: "channel", channelKind, chatId }`, and the completion hook
 *   (`channels/delivery-router.ts`) is what routes the reply to the outbox. The
 *   inbound path never calls the transport for an Agent reply, so a reply can
 *   only be sent through the outbox (retry policy has one owner).
 * - **The pairing code reply is a system message, not a turn.** It goes straight
 *   to `enqueue` and never reaches `TurnExecution`, so a stranger cannot spend
 *   the Agent's model or its single live-turn slot.
 * - **Never steal a binding.** A channel bound to chat A answers nothing to chat
 *   B: no turn, no code, no rebinding. Rebinding is `unbind` (the owner's click).
 *
 * Session model: the projected D→P channel contract deliberately carries no
 * `sessionKey` (slice (c) decision, `api-v1/schemas.ts`), so the Manager decides
 * the session of a chat turn — one conversation, two surfaces. This is the
 * unified-session reading of design §1.2 and it wins over ADR 0099's
 * per-channel session: a key that contained the chat id would split the Agent's
 * context per transport.
 *
 * Which session that is (T5b/2): the one SELECTED on the surface the message
 * arrived on, resolved through `sessionKeyFor` when the message is ACCEPTED into
 * the queue. Production wires the durable catalogue (`sessions/catalogue.ts`); a
 * composition that does not inject it keeps the historical `agent:<nombre>:main`,
 * which is a test dependency and not what the composition root does. A selector
 * that throws is fail-closed: the message is dropped with a log line instead of
 * running in a session nobody selected.
 *
 * Queueing: one bounded FIFO per `(agent, kind)` of depth 10, drained
 * sequentially (the Runner serves one live turn per Agent, and the
 * `TURN_IN_PROGRESS` discipline would refuse a second anyway). Overflow drops
 * the newest message with a log line — the same documented ephemerality as the
 * in-memory turn-idempotency map (`api-v1/turns.ts`): a restart loses it too.
 * A message REFUSED because the Agent already has a live turn (S2 / T4b) is
 * not re-queued for a surprise later run either: it is dropped with a system
 * notice through the outbox (copy in `labels.ts`), and every rejection of the
 * drain (resolver, queue, outbox) is logged so the rest of the queue survives.
 *
 * Commands (T6a): a message from the BOUND chat that starts with `/` is a command
 * (`/new`, `/sessions`, `/session`, `/stop`), resolved BEFORE the turn path and
 * AFTER the binding check — an unbound chat gets the pairing flow and never a
 * command. A command never reaches `startTurn` and never enters the FIFO: its
 * answer is a system message through the same outbox, so creating, listing,
 * selecting and aborting work while the Agent is busy. The catalogue operations
 * come in through the narrow `sessionCommands` port (production wires
 * `catalogueSessionCommands` over the durable catalogue): without that port a
 * `/…` message keeps following the historical text path.
 */

/** Messages waiting behind a live turn, per `(agent, kind)`. */
export const INBOUND_QUEUE_DEPTH = 10;

    /**
     * Cuántas sesiones caben en la respuesta de `/sessions`: la lista está ACOTADA.
     * Un catálogo puede crecer sin límite y un chat no es un dashboard; el recuento
     * (`10 de N`) dice al humano que hay más sin volcar cientos de líneas a Telegram.
     */
    export const SESSION_LIST_LIMIT = 10;

    /** Una sesión tal y como se nombra en el chat: id opaco + etiqueta humana opcional. */
    export interface ChannelSessionView {
      readonly id: string;
      readonly name: string | null;
    }

    /**
     * Operaciones de catálogo que un comando de texto necesita (T6a).
     *
     * Es un objeto ESTRECHO, no la clase `AgentSessionCatalogue`: el inbound no conoce
     * SQL ni transacciones, y qué superficie gobierna cada `ChannelKind` lo decide quien
     * compone (el mismo mapa que ya resuelve `sessionKeyFor`). Inyectarlo es opcional a
     * propósito: sin él, un mensaje que empieza por `/` sigue el camino histórico
     * (texto normal), así que una composición sin catálogo no cambia de comportamiento
     * por esta unidad.
     *
     * Todo lo que se lance desde aquí lo convierte el handler en una respuesta de
     * sistema: un comando siempre contesta, y un catálogo caído no puede dejar al humano
     * sin respuesta ni abrir un turno por accidente.
     */
    export interface ChannelSessionCommands {
      /** Crea una sesión del Agent y la SELECCIONA en la superficie de este canal. */
      newSession(input: {
        agentName: string;
        kind: ChannelKind;
        name?: string;
      }): ChannelSessionView;
      /** Catálogo del Agent + la sesión seleccionada en la superficie de este canal. */
      listSessions(input: { agentName: string; kind: ChannelKind }): {
        sessions: ChannelSessionView[];
        selectedId: string | null;
      };
      /** Selecciona una sesión por id en la superficie de este canal. Lanza si no existe. */
      selectSession(input: {
        agentName: string;
        kind: ChannelKind;
        sessionId: string;
      }): ChannelSessionView;
      /** ¿El Agent tiene un turno vivo AHORA? (consultar no cuesta el turno). */
      isBusy(input: { agentName: string }): boolean;
      /** Aborta el turno vivo del Agent; `false` = no había ninguno que abortar. */
      abortIfLive(input: { agentName: string }): boolean;
    }

    /**
     * Puerta del catálogo que el adaptador de comandos necesita: crear, listar y
     * seleccionar. `Pick` y no la clase entera, para que el adaptador no pueda tocar
     * nada más (borrar un Agent, por ejemplo).
     */
    export interface CatalogueSessionCommandDeps {
      sessions: Pick<AgentSessionCatalogue, "create" | "list" | "select">;
      /** Qué superficie gobierna cada tipo de canal: el mismo mapa que `sessionKeyFor`. */
      surfaceOf: (kind: ChannelKind) => SessionSurface;
      now: () => number;
      /** ¿Hay un turno vivo del Agent? (`TurnExecution.hasLiveTurnForAgent` en producción). */
      isBusy: (agentName: string) => boolean;
      /** Aborta el turno vivo del Agent y dice si había alguno. */
      abortIfLive: (agentName: string) => boolean;
    }

    /**
     * Adaptador REAL de los comandos sobre el catálogo durable (T6a).
     *
     * Vive junto al contrato que implementa para que la composición solo aporte el
     * catálogo y las dos preguntas sobre el turno vivo: ninguna regla de catálogo se
     * re-implementa aquí (crear es `create`, seleccionar es `select`, listar es `list`),
     * así que la identidad por Agent, la transacción y la selección por superficie
     * siguen teniendo un solo dueño. La superficie sale del mapa que ya existe en la
     * composición, no de una copia de ese mapa en este fichero.
     */
    export function catalogueSessionCommands(
      deps: CatalogueSessionCommandDeps,
    ): ChannelSessionCommands {
      return {
        newSession: ({ agentName, kind, name }) => {
          const channel = deps.surfaceOf(kind);
          const created = deps.sessions.create({ agentName, channel, name, now: deps.now() });
          // Crear y seleccionar es UNA operación para el humano: `/new` significa «este
          // chat pasa a hablar de la conversación nueva». Dos llamadas al catálogo, no
          // una transacción nueva: cada una es la operación que ya existe.
          const selected = deps.sessions.select({
            agentName,
            channel,
            sessionId: created.id,
            now: deps.now(),
          });
          return { id: selected.id, name: selected.name };
        },
        listSessions: ({ agentName, kind }) => {
          const snapshot = deps.sessions.list(agentName, deps.now());
          return {
            sessions: snapshot.sessions.map((session) => ({
              id: session.id,
              name: session.name,
            })),
            selectedId: snapshot.selection[deps.surfaceOf(kind)],
          };
        },
        selectSession: ({ agentName, kind, sessionId }) => {
          const selected = deps.sessions.select({
            agentName,
            channel: deps.surfaceOf(kind),
            sessionId,
            now: deps.now(),
          });
          return { id: selected.id, name: selected.name };
        },
        isBusy: ({ agentName }) => deps.isBusy(agentName),
        abortIfLive: ({ agentName }) => deps.abortIfLive(agentName),
      };
    }

    /** Un comando de texto (`/new`, `/sessions`, `/session x`, `/stop`), ya parseado. */
    interface ChannelCommand {
      /** Nombre SIN la barra y en minúsculas. */
      readonly name: string;
      /** Resto del mensaje recortado; `""` si el comando vino solo. */
      readonly argument: string;
    }

    /**
     * `" /new Sesión de prueba"` → `{ name: "new", argument: "Sesión de prueba" }`.
     *
     * Tres decisiones, y las tres se prueban:
     * - Solo es comando si el mensaje EMPIEZA por `/` (ya recortado): «mira /new» es
     *   texto normal, porque un mensaje del humano no deja de serlo por llevar una barra.
     * - Telegram añade `@bot` al comando en grupos (`/new@mi_bot`): ese sufijo es la
     *   identidad del bot y no parte del comando.
     * - El nombre se compara en minúsculas: `/NEW` y `/new` son el mismo comando.
     */
    function parseChannelCommand(text: string): ChannelCommand | undefined {
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) return undefined;
      const cut = trimmed.search(/\s/);
      const head = cut === -1 ? trimmed : trimmed.slice(0, cut);
      const argument = cut === -1 ? "" : trimmed.slice(cut).trim();
      const withoutSlash = head.slice(1);
      const at = withoutSlash.indexOf("@");
      const name = (at === -1 ? withoutSlash : withoutSlash.slice(0, at)).toLowerCase();
      if (name === "") return undefined;
      return { name, argument };
    }

    /**
     * Cómo se nombra una sesión en el chat: `nombre (id)`, o el id solo si aún no tiene
     * nombre humano. El id viaja siempre porque es lo único que el humano puede dictar
     * sin ambigüedad cuando dos sesiones se llaman igual.
     */
    function sessionRef(session: ChannelSessionView): string {
      return systemLabel("sessionRef", {
        name: session.name ?? systemLabel("sessionUnnamed"),
        id: session.id,
      });
    }

    /**
     * Resolución del argumento de `/session`: primero el **id** (opaco y sin ambigüedad),
     * después el **nombre exacto**. Un nombre inexistente —o repetido— no selecciona
     * nada: elegir «la primera» sería adivinar cuál quería el humano.
     */
    function findSession(
      sessions: readonly ChannelSessionView[],
      target: string,
    ): ChannelSessionView | undefined {
      const byId = sessions.find((session) => session.id === target);
      if (byId) return byId;
      const byName = sessions.filter((session) => session.name === target);
      return byName.length === 1 ? byName[0] : undefined;
    }

    /**
     * El texto de respuesta de un comando, ya renderizado desde el catálogo de labels.
     *
     * Vive fuera de la clase porque es una traducción «comando → copy», no estado: la
     * clase solo se encarga de enrutar la respuesta al outbox y de convertir un fallo
     * del catálogo en un mensaje de sistema.
     */
    function commandText(
      commands: ChannelSessionCommands,
      agentName: string,
      kind: ChannelKind,
      command: ChannelCommand,
    ): string {
      switch (command.name) {
        case "new": {
          const created = commands.newSession({
            agentName,
            kind,
            ...(command.argument === "" ? {} : { name: command.argument }),
          });
          return systemLabel("sessionCreated", { session: sessionRef(created) });
        }
        case "sessions": {
          const { sessions, selectedId } = commands.listSessions({ agentName, kind });
          const shown = sessions.slice(0, SESSION_LIST_LIMIT);
          const lines = shown.map((session) =>
            session.id === selectedId
              ? `- ${sessionRef(session)} ${systemLabel("sessionSelectedMark")}`
              : `- ${sessionRef(session)}`,
          );
          return systemLabel("sessionList", {
            count: String(shown.length),
            total: String(sessions.length),
            lines: lines.join("\n"),
          });
        }
        case "session": {
          if (command.argument === "") {
            const { sessions, selectedId } = commands.listSessions({ agentName, kind });
            const current = sessions.find((session) => session.id === selectedId);
            const status = systemLabel(
              commands.isBusy({ agentName }) ? "agentBusy" : "agentIdle",
            );
            if (!current) return systemLabel("sessionNone", { status });
            return systemLabel("sessionCurrent", { session: sessionRef(current), status });
          }
          const { sessions } = commands.listSessions({ agentName, kind });
          const target = findSession(sessions, command.argument);
          if (!target) {
            return systemLabel("sessionUnknownTarget", { target: command.argument });
          }
          const selected = commands.selectSession({ agentName, kind, sessionId: target.id });
          return systemLabel("sessionSwitched", { session: sessionRef(selected) });
        }
        case "stop":
          // El binding ya está comprobado: solo el chat enlazado llega aquí, así que
          // `/stop` no necesita (ni debe) otra condición de propiedad.
          return systemLabel(
            commands.abortIfLive({ agentName }) ? "stopRequested" : "stopNothing",
          );
        default:
          return systemLabel("unknownCommand", { command: command.name });
      }
    }

    /** Outbound delivery of a transport-level message (pairing code): the outbox. */
export interface InboundEnqueueInput {
  agentName: string;
  kind: ChannelKind;
  chatId: string;
  text: string;
}

export type EnqueueFn = (input: InboundEnqueueInput) => void | Promise<void>;

/**
 * The Agent's main session key. Stable across restarts and across surfaces:
 * the Dashboard's web turns and the channel turns must land in one context.
 */
export function mainSessionKeyOf(agentName: string): string {
  return `agent:${agentName}:main`;
}

/**
 * Reply to a sender the channel is not bound to. Copy lives in the system-label
 * catalogue (`labels.ts`, S4); what is pinned here is that the code travels and
 * the message is not an Agent answer.
 */
export function pairingCodeReplyText(code: string): string {
  return systemLabel("pairingCode", { code });
}

/**
 * Reply to a bound chat whose message was NOT executed because the Agent already
 * has a live turn (S2 / T4b). It is a system message sent through the outbox —
 * never an Agent answer and never a queued message that would run later by
 * surprise — so the user knows the message was dropped and can resend it.
 */
export function busyTurnReplyText(): string {
  return systemLabel("turnBusy");
}

export interface ChannelInboundDeps {
  dataDir: string;
  pairing: PairingMachine;
  turns: Pick<TurnExecution, "startTurn">;
  /**
   * Runner resolver: `undefined` means "not running" and the message is dropped.
   * The port never leaves the Manager (`supervisor.statusOf`), and an inbound
   * message must never restart a Runner — that would let a stranger control the
   * process lifecycle.
   */
  resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  /** The outbox face: system replies (pairing code) go through it, never direct. */
  enqueue: EnqueueFn;
      /**
       * `sessionKey` con la que se abre el turno de un mensaje entrante.
       *
       * Producción inyecta el catálogo durable por esta costura (T5b/2): la selección
       * de la superficie del canal, leída por un CALLBACK y no importando la clase —
       * `sessions/catalogue.ts` ya importa `mainSessionKeyOf` de este fichero, así que
       * un import de vuelta sería un ciclo. Sin inyección se conserva la main histórica
       * (`agent:<nombre>:main`), que es lo que usan los tests anteriores a esta unidad.
       */
          sessionKeyFor?: (agentName: string, kind: ChannelKind, chatId: string) => string;
      /**
       * Operaciones de catálogo para los comandos de texto (`/new`, `/sessions`,
       * `/session`, `/stop`). Se inyecta en la composición, que es quien sabe qué
       * superficie gobierna cada canal y cómo llegar al abort del turno vivo.
       *
       * Ausente = los mensajes que empiezan por `/` siguen el camino histórico (texto
       * normal). Es una dependencia de los tests anteriores a esta unidad y no lo que
       * arranca la producción.
       */
      sessionCommands?: ChannelSessionCommands;
      newTurnId?: () => string;
  log?: (line: string) => void;
}

interface QueuedInbound {
  message: InboundMessage;
  /** Captured when the message was accepted, so a slow drain cannot re-pair. */
  sessionKey: string;
}

export class ChannelInboundHandler {
  private readonly dataDir: string;
  private readonly pairing: PairingMachine;
  private readonly turns: Pick<TurnExecution, "startTurn">;
  private readonly resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  private readonly enqueue: EnqueueFn;
  private readonly sessionKeyFor: (agentName: string, kind: ChannelKind, chatId: string) => string;
  private readonly sessionCommands: ChannelSessionCommands | undefined;
  private readonly newTurnId: () => string;
  private readonly log: (line: string) => void;
  private readonly queues = new Map<string, QueuedInbound[]>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(deps: ChannelInboundDeps) {
    this.dataDir = deps.dataDir;
    this.pairing = deps.pairing;
    this.turns = deps.turns;
    this.resolveRunner = deps.resolveRunner;
    this.enqueue = deps.enqueue;
    this.sessionKeyFor =
      deps.sessionKeyFor ?? ((agentName) => mainSessionKeyOf(agentName));
    this.sessionCommands = deps.sessionCommands;
    this.newTurnId = deps.newTurnId ?? randomUUID;
    this.log = deps.log ?? ((line) => console.error(`[channels] ${line}`));
  }

  /**
   * Adapter-facing entry point: `ChannelAdapter.onInbound` is fire-and-forget by
   * contract (a slow turn must not stall long polling), so this swallows its
   * own errors and never returns a Promise to the transport.
   */
  handle(agentName: string, kind: ChannelKind, message: InboundMessage): void {
    void this.handleAsync(agentName, kind, message).catch((error) => {
      this.log(`inbound failed agent=${agentName} kind=${kind}: ${String(error)}`);
    });
  }

  /** Same path as `handle`, exposed awaited for deterministic tests. */
  async handleAsync(
    agentName: string,
    kind: ChannelKind,
    message: InboundMessage,
  ): Promise<void> {
    const chatId = String(message.externalChatId ?? "").trim();
    if (!chatId) return;

    const records = await readChannelRecords(this.dataDir, agentName);
    const record = records.find((entry) => entry.kind === kind);
    if (!record) {
      // No projection, or a projection with no credential: nothing is listening
      // for this Agent and inventing pairing state would lie about it.
      this.log(`inbound ignored: no channel "${kind}" for agent "${agentName}"`);
      return;
    }

    const state = await this.pairing.stateOf(agentName, kind);

    if (state?.externalChatId !== null && state?.externalChatId !== undefined) {
      if (state.externalChatId !== chatId) {
        // Never steal: the binding is the owner's fact, not the sender's.
        this.log(
          `inbound ignored: channel "${kind}" of agent "${agentName}" already bound to another chat`,
        );
        return;
      }
      // T6a: los comandos se resuelven ANTES del camino de turnos (no gastan el
      // turno del Agent) y DESPUÉS del binding — un chat sin enlazar recibe el
      // flujo de emparejamiento y nunca un comando.
      const command =
        this.sessionCommands === undefined ? undefined : parseChannelCommand(message.text);
      if (command !== undefined && this.sessionCommands !== undefined) {
        await this.replyCommand(agentName, kind, chatId, this.sessionCommands, command);
        return;
      }
      this.queue(agentName, kind, chatId, message);
      return;
    }

    // Unbound: the pairing machine decides (auto-pair inside the projected
    // window, code outside it). Both outcomes are its answers, not ours.
    try {
      const result = await this.pairing.requestPairing(agentName, kind, chatId);
      if (result.autoPaired) {
        this.log(`auto-paired channel "${kind}" of agent "${agentName}" to chat ${chatId}`);
        this.queue(agentName, kind, chatId, message);
        return;
      }
      if (result.code) {
        await this.enqueue({
          agentName,
          kind,
          chatId,
          text: pairingCodeReplyText(result.code),
        });
        this.log(
          `pairing code issued for channel "${kind}" of agent "${agentName}" chat ${chatId}`,
        );
      }
    } catch (error) {
      if (error instanceof PairingError) {
        // Limit reached, channel removed mid-flight, or a binding that appeared
        // concurrently: an unknown sender is refused without a code (§2.1), and
        // the refusal is a log line, never an Agent turn.
        this.log(`pairing refused for chat ${chatId}: ${error.code}`);
        return;
      }
      throw error;
    }
  }

      // --- commands (T6a) --------------------------------------------------------

      /**
       * Contesta un comando por el outbox. Los comandos NO entran en la cola FIFO: crear,
       * listar, seleccionar y abortar no necesitan el turno del Agent, así que responden
       * también con un turno vivo — que es justo cuando el humano los necesita.
       *
       * El texto sale siempre del catálogo de labels (`labels.ts`): el handler no tiene
       * copy propio. Un fallo del catálogo de sesiones se convierte en «no he podido»
       * (y en una línea de log) en vez de en un turno o en un silencio.
       */
      private async replyCommand(
        agentName: string,
        kind: ChannelKind,
        chatId: string,
        commands: ChannelSessionCommands,
        command: ChannelCommand,
      ): Promise<void> {
        let text: string;
        try {
          text = commandText(commands, agentName, kind, command);
        } catch (error) {
          this.log(
            `command failed agent=${agentName} kind=${kind} command=/${command.name}: ${String(error)}`,
          );
          text = systemLabel("commandFailed", { command: command.name });
        }
        await this.enqueue({ agentName, kind, chatId, text });
      }

      /** Messages waiting behind a live turn for one `(agent, kind)`. */
      queueDepth(agentName: string, kind: ChannelKind): number {
    return this.queues.get(queueKey(agentName, kind))?.length ?? 0;
  }

  /** Resolves when every queue and drain has settled (test seam, no sleeps). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }

  // --- internals -------------------------------------------------------------

  private queue(
    agentName: string,
    kind: ChannelKind,
    chatId: string,
    message: InboundMessage,
  ): void {
    const key = queueKey(agentName, kind);
    const queue = this.queues.get(key) ?? [];
    if (queue.length >= INBOUND_QUEUE_DEPTH) {
      this.log(
        `inbound queue full agent=${agentName} kind=${kind}: dropping message ${message.messageId}`,
      );
      return;
    }
    // T5b/2: la sesión se captura AHORA — cuando el mensaje se ACEPTA — y no
    // cuando le toque el turno. Leer la selección al despachar atribuiría el
    // mensaje a la sesión que esté elegida más tarde, no a la que el humano tenía
    // delante cuando escribió. Si la resolución falla, el mensaje NO se ejecuta con
    // la main por defecto: se descarta con una línea de log (fail-closed).
    let sessionKey: string;
    try {
      sessionKey = this.sessionKeyFor(agentName, kind, chatId);
    } catch (error) {
      this.log(
        `inbound dropped agent=${agentName} kind=${kind}: could not resolve the selected session (${String(error)})`,
      );
      return;
    }
    queue.push({ message, sessionKey });
    this.queues.set(key, queue);
    this.drain(key, agentName, kind, chatId);
  }

  /** One drain per key, chained so turns for an Agent never overlap. */
  private drain(key: string, agentName: string, kind: ChannelKind, chatId: string): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      for (;;) {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) return;
        const item = queue.shift() as QueuedInbound;
        try {
          await this.runTurn(agentName, kind, chatId, item);
        } catch (error) {
          // Un fallo del resolver, de la cola o del outbox se REGISTRA y el
          // drenado sigue con el siguiente item de ESTA cola: un mensaje roto no
          // puede quedarse con el drenado ni perder los que vienen detrás.
          this.log(
            `inbound message failed agent=${agentName} kind=${kind} message=${item.message.messageId}: ${String(error)}`,
          );
        }
      }
    });
    this.tails.set(key, next);
    // `next` ya no rechaza (el bucle consume cada fallo), pero el cleanup se
    // escribe con los DOS callbacks: un `void next.finally(...)` fabrica una
    // promesa derivada que rechaza y se queda sin consumidor.
    const olvidar = (): void => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    void next.then(olvidar, olvidar);
  }

  private async runTurn(
    agentName: string,
    kind: ChannelKind,
    chatId: string,
    item: QueuedInbound,
  ): Promise<void> {
    const runner = await this.resolveRunner(agentName);
    if (!runner) {
      this.log(`inbound dropped: runner unavailable for agent "${agentName}"`);
      return;
    }

    const turnId = this.newTurnId();
    let handle: TurnHandle;
    try {
      handle = this.turns.startTurn({
        agentName,
        turnId,
        // El id de transporte del chat es la clave de idempotencia: un reenvío del
        // mismo mensaje (long polling at-least-once) no genera un segundo turno.
        idempotencyKey: `channel:${kind}:${chatId}:${item.message.messageId}`,
        correlationId: turnId,
        sessionKey: item.sessionKey,
        message: item.message.text,
        runnerPort: runner.port,
        eventProfile: "basic",
        // Este es el hecho que hace que la respuesta vuelva por el outbox.
        origin: { kind: "channel", channelKind: kind, chatId },
      });
    } catch (error) {
      // Admisión (S2 / T4b): el Agent ya tiene un turno vivo —de la web, de otro
      // chat o de una Initiative— y `startTurn` lo rechaza ANTES de abrir nada.
      // El mensaje NO se ejecuta y NO se encola para más tarde: se descarta con
      // un aviso de sistema por el outbox (misma política de entrega y reintento
      // que el resto de mensajes de sistema) y el usuario puede reenviarlo.
      if (error instanceof DomainError && error.code === "TURN_IN_PROGRESS") {
        this.log(
          `inbound rejected agent=${agentName} kind=${kind} message=${item.message.messageId}: agent busy`,
        );
        await this.enqueue({
          agentName,
          kind,
          chatId,
          text: busyTurnReplyText(),
        });
        return;
      }
      throw error;
    }
    await handle.completion;
  }
}

function queueKey(agentName: string, kind: ChannelKind): string {
  return `${agentName}:${kind}`;
}
