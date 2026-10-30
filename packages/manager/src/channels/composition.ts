import type { ChannelKind, InboundMessage, InlineKeyboardButton } from "@pihub/channels";
import type {
  CompletedTurn,
  TurnExecution,
} from "../agenda/turn-execution.ts";
import type { HumanRequestChannel } from "../primary-channel/human-request-delivery.ts";
import type { AgentSessionCatalogue, SessionSurface } from "../sessions/catalogue.ts";
import { ChannelDeliveryRouter } from "./delivery-router.ts";
import {
  catalogueSessionCommands,
  ChannelInboundHandler,
} from "./inbound.ts";
import type { ChannelExchangeLog } from "./exchange-log.ts";
import type { ChannelOutbox, ChannelOutboxOptions } from "./outbox.ts";
import { ChannelOutboxWorker } from "./outbox-worker.ts";
import type { ChannelPersistence } from "./persistence.ts";
import type { PairingMachine } from "./pairing.ts";

/**
 * Slice (c) part 3a, items 4-5 — the single place the channel machinery is
 * bolted together.
 *
 * Parts 1 and 2 shipped each piece as a class with its own injectable seams, and
 * the result was a Manager that could not deliver anything: no code built the
 * outbox (the SQLite driver was hidden), nothing called `drain()`, no
 * `GET …/channel-exchanges` reader was wired, `onTurnCompleted` had no consumer
 * and `registry.attachInbound` was never called. This file is that wiring, and
 * only that: every decision (retry, backoff, lease, origin routing, pairing)
 * stays with the module that owned it before.
 *
 * ```
 *  inbound (adapter.onInbound) ─▶ pairing ─▶ turns.startTurn(origin: channel)
 *                                                     │ completion
 *                                                     ▼
 *                       router.onTurnCompleted ─▶ channel_exchanges  (mirror for D)
 *                                                     │
 *                                                     ▼
 *                                          channel_outbox ─▶ worker.drain ─▶ registry.send
 * ```
 *
 * Two facts about the shape of this function:
 * - **It has no I/O of its own.** It builds objects; it does not start the
 *   drain loop. The composition root (`startup.ts` + `index.ts`) decides when
 *   the heartbeat begins and when it stops, because that order is a shutdown
 *   contract, not a channel one.
     * - **The transport is the registry.** The outbox's `send` goes through
     *   `ChannelRuntimeRegistry.send`, i.e. through the LIVE adapter of that Agent +
     *   kind. No adapter is a retryable `unavailable` (the channel may come back),
     *   and this file never sees a token.
     * - **The session of an inbound turn is a SELECTION, not a constant** (T5b/2). The
     *   only thing this file knows about the durable catalogue is the narrow
     *   `getSelectedSession` face it passes to the inbound handler, which calls it when
     *   the message is accepted. Which surface a `ChannelKind` selects on is a wiring
     *   fact and lives here, in one exhaustive map.
     */

    /**
     * La superficie cuya selección gobierna cada tipo de canal (S3).
     *
     * `Record<ChannelKind, …>` a propósito: si `CHANNEL_KINDS` gana un elemento, este
     * mapa deja de compilar en vez de mandar un canal nuevo a la sesión de otro.
     */
    const SURFACE_BY_CHANNEL: Record<ChannelKind, SessionSurface> = {
      telegram: "telegram",
    };

/** Registry face the composition needs: the transport door and the inbound slot. */
export interface ChannelTransportLike {
  send(
    agentName: string,
    kind: ChannelKind,
    input: { chatId: string; text: string; keyboard?: InlineKeyboardButton[][] },
  ): Promise<{ messageId: string }>;
  /**
   * ACK de una pulsación de botón (T6b). Best-effort por contrato: el registry nunca
   * lo rechaza (un adaptador ausente resuelve en silencio y un fallo del transporte
   * solo deja una línea de log), así que el inbound puede acusar sin proteger la
   * respuesta que sí tiene reintento.
   */
  answerCallback(
    agentName: string,
    kind: ChannelKind,
    callbackQueryId: string,
    text?: string,
  ): Promise<void>;
  attachInbound(
    handler: (agentName: string, kind: ChannelKind, message: InboundMessage) => void,
  ): void;
}

export interface ChannelCompositionDeps {
  /** Where `channels.json` lives: the binding check reads it. */
  dataDir: string;
  /** The v4 tables, through the narrow `ManagerStore` facade. */
  persistence: ChannelPersistence;
  registry: ChannelTransportLike;
  pairing: PairingMachine;
      /** The shared `TurnExecution`: a channel inbound becomes a real turn. */
          turns: Pick<
            TurnExecution,
            "startTurn" | "abort" | "liveTurnIdForAgent" | "hasLiveTurnForAgent"
          >;
      /**
       * Catálogo durable de sesiones (T5b/2). El composition root de producción SIEMPRE
       * pasa `store.sessions`: un mensaje entrante corre en la sesión seleccionada de SU
       * superficie, capturada al aceptarlo. Omitirlo conserva el comportamiento
       * histórico `agent:<nombre>:main`, que es una dependencia de los tests anteriores a
       * esta unidad y no lo que arranca la producción.
       */
          sessions?: Pick<
            AgentSessionCatalogue,
            "getSelectedSession" | "create" | "list" | "select"
          >;
  /** Runner port resolver — never a restart, never a port in the wire. */
  resolveRunner: (agentName: string) => Promise<{ port: number } | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  /** Outbox tuning (tests shorten the lease/backoff; production takes the defaults). */
  outbox?: Pick<
    ChannelOutboxOptions,
    "maxAttempts" | "leaseMs" | "backoffBaseMs" | "backoffCapMs" | "batch"
  >;
  /** Drain cadence of the worker the caller starts later. */
  drainIntervalMs?: number;
}

export interface ChannelComposition {
  outbox: ChannelOutbox;
  exchanges: ChannelExchangeLog;
  router: ChannelDeliveryRouter;
  inbound: ChannelInboundHandler;
  /**
   * HITL door (fix H3): the face `HumanRequestDelivery` takes. A waiting-human
   * card is an agent-originated message like any other, so it leaves through the
   * SAME router/outbox and is decided by the SAME binding — never by an
   * `agent.json.telegramToken`, which the cutover stopped writing and whose
   * silence was what made the card disappear.
   */
  hitl: HumanRequestChannel;
  /** Built, NOT started: the composition root owns start/stop. */
  worker: ChannelOutboxWorker;
  /**
   * The exact face `TurnExecution.onTurnCompleted` takes. Fire-and-forget and
   * silent about its own failures — a broken delivery path must never turn a
   * finished Agent turn into a failed one, and a Manager without channels
   * composed simply does not pass this hook at all.
   */
  onTurnCompleted: (turn: CompletedTurn) => void;
}

/** Builds the channel runtime for one Manager process. Pure object assembly. */
export function composeChannels(deps: ChannelCompositionDeps): ChannelComposition {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.error(`[channels] ${line}`));
  const exchanges = deps.persistence.exchanges;

  // The queue: its transport is the LIVE adapter, resolved per row. A row that
  // asks for a channel that is not running is a retryable failure, decided by
  // the outbox — this closure only reports what the registry said.
  const outbox = deps.persistence.createOutbox({
    ...deps.outbox,
    now,
    log,
    send: async (row) => {
      const { messageId } = await deps.registry.send(row.agentName, row.kind, {
        chatId: row.target,
        text: row.text,
        // T6b: los botones van DENTRO de la fila (payload), así que sobreviven al
        // reinicio con el resto del mensaje y llegan al transporte sin cambios.
        ...(row.keyboard === undefined ? {} : { keyboard: row.keyboard }),
      });
      return messageId;
    },
  });

  // Delivery-by-origin: the reply of a channel turn and the proactive message
  // both leave through the outbox, and both mirror into `channel_exchanges`.
  const router = new ChannelDeliveryRouter({
    dataDir: deps.dataDir,
    pairing: deps.pairing,
    exchanges,
    now,
    log,
    enqueue: async (input) => {
      await outbox.enqueue(input);
    },
  });

  const inbound = new ChannelInboundHandler({
    dataDir: deps.dataDir,
    pairing: deps.pairing,
    turns: deps.turns,
    resolveRunner: deps.resolveRunner,
    log,
    // T5b/2: la sesión del turno es la seleccionada en la superficie del canal. El
    // callback se resuelve al ACEPTAR el mensaje (no al despacharlo), y un error del
    // catálogo lo trata el inbound como fail-closed. Sin catálogo inyectado la costura
    // queda sin definir y el handler usa la main histórica.
        sessionKeyFor: deps.sessions
          ? (agentName: string, kind: ChannelKind) =>
              deps.sessions!.getSelectedSession({
                agentName,
                channel: SURFACE_BY_CHANNEL[kind],
                now: now(),
              }).key
          : undefined,
        // T6a: comandos de texto de sesión (/new, /sessions, /session, /stop) sobre el
        // catálogo durable. Sin catálogo la costura queda sin definir y el handler
        // trata "/…" como texto (comportamiento histórico de los tests previos).
        sessionCommands: deps.sessions
          ? catalogueSessionCommands({
              sessions: deps.sessions,
              surfaceOf: (kind) => SURFACE_BY_CHANNEL[kind],
              now,
              isBusy: (agentName) => deps.turns.hasLiveTurnForAgent(agentName),
              abortIfLive: (agentName) => {
                const turnId = deps.turns.liveTurnIdForAgent(agentName);
                return turnId !== undefined ? deps.turns.abort(agentName, turnId) : false;
              },
            })
          : undefined,
    // T6b: el ACK de una pulsación de botón sale por el MISMO registry que envía
    // los mensajes, así que no hay una segunda ruta al transporte ni un segundo
    // dueño de los fallos (el registry los registra y nunca los lanza).
    answerCallback: (agentName, kind, callbackQueryId, text) =>
      deps.registry.answerCallback(agentName, kind, callbackQueryId, text),
    // System replies (a pairing code) are outbox rows too: the transport is
    // never touched directly, so one owner keeps the retry policy.
    //
    // T6b: un teclado solo se serializa cuando EXISTE, así que el payload de todas
    // las respuestas de sistema anteriores a esta unidad sigue siendo byte a byte el
    // mismo (`{"text":…}`).
    enqueue: async (input) => {
      await outbox.enqueue({
        agentName: input.agentName,
        kind: input.kind,
        target: input.chatId,
        payload:
          input.keyboard === undefined
            ? JSON.stringify({ text: input.text })
            : JSON.stringify({ text: input.text, keyboard: input.keyboard }),
      });
    },
  });

  // The seam part 2b left dangling: the registry carries the inbound callback,
  // and this is the only call that makes a bot message reach a turn.
  deps.registry.attachInbound((agentName, kind, message) =>
    inbound.handle(agentName, kind, message),
  );

  const worker = new ChannelOutboxWorker({
    outbox,
    intervalMs: deps.drainIntervalMs,
    leaseMs: deps.outbox?.leaseMs,
    log,
  });

  /**
   * The HITL door, on the two seams that already exist: `router.boundChatOf` (is
   * there a destination?) and `router.enqueueProactive` (mirror + outbox row). No
   * token crosses this boundary in either direction, and the card gets the
   * queue's retry/backoff/idempotency for free.
   *
   * `turnId = hitl:<requestId>` is deliberate: `channel_exchanges.turn_id` is
   * UNIQUE, so replaying the same human request cannot append a second mirror
   * row, while a NEW question (new requestId) is a NEW exchange.
   */
  const hitl: HumanRequestChannel = {
    boundChatOf: (agentName) => router.boundChatOf(agentName, "telegram"),
    enqueue: async ({ agentName, text, requestId }) => {
      const queued = await router.enqueueProactive({
        agentName,
        text,
        kind: "telegram",
        turnId: `hitl:${requestId}`,
      });
      if (!queued) {
        throw new Error(
          `no bound "telegram" channel for agent "${agentName}": HITL card not queued`,
        );
      }
    },
  };

  return {
    outbox,
    exchanges,
    router,
    inbound,
    hitl,
    worker,
    onTurnCompleted: (turn) => router.handle(turn),
  };
}
