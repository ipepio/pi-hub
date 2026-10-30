import { randomUUID } from "node:crypto";
import type { ChannelKind, InboundMessage, InlineKeyboardButton } from "@pihub/channels";
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
 *
 * Buttons (T6b): `/sessions` also answers with an inline keyboard — one button per
 * listed session, whose opaque `data` is `s:<sessionId>` — and a press comes back as
 * an `InboundMessage` with `text: ""` plus `callback`. A press is therefore resolved
 * BEFORE the command gate and before the queue: it is not prose, it is not a turn, and
 * an empty body must never open one. Two decisions make the press cheap and safe:
 * - **The Manager parses `s:<id>` itself.** The adapter transports the data opaquely;
 *   anything that is not exactly `s:<id>` selects nothing (no catalogue call, no ACK).
 * - **The press is answered twice, on purpose.** The ACK (`answerCallback`, through the
 *   registry, best-effort) stops the client's spinner and — when the id does not exist —
 *   IS the answer; the OUTCOME is a system message through the outbox, so a switch that
 *   the catalogue confirms still gets the same retry/at-least-once treatment as every
 *   other system reply. A press in an UNBOUND chat is dropped with a log line: a
 *   keyboard can only exist in a chat that was bound when it was sent, and a press is
 *   not a reason to open a pairing window.
 */

/** Messages waiting behind a live turn, per `(agent, kind)`. */
export const INBOUND_QUEUE_DEPTH = 10;

/**
 * Prefijo de los datos de un botón de sesión: `s:<sessionId>`.
 *
 * El adaptador transporta el `data` tal cual (es opaco para él), así que el contrato
 * vive AQUÍ: quien lo escribe (`/sessions`) y quien lo lee (una pulsación) son el
 * dueño único de su significado.
 */
export const SESSION_CALLBACK_PREFIX = "s:";

/**
 * Tope de bytes del `data` de un botón, el más pequeño de los transportes conocidos
 * (Telegram: 64 bytes de `callback_data`, y lo RECHAZA, no lo trunca). Se mide con
 * `Buffer.byteLength` y no con `.length` porque un emoji son cuatro bytes.
 *
 * Es una constante local a propósito: `@pihub/channels` deja la forma del teclado
 * neutra y cada adaptador valida su propio límite. El Manager construye botones que
 * cualquier transporte acepta, y el adaptador sigue siendo quien dice `invalid_keyboard`.
 */
export const CALLBACK_DATA_LIMIT = 64;

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

    /** `"s2"` → `"s:s2"`: los datos que viajan en el botón de esa sesión. */
    export function sessionCallbackData(sessionId: string): string {
      return `${SESSION_CALLBACK_PREFIX}${sessionId}`;
    }

    /**
     * `"s:s2"` → `"s2"`; cualquier otra cosa → `undefined`.
     *
     * Estricto de propósito: el `data` es de quien pulsó, no una sugerencia. Un
     * prefijo distinto (otro botón del bot, otra versión del Manager) o un id vacío no
     * selecciona NADA — adivinar aquí sería mover la sesión de un chat por un dato que
     * nadie emitió.
     */
    export function parseSessionCallbackData(data: string): string | undefined {
      if (!data.startsWith(SESSION_CALLBACK_PREFIX)) return undefined;
      const sessionId = data.slice(SESSION_CALLBACK_PREFIX.length);
      return sessionId === "" ? undefined : sessionId;
    }

    /**
     * El teclado de `/sessions`: una fila por sesión listada, con el nombre humano
     * como texto y `s:<id>` como dato. `undefined` cuando no hay ninguna sesión (un
     * teclado vacío se convierte en `reply_markup` vacío en algunos transportes).
     *
     * Una sesión cuyo dato no cabe en el transporte se cae del teclado con una línea
     * de log y SIGUE en el texto: el id es lo único que hace falta para `/session`, así
     * que perder el botón no pierde la sesión — y un solo botón demasiado largo haría
     * que el transporte rechazara el mensaje entero.
     */
    function sessionsKeyboard(
      sessions: readonly ChannelSessionView[],
      log: (line: string) => void,
    ): InlineKeyboardButton[][] | undefined {
      const rows: InlineKeyboardButton[][] = [];
      for (const session of sessions) {
        const data = sessionCallbackData(session.id);
        if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_LIMIT) {
          log(
            `session button skipped session=${session.id}: callback data exceeds ${CALLBACK_DATA_LIMIT} bytes`,
          );
          continue;
        }
        rows.push([{ text: sessionRef(session), data }]);
      }
      return rows.length > 0 ? rows : undefined;
    }

    /** Lo que contesta un comando: SIEMPRE un texto, y un teclado si hay algo que pulsar. */
    export interface ChannelCommandReply {
      readonly text: string;
      readonly keyboard?: InlineKeyboardButton[][];
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
     * La respuesta de un comando, ya renderizada desde el catálogo de labels.
     *
     * Vive fuera de la clase porque es una traducción «comando → copy», no estado: la
     * clase solo se encarga de enrutar la respuesta al outbox y de convertir un fallo
     * del catálogo en un mensaje de sistema.
     *
     * `/sessions` es el único comando que devuelve teclado (T6b): las mismas sesiones
     * que lista el texto, una por botón, para que elegir no exija copiar un id.
     */
    function commandReply(
      commands: ChannelSessionCommands,
      agentName: string,
      kind: ChannelKind,
      command: ChannelCommand,
      log: (line: string) => void,
    ): ChannelCommandReply {
      switch (command.name) {
        case "new": {
          const created = commands.newSession({
            agentName,
            kind,
            ...(command.argument === "" ? {} : { name: command.argument }),
          });
          return { text: systemLabel("sessionCreated", { session: sessionRef(created) }) };
        }
        case "sessions": {
          const { sessions, selectedId } = commands.listSessions({ agentName, kind });
          const shown = sessions.slice(0, SESSION_LIST_LIMIT);
          const lines = shown.map((session) =>
            session.id === selectedId
              ? `- ${sessionRef(session)} ${systemLabel("sessionSelectedMark")}`
              : `- ${sessionRef(session)}`,
          );
          const keyboard = sessionsKeyboard(shown, log);
          return {
            text: systemLabel("sessionList", {
              count: String(shown.length),
              total: String(sessions.length),
              lines: lines.join("\n"),
            }),
            ...(keyboard === undefined ? {} : { keyboard }),
          };
        }
        case "session": {
          if (command.argument === "") {
            const { sessions, selectedId } = commands.listSessions({ agentName, kind });
            const current = sessions.find((session) => session.id === selectedId);
            const status = systemLabel(
              commands.isBusy({ agentName }) ? "agentBusy" : "agentIdle",
            );
            if (!current) return { text: systemLabel("sessionNone", { status }) };
            return {
              text: systemLabel("sessionCurrent", {
                session: sessionRef(current),
                status,
              }),
            };
          }
          const { sessions } = commands.listSessions({ agentName, kind });
          const target = findSession(sessions, command.argument);
          if (!target) {
            return {
              text: systemLabel("sessionUnknownTarget", { target: command.argument }),
            };
          }
          const selected = commands.selectSession({ agentName, kind, sessionId: target.id });
          return { text: systemLabel("sessionSwitched", { session: sessionRef(selected) }) };
        }
        case "stop":
          // El binding ya está comprobado: solo el chat enlazado llega aquí, así que
          // `/stop` no necesita (ni debe) otra condición de propiedad.
          //
          // T4-D/2: el turno vivo puede ser una reserva que sobrevivió al reinicio del
          // Manager (`loadUnverified`). Existe —ocupa el slot— pero su socket no vive
          // en este proceso, así que `abort` lo rechaza con `TURN_UNREACHABLE` en vez
          // de fingir: el humano recibe un label que lo dice (y no el genérico
          // `commandFailed`, que culpa al catálogo y sugiere reintentar en vano).
          try {
            return {
              text: systemLabel(
                commands.abortIfLive({ agentName }) ? "stopRequested" : "stopNothing",
              ),
            };
          } catch (error) {
            if (error instanceof DomainError && error.code === "TURN_UNREACHABLE") {
              return { text: systemLabel("turnUnreachable") };
            }
            throw error;
          }
        default:
          return { text: systemLabel("unknownCommand", { command: command.name }) };
      }
    }

    /**
     * `SESSION_NOT_FOUND` leído ESTRUCTURALMENTE, no con `instanceof`.
     *
     * `sessions/catalogue.ts` importa `mainSessionKeyOf` de este fichero: importar su
     * clase de error de vuelta sería un ciclo. Además un catálogo de mentira en un test
     * (o la clase llegando por `dist`) tiene que clasificarse igual, y el código es el
     * contrato, no la identidad del constructor.
     */
    function sessionNotFound(error: unknown): boolean {
      return (error as { code?: unknown } | null)?.code === "SESSION_NOT_FOUND";
    }

/** Outbound delivery of a transport-level message (pairing code): the outbox. */
export interface InboundEnqueueInput {
  agentName: string;
  kind: ChannelKind;
  chatId: string;
  text: string;
  /**
   * Botones que acompañan al mensaje (T6b). Opcional: una respuesta de sistema sin nada
   * que pulsar no inventa un teclado vacío, y el payload que se serializa para ella es
   * byte a byte el de siempre (`{"text":…}`).
   */
  keyboard?: InlineKeyboardButton[][];
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
      /**
       * ACK de una pulsación de botón (T6b). La composición lo cablea al registry
       * (`registry.answerCallback` → `adapter.answerCallback`), que es quien habla con
       * el transporte y quien decide que un fallo del ACK se registra y no se propaga.
       *
       * Ausente = no hay a quién acusar: el handler sigue seleccionando y contestando
       * por el outbox, que es lo que el humano conserva.
       */
      answerCallback?: (
        agentName: string,
        kind: ChannelKind,
        callbackQueryId: string,
        text?: string,
      ) => Promise<void>;
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
  private readonly answerCallback:
    | ((agentName: string, kind: ChannelKind, callbackQueryId: string, text?: string) => Promise<void>)
    | undefined;
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
    this.answerCallback = deps.answerCallback;
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
    const bound =
      state?.externalChatId !== null && state?.externalChatId !== undefined;

    if (bound && state.externalChatId !== chatId) {
        // Never steal: the binding is the owner's fact, not the sender's.
      this.log(
          `inbound ignored: channel "${kind}" of agent "${agentName}" already bound to another chat`,
      );
      return;
    }

    // T6b: una PULSACIÓN no es prosa. Se resuelve antes de la puerta de comandos y
    // antes de la cola (su `text` viene vacío: encolarla abriría un turno sin
    // mensaje), y exige vínculo activo: un teclado solo pudo existir en un chat
    // enlazado, así que una pulsación NUNCA abre el flujo de emparejamiento.
    if (message.callback !== undefined) {
      if (!bound) {
        this.log(
          `callback ignored: channel "${kind}" of agent "${agentName}" is not bound to any chat`,
        );
        return;
      }
      await this.handleCallback(agentName, kind, chatId, message.callback);
      return;
    }

    if (bound) {
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
       *
       * T6b: la respuesta puede llevar teclado (`/sessions`), y entonces viaja en la
       * MISMA fila del outbox que el texto — misma política de reintento, mismo
       * at-least-once, sin una segunda ruta al transporte.
       */
      private async replyCommand(
        agentName: string,
        kind: ChannelKind,
        chatId: string,
        commands: ChannelSessionCommands,
        command: ChannelCommand,
      ): Promise<void> {
        let reply: ChannelCommandReply;
        try {
          reply = commandReply(commands, agentName, kind, command, this.log);
        } catch (error) {
          this.log(
            `command failed agent=${agentName} kind=${kind} command=/${command.name}: ${String(error)}`,
          );
          reply = { text: systemLabel("commandFailed", { command: command.name }) };
        }
        await this.enqueue({
          agentName,
          kind,
          chatId,
          text: reply.text,
          ...(reply.keyboard === undefined ? {} : { keyboard: reply.keyboard }),
        });
      }

      /**
       * Una pulsación de botón (T6b): selecciona la sesión que el botón ofrece y
       * contesta por las DOS vías que existen, cada una con su trabajo.
       *
       * | caso | ACK (`answerCallback`) | outbox |
       * | --- | --- | --- |
       * | `s:<id>` + sesión seleccionada | sin texto (apaga el spinner) | `sessionSwitched` |
       * | `s:<id>` + sesión inexistente | `sessionUnknownTarget` | nada: el ACK ES la respuesta |
       * | `s:<id>` + catálogo caído | `commandFailed` | `commandFailed` (reintento del outbox) |
       * | `data` que no es `s:<id>`, id vacío, o chat sin enlazar | nada | nada |
       *
       * La asimetría de la segunda fila es deliberada: un id que no existe no va a
       * existir en el siguiente intento, así que una fila de outbox solo añadiría una
       * respuesta lenta y un reintento inútil a algo que el cliente ya mostró. Un
       * catálogo caído, en cambio, SÍ puede volver — y entonces la respuesta que el
       * humano conserva es la del outbox.
       */
      private async handleCallback(
        agentName: string,
        kind: ChannelKind,
        chatId: string,
        callback: { id: string; data: string },
      ): Promise<void> {
        const where = `agent=${agentName} kind=${kind} chat=${chatId}`;
        const sessionId = parseSessionCallbackData(callback.data);
        if (sessionId === undefined) {
          this.log(
            `callback ignored ${where}: data is not "${SESSION_CALLBACK_PREFIX}<sessionId>"`,
          );
          return;
        }
        if (callback.id === "") {
          this.log(`callback ignored ${where}: the query carries no id to acknowledge`);
          return;
        }
        const commands = this.sessionCommands;
        if (commands === undefined) {
          this.log(`callback ignored ${where}: no session catalogue is wired`);
          return;
        }

        let selected: ChannelSessionView;
        try {
          selected = commands.selectSession({ agentName, kind, sessionId });
        } catch (error) {
          if (sessionNotFound(error)) {
            await this.acknowledge(
              agentName,
              kind,
              callback.id,
              systemLabel("sessionUnknownTarget", { target: sessionId }),
            );
            return;
          }
          this.log(`callback failed ${where} session=${sessionId}: ${String(error)}`);
          const text = systemLabel("commandFailed", { command: "session" });
          await this.acknowledge(agentName, kind, callback.id, text);
          await this.enqueue({ agentName, kind, chatId, text });
          return;
        }

        await this.acknowledge(agentName, kind, callback.id);
        await this.enqueue({
          agentName,
          kind,
          chatId,
          text: systemLabel("sessionSwitched", { session: sessionRef(selected) }),
        });
      }

      /**
       * El ACK del transporte, best-effort: la pulsación ya ocurrió y lo que el humano
       * conserva es la respuesta del outbox. Un fallo aquí se REGISTRA y no se propaga
       * — jamás puede llevarse la respuesta que sí tiene reintento.
       */
      private async acknowledge(
        agentName: string,
        kind: ChannelKind,
        callbackQueryId: string,
        text?: string,
      ): Promise<void> {
        const answer = this.answerCallback;
        if (answer === undefined) return;
        try {
          await answer(agentName, kind, callbackQueryId, text);
        } catch (error) {
          this.log(`callback ACK failed agent=${agentName} kind=${kind}: ${String(error)}`);
        }
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
