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
  /**
   * LEGADO (cutover channels-and-mcp, part 3b): se acepta y se descarta. El bot
   * lo posee el Manager; la credencial va por `PUT /agents/:name/channels`.
   * @deprecated
   */
  telegramToken: z.string().optional(),
  ttsVoice: z.string().optional(),
  memory: z.object({ sharedAccess: z.enum(["none", "read", "read-write"]) }).optional(),
  packages: z.array(z.string()).optional(),
});

/**
 * Spec §4.4 (T3 del ODD `agent-session-workspace`).
 *
 * El payload LEGACY `{channel, sessionKey}` sigue valiendo y hace lo mismo que
 * antes —crear la sesión declarada—, pero ahora la fila es durable e idempotente
 * por `(agent, sessionKey)`. Los dos campos pasan a ser opcionales para que el
 * Manager pueda generar una identidad persistente propia (`name` es la etiqueta
 * humana opcional).
 *
 * La `sessionKey` se convierte en la clave con la que el Runner abre su directorio
 * de sesión, así que el catálogo rechaza lo que no puede ser una clave estable y
 * segura: vacío, demasiado larga, espacios, caracteres de control, separadores de
 * ruta, segmentos de traversal y el namespace `agent:<otro>:…` de otro Agent. Esa
 * regla vive SOLO en `sessions/catalogue.ts` (`normaliseKey`); aquí se valida el
 * tipo y nada más, para que el HTTP y el catálogo no tengan dos verdades que
 * diverjan. `channel` es la superficie de ORIGEN de la sesión; no limita desde
 * dónde se selecciona (el catálogo es uno solo y la selección es por superficie).
 */
export const createSessionV1Schema = z.object({
  channel: z.enum(["web", "telegram"]).optional(),
  sessionKey: z.string().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "name cannot contain control characters",
    })
    .optional(),
});

/**
 * Spec §4.4, `POST /agents/:name/sessions/:sessionId/select` (T3).
 *
 * La superficie es OBLIGATORIA: elegir sesión sin decir desde dónde la elige
 * escribiría la selección de web y de Telegram a la vez, que es exactamente lo que
 * S3 prohíbe. Estricto: un campo de más sería un caller creyendo que cambia otra
 * cosa.
 */
export const selectSessionV1Schema = z
  .object({ channel: z.enum(["web", "telegram"]) })
  .strict();

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
      /**
       * LEGADO (cutover channels-and-mcp, part 3b): aceptado por compatibilidad
       * durante la ventana de deprecación, nunca persistido ni parte de la huella.
       * @deprecated
       */
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

/**
 * Spec channels-and-mcp §1.4, `PUT /agents/:name/channels`. Conjunto
 * COMPLETO (replace-all): `[]` significa «ningún canal», nunca «deja lo
 * que hay». `token` es efímero — cruza la mutación y no se devuelve jamás;
 * `tokenDigest` es el sha256 del ciphertext del vault y lo único que viaja
 * a la huella de arranque. Un canal sin credencial se registra como
 * `unpaired` y no arranca ningún adapter.
 *
 * La proyección del dashboard NO lleva `sessionKey` ni `status` (decisión
 * de contrato, slice (c)): el Manager resuelve la sesión principal del
 * Agent por sí mismo (modelo de sesión unificada) y es el dueño del estado
 * de pairing/observado — un `status` del dashboard sería un segundo amo del
 * mismo hecho. Un canal revocado no llega a proyectarse. `token` y
 * `tokenDigest` son opcionales y se OMITEN (nunca `""`) cuando el canal no
 * tiene credencial: la tercera variante vacía es exactamente el tipo de
 * ambigüedad que `strict()` existe para rechazar.
 *
 * `pairingWindowEndsAt` es la ventana de auto-pair (ISO 8601) o `null`:
 * `null`/ausente = ventana CERRADA, que es la semántica del tombstone H4
 * del dashboard (un desbind manual nunca re-arma el auto-pair). El Manager
 * la guarda en el registro del canal; la consume parte 2 (auto-pair).
 */
export const channelV1Schema = z
  .object({
    kind: z.enum(["telegram"]),
    label: z.string().min(1).max(120).optional(),
    token: z.string().min(1).optional(),
    tokenDigest: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    pairingWindowEndsAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export const replaceChannelsV1Schema = z
  .object({
    channels: z.array(channelV1Schema).max(8),
  })
  .strict()
  // Un canal por Agent y kind (el índice único del lado del dashboard).
  .refine(
    (value) =>
      new Set(value.channels.map((channel) => channel.kind)).size ===
      value.channels.length,
    { message: "duplicate channel kind" },
  );

    /** Operación atómica del panel: una fuente por petición. */
    export const packageItemV1Schema = z.object({
      source: z.string().min(1),
    });
    
    /**
     * Spec channels-and-mcp §1.4, `POST /agents/:name/channels/:kind/pairing`.
     * `externalChatId` is who wants to talk to the Agent:
     *  - no `decision` → asks for a binding (auto-pair inside the projected
     *    window, a code outside it);
     *  - `decision:"approve"` → redeems the code issued for THAT chat, which is
     *    why `refine` makes `code` mandatory on that branch instead of letting
     *    a route guess;
     *  - `decision:"reject"` → drops that chat's outstanding request.
     * `POST …/approve` is the same operation spelled out for the owner's click,
     * with no `decision` field.
     */
    export const pairingRequestV1Schema = z
      .object({
        externalChatId: z.string().min(1).max(128),
        decision: z.enum(["approve", "reject"]).optional(),
        code: z
          .string()
          .min(4)
          .max(16)
          .regex(/^[A-Z2-9]+$/i)
          .optional(),
      })
      .strict()
      .refine((value) => value.decision !== "approve" || typeof value.code === "string", {
        message: "decision approve requires code",
      });
    
    /** `POST /agents/:name/channels/:kind/approve` — both fields mandatory. */
    export const approvePairingV1Schema = z
      .object({
        code: z.string().min(4).max(16).regex(/^[A-Z2-9]+$/i),
        externalChatId: z.string().min(1).max(128),
      })
      .strict();

/** Definición custom sin secretos; `apiKey` solo cruza la mutación y nunca se devuelve. */
export const customProviderV1Schema = z.object({
  baseUrl: z.string().min(1),
  models: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
  apiKey: z.string().optional(),
});

/** Proyección completa administrada por el control plane; las credenciales solo cruzan la mutación. */
export const managedProviderProjectionV1Schema = z.object({
  providers: z.array(
    z.object({
      id: z.string().min(1),
      baseUrl: z.string().min(1),
      models: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
      apiKey: z.string().optional(),
    }),
  ),
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
