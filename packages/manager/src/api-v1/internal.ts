import { Hono } from "hono";
import { z } from "zod";
import type { AutonomyControl } from "../agenda/autonomy-control.js";
import { DomainError } from "../agenda/errors.js";
import type { HumanRequestDeliveries } from "../agenda/human-requests.js";
import type { Supervisor } from "../supervisor.js";

const telegramReplySchema = z.object({
  chatId: z.number(),
  replyToMessageId: z.number(),
  text: z.string(),
  idempotencyKey: z.string(),
}).strict();

export type TelegramReplyStatus =
  | "accepted"
  | "replayed"
  | "already_handled"
  | "expired"
  | "unknown";

type InternalRouterDeps = {
  supervisor: Pick<Supervisor, "verifyCallbackToken">;
  control: Pick<AutonomyControl, "respondToInitiative" | "initiativeForAgent">;
  deliveries: Pick<HumanRequestDeliveries, "lookupDelivery">;
  /** Reloj inyectable de test; producción captura Date.now exactamente una vez. */
  now?: () => number;
};

/**
 * Superficie exclusiva de callbacks Runner→Manager.
 *
 * El router hijo declara una sola ruta y no comparte ningún guard de `/api`:
 * la única credencial admitida es el token efímero que Supervisor resuelve al
 * Agent vivo que lo recibió durante su spawn.
 */
export function internalRouter(deps: InternalRouterDeps): Hono {
  const app = new Hono();

  app.post("/telegram-reply", async (c) => {
    // Autenticar antes de tocar el body: JSON ausente o malformado no permite
    // distinguir una credencial ausente de una inválida.
    const callbackAgentName = deps.supervisor.verifyCallbackToken(
      c.req.header("x-pihub-runner-callback-token"),
    );
    if (callbackAgentName === undefined) return c.body(null, 401);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsed = telegramReplySchema.safeParse(rawBody);
    if (!parsed.success) return c.body(null, 400);

    const body = parsed.data;
    const now = (deps.now ?? Date.now)();

    try {
      const delivery = deps.deliveries.lookupDelivery(
        callbackAgentName,
        "telegram",
        String(body.chatId),
        String(body.replyToMessageId),
      );
      if (delivery === null) {
        return c.json({ status: "unknown" satisfies TelegramReplyStatus });
      }

      try {
        const result = deps.control.respondToInitiative({
          agentName: callbackAgentName,
          initiativeId: delivery.initiativeId,
          answer: body.text,
          idempotencyKey: body.idempotencyKey,
          now,
          expectedHumanRequestId: delivery.humanRequestId,
        });
        return c.json({
          status: (result.replayed ? "replayed" : "accepted") satisfies TelegramReplyStatus,
        });
      } catch (error) {
        // Solo el conflicto de CAS esperado se puede explicar con estado
        // durable. Ningún otro DomainError (ni su message) se reclasifica.
        if (!(error instanceof DomainError) || error.code !== "INITIATIVE_STATE_CONFLICT") {
          return c.body(null, 500);
        }

        let current: ReturnType<InternalRouterDeps["control"]["initiativeForAgent"]>;
        try {
          current = deps.control.initiativeForAgent(callbackAgentName, delivery.initiativeId);
        } catch {
          return c.body(null, 500);
        }

        // Una tarjeta vieja nunca contesta una Ask nueva, incluso si la nueva
        // espera tiene por casualidad otro conflicto o deadline.
        if (current.humanRequestId !== delivery.humanRequestId) {
          return c.json({ status: "already_handled" satisfies TelegramReplyStatus });
        }
        if (
          current.state === "expired" ||
          (current.humanExpiresAt !== null && now >= current.humanExpiresAt)
        ) {
          return c.json({ status: "expired" satisfies TelegramReplyStatus });
        }
        if (current.state !== "waiting_human") {
          return c.json({ status: "already_handled" satisfies TelegramReplyStatus });
        }

        // El código era un conflicto esperado, pero el estado actual no ofrece
        // ninguna causa válida: fail closed en vez de inventar una respuesta.
        return c.body(null, 500);
      }
    } catch {
      return c.body(null, 500);
    }
  });

  return app;
}
