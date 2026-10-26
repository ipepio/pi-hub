/**
 * P3.4 — HumanRequestDelivery (A10): entrega at-least-once de una pregunta
 * humana al canal primario de Telegram.
 *
 * FIX H3 (slice (c) review round 2, HIGH). Hasta este corte la puerta era
 * `config.telegramToken`: como el cutover de canales dejó de escribir ese campo
 * en `agent.json`, el gate ya NUNCA se abría y la tarjeta de `waiting_human` se
 * perdía en silencio — cero filas, cero envíos, cero logs. La respuesta NO es
 * resucitar el token: el secreto del bot vive solo en memoria del
 * `ChannelRuntimeRegistry`. La entrega se enruta ahora por la MISMA puerta que
 * cualquier otro mensaje no-web (`channels/delivery-router.ts` →
 * `channel_outbox` → adapter vivo) y la pregunta «¿se puede entregar?» se
 * responde por el VÍNCULO (estado de pairing + canal proyectado), nunca por un
 * campo del config del Agent.
 *
 * Camino de canal (`options.channel`, el de producción):
 * 1. `boundChatOf(agentName)`: `null` ⇒ SKIP documentado
 *    (`HUMAN_REQUEST_DELIVERY_SKIPPED reason=no_bound_channel`) — igual que antes
 *    sin primario: cero efectos, cero esperas revertidas.
 * 2. Reservar la fila en `human_request_deliveries` con
 *    `external_chat_id = <chat vinculado>` y
 *    `external_message_id = pending:<requestId>` (canal `telegram`). La reserva
 *    pending cuenta como **not_delivered**, nunca como delivered.
 * 3. Encolar la tarjeta en el outbox. El `message_id` del transporte lo
 *    confirma EL OUTBOX sobre su propia fila (`channel_outbox
 *    .external_message_id`); esta clase deja de ser dueña del reintento, así que
 *    la fila HITL queda como reserva durable y `retryPendingDeliveries`
 *    re-encola (at-least-once: la tarjeta puede repetirse si el proceso cae
 *    entre la reserva y el enqueue — nunca al revés).
 *
 * Camino legado (`options.client` + `agentConfigFor` + `primaryChatId`):
 * DEPRECATED, sin llamador de producción desde el cutover. Sigue vivo solo para
 * los journeys de `waiting_human` que ya lo ejercitan; la reserva, el envío
 * único y la sustitución del placeholder por el `message_id` real conservan la
 * semántica A10 original. NO cablear este camino en el arranque: pediría un
 * token que ya no existe.
 *
 * La tarjeta visible NO lleva el request ID crudo, ni IDs de Initiative, ni un
 * marcador reversible, ni secretos. Si el proceso cae entre send y update, la
 * fila queda pending y `retryPendingDeliveries` la reintenta reconstruyendo
 * question/summary/deadline desde `initiatives`.
 *
 * Fallo de red/API/INSERT → log saneado `HUMAN_REQUEST_DELIVERY_FAILED
 * reason=<catálogo>` (401/429/500/network/json/sqlite); NUNCA revierte la
 * espera ni lanza al caller — `deliver` captura también errores síncronos y
 * jamás deja una Promise rechazada.
 */

import type { AgentConfig } from "@pihub/shared";
import type { HumanRequest, HumanRequestDeliveries } from "../agenda/human-requests.ts";

/** Parámetros del sendMessage que A10 emite hacia el Bot API de Telegram. */
export interface TelegramSendMessageParams {
  readonly chat_id: number;
  readonly text: string;
}

/** Cliente Bot API inyectable (fake en tests, real en A15). */
export interface TelegramBotClient {
  sendMessage(
    token: string,
    params: TelegramSendMessageParams,
  ): Promise<{ message_id: number }>;
}

/** Resolver agent-scoped del AgentConfig (fuente del `telegramToken` LEGADO). */
export type AgentConfigResolver = (agentName: string) => Promise<AgentConfig | null>;

/**
 * Puerta de canal (fix H3): lo que el Manager compone para que una tarjeta
 * humana salga por el canal del Agent. Es la cara de `channels/composition.ts`
 * — el enqueue NUNCA llama al transporte: deja una fila de outbox, que es lo
 * que hace el reintento, el backoff y la idempotencia.
 */
export interface HumanRequestChannelInput {
  agentName: string;
  /** Texto de la tarjeta (`deliveryCardText`), ya sin IDs ni secretos. */
  text: string;
  /** `human_request_id`: la cola lo usa como ancla idempotente del espejo. */
  requestId: string;
}

export interface HumanRequestChannel {
  /**
   * Chat vinculado del canal `telegram` del Agent, o `null` cuando no hay
   * vínculo (canal no proyectado, proyectado sin credencial o sin emparejar).
   * `null` es el único modo de «no se puede entregar»: no se consulta ningún
   * token aquí.
   */
  boundChatOf(agentName: string): Promise<string | null>;
  /**
   * Encola la tarjeta. Lanza si el vínculo desapareció entre la consulta y el
   * enqueue: el caller lo sanea como fallo y la fila queda pending.
   */
  enqueue(input: HumanRequestChannelInput): Promise<void>;
}

/**
 * Catálogo de razones de `HUMAN_REQUEST_DELIVERY_FAILED` (A10):
 * 401/429/500 = respuestas HTTP del Bot API, network = caída de red/transporte,
 * json = respuesta no parseable, sqlite = fallo de INSERT/UPDATE durable.
 */
export type DeliveryFailureReason = "401" | "429" | "500" | "network" | "json" | "sqlite";

export interface HumanRequestDeliveryOptions {
  /**
   * Puerta de canal (fix H3): la que usa producción, cableada desde
   * `composeChannels`. Cuando está presente, ES la única ruta de salida.
   */
  readonly channel?: HumanRequestChannel;
  /**
   * DEPRECATED (fix H3): cliente Bot API directo, alimentado por un token que ya
   * no existe en `agent.json`. Sin llamador de producción.
   */
  readonly client?: TelegramBotClient;
  /** DEPRECATED (fix H3): fuente del `telegramToken` legado. */
  readonly agentConfigFor?: AgentConfigResolver;
  /** Repositorio durable de `human_request_deliveries` (tabla v2). */
  readonly deliveries: HumanRequestDeliveries;
  /**
   * Chat privado primario de Telegram (PIHUB_TELEGRAM_PRIMARY_CHAT_ID).
   * DEPRECATED (fix H3): solo aplica al camino legado; con `channel` el destino
   * es el vínculo, que es lo que el contrato de canales congela.
   */
  readonly primaryChatId?: number;
  /** Reloj de `created_at` (tests sin tiempo real). */
  readonly now?: () => number;
  /** Log de fallos saneados; `console.error` en producción. */
  readonly log?: (line: string) => void;
}

const DELIVERY_PENDING_PREFIX = "pending:";

/**
 * Texto visible de la tarjeta. Contiene SOLO question/summary/deadline: sin
 * request ID crudo, sin IDs de Initiative, sin token, sin marcador reversible
 * (A10: la correlación posterior usa `reply_to_message_id`).
 */
export function deliveryCardText(question: string, summary: string, expiresAt: number): string {
  const deadline = new Date(expiresAt).toISOString();
  return [
    "❓ Pregunta para ti",
    "",
    question,
    "",
    `Contexto: ${summary}`,
    "",
    `Responde antes de ${deadline}`,
  ].join("\n");
}

/** Clasifica el fallo del cliente Bot API según el catálogo de A10. */
export function classifyApiFailure(error: unknown): DeliveryFailureReason {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "401";
    if (status === 429) return "429";
    if (typeof status === "number" && status >= 500) return "500";
  }
  if (error instanceof SyntaxError) return "json";
  return "network";
}

export class HumanRequestDelivery {
  private readonly channel: HumanRequestChannel | undefined;
  private readonly client: TelegramBotClient | undefined;
  private readonly agentConfigFor: AgentConfigResolver | undefined;
  private readonly deliveries: HumanRequestDeliveries;
  private readonly primaryChatId: number | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: HumanRequestDeliveryOptions) {
    this.channel = options.channel;
    this.client = options.client;
    this.agentConfigFor = options.agentConfigFor;
    this.deliveries = options.deliveries;
    this.primaryChatId = options.primaryChatId;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Chat primario configurado (fail-closed cuando no hay primario). */
  private get hasPrimaryChat(): boolean {
    return this.primaryChatId !== undefined;
  }

  /**
   * Entrega fire-and-forget de la pregunta (A10 + fix H3). Nunca lanza ni
   * devuelve una Promise rechazada: cualquier fallo (vínculo, resolver,
   * INSERT, API, red, JSON, UPDATE) se sanea a
   * `HUMAN_REQUEST_DELIVERY_FAILED reason=<catálogo>`.
   */
  async deliver(request: HumanRequest): Promise<void> {
    if (this.channel) {
      await this.deliverViaChannel(request);
      return;
    }
    await this.deliverViaLegacyClient(request);
  }
    
  /**
   * Camino de canal (el de producción desde H3): vínculo primero, reserva
   * durable después, enqueue al outbox al final. El orden es el de A10 —
   * reservar antes de que exista ningún efecto — de modo que un duplicado
   * (`UNIQUE (human_request_id, channel)`) no encola una segunda tarjeta.
   *
   * El `message_id` del transporte lo confirma el outbox sobre su propia fila
   * (`channel_outbox.external_message_id`); esta clase ya no es dueña del
   * reintento, así que la fila HITL queda como reserva durable.
   */
  private async deliverViaChannel(request: HumanRequest): Promise<void> {
    const channel = this.channel as HumanRequestChannel;
    const chatId = await this.resolveBoundChat(channel, request.agentName);
    if (!chatId) {
      // Sin vínculo no hay destino: el mismo fail-closed de «sin primario»,
      // pero decidido por el canal y visible en el log.
      this.skip("no_bound_channel", request.agentName);
      return;
    }
    const placeholder = `${DELIVERY_PENDING_PREFIX}${request.requestId}`;
    try {
      this.deliveries.recordDelivery({
        humanRequestId: request.requestId,
        agentName: request.agentName,
        initiativeId: request.initiativeId,
        channel: "telegram",
        externalChatId: chatId,
        externalMessageId: placeholder,
        createdAt: this.now(),
      });
    } catch (error) {
      this.fail("sqlite", request.agentName, error);
      return;
    }
    try {
      await channel.enqueue({
        agentName: request.agentName,
        text: deliveryCardText(request.question, request.summary, request.expiresAt),
        requestId: request.requestId,
      });
    } catch (error) {
      // La tarjeta no llegó a la cola: la fila queda pending y
      // `retryPendingDeliveries` la re-encola. El reintento de transporte, en
      // cambio, es del outbox.
      this.fail(classifyApiFailure(error), request.agentName, error);
    }
  }
    
  /** El vínculo manda: el destino nunca se inventa ni se lee del config. */
  private async resolveBoundChat(
    channel: HumanRequestChannel,
    agentName: string,
  ): Promise<string | null> {
    try {
      const chatId = await channel.boundChatOf(agentName);
      return typeof chatId === "string" && chatId.trim() !== "" ? chatId.trim() : null;
    } catch (error) {
      this.fail("network", agentName, error);
      return null;
    }
  }
    
  /**
   * DEPRECATED (fix H3): protocolo A10 original con un cliente de token y un
   * primario inyectado. Intacto para los journeys que aún lo ejercitan; el
   * arranque ya no lo compone porque pediría un `agent.json.telegramToken`
   * que el cutover dejó de escribir.
   */
  private async deliverViaLegacyClient(request: HumanRequest): Promise<void> {
    if (!this.hasPrimaryChat || !this.client || !this.agentConfigFor) return;
    const config = await this.resolveAgent(request.agentName);
    if (!config?.telegramToken) return; // sin token o Agent inválido: no-op
    const client = this.client;
    const chatId = this.primaryChatId as number;
    const placeholder = `${DELIVERY_PENDING_PREFIX}${request.requestId}`;
    
    // Paso 1: reserva durable pending. Si el INSERT falla (p.ej. UNIQUE
    // (human_request_id, channel) de una fila ya entregada), NO se reenvía.
    try {
      this.deliveries.recordDelivery({
        humanRequestId: request.requestId,
        agentName: request.agentName,
        initiativeId: request.initiativeId,
        channel: "telegram",
        externalChatId: String(chatId),
        externalMessageId: placeholder,
        createdAt: this.now(),
      });
    } catch (error) {
      this.fail("sqlite", request.agentName, error);
      return;
    }
    
    // Paso 2 + 3: un único sendMessage; al confirmar, sustituir el placeholder
    // por el message_id real (solo esa columna).
    try {
      const sent = await client.sendMessage(config.telegramToken, {
        chat_id: chatId,
        text: deliveryCardText(request.question, request.summary, request.expiresAt),
      });
      try {
        this.deliveries.markDelivered(
          request.agentName,
          request.requestId,
          "telegram",
          String(chatId),
          placeholder,
          String(sent.message_id),
        );
      } catch (error) {
        // Éxito Telegram + fallo SQLite: la fila queda pending y un retry
        // posterior la reenvía (at-least-once).
        this.fail("sqlite", request.agentName, error);
      }
    } catch (error) {
      this.fail(classifyApiFailure(error), request.agentName, error);
    }
  }
    
  /**
   * Reintento de las filas pending de un Agent.
   *
   * Con canal (fix H3): re-encola en el outbox, NUNCA llama a un cliente de
   * token. La ventana de duplicado es la misma at-least-once de A10 — caído
   * entre la reserva y el enqueue la fila sigue pending y se re-encola (bien);
   * caído DESPUÉS del enqueue también la re-encola, y ahí el vínculo puede ver
   * dos tarjetas. Es el precio de no tener una columna de id de outbox en la
   * tabla v2 (no se migra schema en este corte): el caso no tiene llamador de
   * producción y queda como follow-up registrado.
   *
   * Sin canal: camino legado, envía y sustituye el placeholder. Una fila ya
   * delivered (message id real) nunca se reenvía. Nunca lanza al caller.
   */
  async retryPendingDeliveries(agentName: string): Promise<void> {
    if (this.channel) {
      const channel = this.channel;
      for (const row of this.deliveries.listPendingDeliveries(agentName)) {
        try {
          await channel.enqueue({
            agentName,
            text: deliveryCardText(row.question, row.summary, row.expiresAt),
            requestId: row.humanRequestId,
          });
        } catch (error) {
          this.fail(classifyApiFailure(error), agentName, error);
        }
      }
      return;
    }
    if (!this.hasPrimaryChat || !this.client || !this.agentConfigFor) return;
    const client = this.client;
    const config = await this.resolveAgent(agentName);
    if (!config?.telegramToken) return;
    for (const row of this.deliveries.listPendingDeliveries(agentName)) {
      try {
        const sent = await client.sendMessage(config.telegramToken, {
          chat_id: Number(row.externalChatId),
          text: deliveryCardText(row.question, row.summary, row.expiresAt),
        });
        try {
          this.deliveries.markDelivered(
            agentName,
            row.humanRequestId,
            row.channel,
            row.externalChatId,
            row.externalMessageId,
            String(sent.message_id),
          );
        } catch (error) {
          this.fail("sqlite", agentName, error);
        }
      } catch (error) {
        this.fail(classifyApiFailure(error), agentName, error);
      }
    }
  }
    
  /** Resuelve el Agent agent-scoped; un fallo del resolver se sanea como red. */
  private async resolveAgent(agentName: string): Promise<AgentConfig | null> {
    const resolver = this.agentConfigFor;
    if (!resolver) return null;
    try {
      return await this.agentConfigFor(agentName);
    } catch (error) {
      this.fail("network", agentName, error);
      return null;
    }
  }

      /** Log saneado: razón catalogada + agent; jamás token, IDs ni texto crudo. */
      private fail(reason: DeliveryFailureReason, agentName: string, _error: unknown): void {
        this.log(`HUMAN_REQUEST_DELIVERY_FAILED reason=${reason} agent=${agentName}`);
      }
    
      /**
       * Skip de canal (fix H3): no es un fallo — no hay vínculo que entregar. Se
       * registra aparte para que «espera sin tarjeta» sea distinguishable en
       * `journalctl` de «tarjeta rechazada por el transporte».
       */
      private skip(reason: string, agentName: string): void {
        this.log(`HUMAN_REQUEST_DELIVERY_SKIPPED reason=${reason} agent=${agentName}`);
      }
}
