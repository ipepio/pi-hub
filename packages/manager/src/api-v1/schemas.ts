import { z } from "zod";

/** Spec §4.3. `name` acotado: es un nombre de directorio y de contenedor. */
export const createAgentV1Schema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  model: z.string().min(1),
  thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
  systemPrompt: z.string().optional(),
  telegramToken: z.string().optional(),
  ttsVoice: z.string().optional(),
  memory: z.object({ sharedAccess: z.enum(["none", "read", "read-write"]) }).optional(),
  packages: z.array(z.string()).optional(),
});

/** Spec §4.4. */
export const createSessionV1Schema = z.object({
  channel: z.enum(["web", "telegram"]),
  sessionKey: z.string().min(1),
});

/**
 * Spec §4.5 y §5: `turnId`, `idempotencyKey` y `correlationId` son
 * OBLIGATORIOS. Sin ellos no hay forma de reintentar sin duplicar ni de
 * correlacionar un turno entre dashboard y pihub (H01.04).
 */
export const createTurnV1Schema = z.object({
  sessionKey: z.string().min(1),
  turnId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  message: z.string(),
  abortSignal: z.boolean().optional(),
});
