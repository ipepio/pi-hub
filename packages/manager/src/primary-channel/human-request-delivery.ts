/**
 * P3.4 — HumanRequestDelivery (A10): entrega at-least-once de una pregunta
 * humana al canal primario de Telegram.
 *
 * El cliente Bot API es **inyectable** (`{ sendMessage(token, params) }`) para
 * tests con fake; el `telegramToken` se resuelve internamente y agent-scoped
 * vía `agentConfigFor(agentName)` (A12 cablea ese resolver con el Supervisor;
 * aquí solo se deja el shape). El `primaryChatId` se inyecta en la
 * composición: ausente = fail-closed panel-only, cero llamadas a Telegram.
 *
 * Protocolo at-least-once (A10):
 * 1. Reservar la fila en `human_request_deliveries` con
 *    `external_chat_id = String(primaryChatId)` y
 *    `external_message_id = pending:<requestId>` (canal `telegram`). La reserva
 *    pending cuenta como **not_delivered**, nunca como delivered.
 * 2. Enviar UN único `sendMessage`.
 * 3. Sustituir solo `external_message_id` por `String(message_id)`.
 *
 * La tarjeta visible NO lleva el request ID crudo, ni IDs de Initiative, ni un
 * marcador reversible, ni secretos: la correlación posterior (A15) usa
 * `reply_to_message_id`. Si el proceso cae entre send y update, la fila queda
 * pending y `retryPendingDeliveries` la reintenta reconstruyendo
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

/** Resolver agent-scoped del AgentConfig (fuente del `telegramToken`). */
export type AgentConfigResolver = (agentName: string) => Promise<AgentConfig | null>;

/**
 * Catálogo de razones de `HUMAN_REQUEST_DELIVERY_FAILED` (A10):
 * 401/429/500 = respuestas HTTP del Bot API, network = caída de red/transporte,
 * json = respuesta no parseable, sqlite = fallo de INSERT/UPDATE durable.
 */
export type DeliveryFailureReason = "401" | "429" | "500" | "network" | "json" | "sqlite";

export interface HumanRequestDeliveryOptions {
  readonly client: TelegramBotClient;
  readonly agentConfigFor: AgentConfigResolver;
  /** Repositorio durable de `human_request_deliveries` (tabla v2). */
  readonly deliveries: HumanRequestDeliveries;
  /**
   * Chat privado primario de Telegram (PIHUB_TELEGRAM_PRIMARY_CHAT_ID).
   * Ausente = panel-only fail-closed: `deliver` y `retryPendingDeliveries`
   * son no-ops sin tocar el cliente ni la tabla.
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
  private readonly client: TelegramBotClient;
  private readonly agentConfigFor: AgentConfigResolver;
  private readonly deliveries: HumanRequestDeliveries;
  private readonly primaryChatId: number | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: HumanRequestDeliveryOptions) {
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
   * Entrega fire-and-forget de la pregunta (A10). Nunca lanza ni devuelve una
   * Promise rechazada: cualquier fallo (resolver, INSERT, API, red, JSON,
   * UPDATE) se sanea a `HUMAN_REQUEST_DELIVERY_FAILED reason=<catálogo>`.
   */
  async deliver(request: HumanRequest): Promise<void> {
    if (!this.hasPrimaryChat) return; // fail-closed: panel-only, cero Telegram
    const config = await this.resolveAgent(request.agentName);
    if (!config?.telegramToken) return; // sin token o Agent inválido: no-op
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
      const sent = await this.client.sendMessage(config.telegramToken, {
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
   * Reintenta las filas pending de un Agent (recuperación de proceso caído
   * entre send y update). Reconstruye question/summary/deadline desde
   * `initiatives` vía `listPendingDeliveries`; una fila ya delivered (message
   * id real) NO se reenvía. Nunca lanza al caller.
   */
  async retryPendingDeliveries(agentName: string): Promise<void> {
    if (!this.hasPrimaryChat) return;
    const config = await this.resolveAgent(agentName);
    if (!config?.telegramToken) return;
    for (const row of this.deliveries.listPendingDeliveries(agentName)) {
      try {
        const sent = await this.client.sendMessage(config.telegramToken, {
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
}
