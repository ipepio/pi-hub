import type { AgentMemoryConfig, ThinkingLevel } from "@pihub/shared";

/**
 * Todo lo que el Runner lee al arrancar (spawnRunner/runnerEnvFor en
 * supervisor.ts + readSystemPrompt/listPackages en agents.ts). Si un campo
 * nuevo se añade a lo que el Runner consume al arrancar y no se refleja
 * aquí, ese campo podrá cambiarse por `/api/v1` sin que el Runner en marcha
 * se entere nunca — es exactamente el bug que esta huella cierra.
 *
 * `env` es el store del Agent (no el global, ni el entorno de sistema): es
 * lo único de `resolveRunnerEnv` que el dashboard controla vía
 * `/api/v1/agents/:name/env`.
 *
 * `channels` entra por la misma razón (channels-and-mcp, slice (c)): el
 * conjunto de canales proyectados cambia el comportamiento observable del
 * Agent — y desde el cutover (part 3b) es LO ÚNICO que lo cambia en este
 * terreno: el Runner ya no lee ningún token, así que la presencia de canal,
 * su credencial y su rotación viajan como (kind, tokenDigest). El token lo
 * posee el Manager (`channels/registry.ts`) y el digest lo pone el dashboard
 * desde el vault.
 *
 * `telegramToken` SALIÓ del snapshot en el cutover: era el bot del Runner, y
 * ese bot ya no existe. Dejarlo habría significado reiniciar el proceso por un
 * campo que nadie lee; tenerlo en claro habría sido un secreto en una huella
 * que sale por logs (la precedente es `supervisor.statusOf`, que sigue
 * redactando el residuo legado antes de devolver un `AgentStatus`).
 */

/**
 * Un canal en la forma que la huella puede ver. `label` se acepta en el
 * snapshot porque las rutas ya la tienen a mano, pero NO entra en la huella: no
 * lo lee nadie al arrancar y reiniciar por una etiqueta mataría un turno vivo
 * sin ningún efecto observable (runtime-projection: «label changes do NOT
 * trigger restart», tasks (c-T4)).
 */
export interface AgentChannelFingerprintInput {
  kind: string;
  label?: string;
  tokenDigest?: string;
}

export interface AgentRuntimeInputSnapshot {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  ttsVoice?: string;
  memory?: AgentMemoryConfig;
  systemPrompt: string;
  env: Record<string, string>;
  packages: string[];
  /** Canales proyectados del Agent. Ausente = ninguno (misma huella que `[]`). */
  channels?: AgentChannelFingerprintInput[];
}

/**
 * Huella estable de `AgentRuntimeInputSnapshot`: dos snapshots que producen
 * la misma huella harían arrancar un Runner en el mismo estado observable,
 * así que reiniciar entre ellos sería un reinicio sin efecto — y por tanto
 * uno que no hay que pagar (mata el turno en curso, ver `decideRuntimeAction`).
 *
 * `env`/`packages` se ordenan antes de serializar: son conjuntos, y el orden
 * en que el caller los mandó no es información — solo lo son sus elementos.
 */
export function agentRuntimeFingerprint(input: AgentRuntimeInputSnapshot): string {
  return JSON.stringify({
    model: input.model ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    ttsVoice: input.ttsVoice ?? null,
    memory: input.memory?.sharedAccess ?? null,
    systemPrompt: input.systemPrompt,
    env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
    packages: [...input.packages].sort(),
    // Proyectado a (kind, tokenDigest) y ordenado: es un conjunto, y el orden
    // en que el caller lo mandó no es información.
    channels: (input.channels ?? [])
      .map((channel) => ({
        kind: channel.kind,
        tokenDigest: channel.tokenDigest ?? null,
      }))
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          (a.tokenDigest ?? "").localeCompare(b.tokenDigest ?? ""),
      ),
  });
}

/** Subconjunto de `UpdateAgentInput` (agents.ts) relevante para la huella de arranque. */
export interface UpdateAgentRuntimeFields {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  ttsVoice?: string | null;
  memory?: AgentMemoryConfig | null;
  enabled?: boolean;
}

/** Config actual, en la forma mínima que `projectUpdatedAgent` necesita leer. */
export interface CurrentAgentRuntimeFields {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  ttsVoice?: string;
  memory?: AgentMemoryConfig;
  enabled: boolean;
}

/**
 * Proyecta el config que resultaría de aplicar `input` sobre `config`, SIN
 * escribir a disco. Espeja campo a campo el merge real de `updateAgent`
 * (`packages/manager/src/agents.ts`): un campo ausente de `input` conserva
 * el valor actual, y `null` explícito limpia el campo (vuelve a `undefined`).
 *
 * Duplicado a propósito: el PATCH necesita saber SI haría falta reiniciar
 * antes de persistir, para poder rechazar con `409 TURN_IN_PROGRESS` sin
 * dejar el config a medio actualizar mientras el Runner viejo sigue vivo.
 * Si `updateAgent` cambia su semántica de merge, esta función tiene que
 * actualizarse junto a ella.
 */
export function projectUpdatedAgent(
  config: CurrentAgentRuntimeFields,
  input: UpdateAgentRuntimeFields,
): CurrentAgentRuntimeFields {
  return {
    model: input.model !== undefined ? input.model : config.model,
    thinkingLevel: input.thinkingLevel !== undefined ? input.thinkingLevel : config.thinkingLevel,
    ttsVoice: "ttsVoice" in input ? (input.ttsVoice ?? undefined) : config.ttsVoice,
    memory: "memory" in input ? (input.memory ?? undefined) : config.memory,
    enabled: input.enabled !== undefined ? input.enabled : config.enabled,
  };
}

/** Igual que `projectUpdatedAgent`, para el `systemPrompt` (fichero aparte, no en `agent.json`). */
export function projectSystemPrompt(current: string, input: { systemPrompt?: string }): string {
  return input.systemPrompt !== undefined ? input.systemPrompt : current;
}

/**
 * ¿Hay algún turno vivo del Agent `agentName` entre las claves registradas
 * (`agent:turnId`, ver `claveTurno` en `routes.ts`)? Pura y sin WS a
 * propósito: la ruta la usa contra el registro real (`Map<string, WebSocket>`
 * de sockets abiertos), pero la decisión en sí — "hay coincidencia de
 * prefijo" — no necesita un socket para poder probarse.
 */
export function hasLiveTurnForAgent(liveTurnKeys: Iterable<string>, agentName: string): boolean {
  const prefix = `${agentName}:`;
  for (const key of liveTurnKeys) if (key.startsWith(prefix)) return true;
  return false;
}

export type RuntimeAction = "none" | "start" | "stop" | "restart";

/**
 * Decide qué hacer con el proceso del Runner tras una escritura por
 * `/api/v1` (PATCH de Agent, `PUT /env`, `PUT /packages`, `start`/`stop`).
 *
 * Prioridad, de mayor a menor especificidad:
 * 1. Deshabilitar SIEMPRE para el proceso si estaba corriendo — hoy no lo
 *    hace (bug 2: `{enabled:false}` persiste pero el proceso sigue vivo).
 * 2. Habilitar un Agent deshabilitado lo arranca, sin mirar la huella: un
 *    Runner que no existe no tiene "huella anterior" con la que comparar.
 * 3. Un Agent parado y habilitado NO se arranca por sorpresa — garantía ya
 *    probada en `api-v1-telegram-update.test.ts` ("PATCH de un Agent parado
 *    nunca lo arranca"); el siguiente `start` explícito leerá el config ya
 *    actualizado.
 * 4. Con el Runner corriendo, reinicia solo si la huella cambió de verdad.
 */
export function decideRuntimeAction(input: {
  wasRunning: boolean;
  wasEnabled: boolean;
  isEnabled: boolean;
  fingerprintChanged: boolean;
}): RuntimeAction {
  if (!input.isEnabled) return input.wasRunning ? "stop" : "none";
  if (!input.wasEnabled) return "start";
  if (!input.wasRunning) return "none";
  return input.fingerprintChanged ? "restart" : "none";
}
