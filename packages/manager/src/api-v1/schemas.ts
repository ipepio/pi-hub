import { z } from "zod";

/** Spec §4.3. `name` acotado: es un nombre de directorio y de contenedor. */
export const createAgentV1Schema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
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

/**
 * Spec §4.3, PATCH. Todos los campos opcionales: un PATCH toca lo que
 * trae y deja el resto como estaba. `name` NO es actualizable — es la
 * identidad del Agent y va en la ruta.
 */
export const updateAgentV1Schema = z.object({
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  systemPrompt: z.string().optional(),
  telegramToken: z.string().nullable().optional(),
  /** `null` vuelve a la voz global (`PIHUB_TTS_VOICE`). */
  ttsVoice: z.string().nullable().optional(),
  /** `null` vuelve al default de Shared Memory del Runtime. */
  memory: z.object({ sharedAccess: z.enum(["none", "read", "read-write"]) }).nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Spec §4.3b, `PUT /agents/:name/env`. Conjunto COMPLETO — no variables
 * sueltas. La validación fina de cada clave (formato, prefijos protegidos)
 * la hace `replaceEnvStore` (`@pihub/shared`), que es la única fuente de
 * verdad de esa regla; aquí solo se exige la forma "objeto de strings".
 */
export const replaceEnvV1Schema = z.object({
  env: z.record(z.string(), z.string()),
});

/** Operación atómica del panel: el valor nunca se devuelve en la respuesta. */
export const setEnvValueV1Schema = z.object({
  value: z.string(),
});

/** Spec §4.3b, `PUT /agents/:name/packages`. Conjunto COMPLETO, converge con install/remove. */
export const replacePackagesV1Schema = z.object({
  packages: z.array(z.string().min(1)),
});

/** Operación atómica del panel: una fuente por petición. */
export const packageItemV1Schema = z.object({
  source: z.string().min(1),
});

/** Definición custom sin secretos; `apiKey` solo cruza la mutación y nunca se devuelve. */
export const customProviderV1Schema = z.object({
  baseUrl: z.string().min(1),
  models: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
  apiKey: z.string().optional(),
});

/** Skill declarativa que el dashboard ya posee: pihub recibe su UUID estable
 * y ficheros relativos a la raíz de esa Skill (`SKILL.md` es obligatorio). */
export const skillContentV1Schema = z.object({
  skillId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1),
});
