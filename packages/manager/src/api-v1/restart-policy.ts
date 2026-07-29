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
 */
export interface AgentRuntimeInputSnapshot {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  telegramToken?: string;
  ttsVoice?: string;
  memory?: AgentMemoryConfig;
  systemPrompt: string;
  env: Record<string, string>;
  packages: string[];
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
    telegramToken: input.telegramToken ?? null,
    ttsVoice: input.ttsVoice ?? null,
    memory: input.memory?.sharedAccess ?? null,
    systemPrompt: input.systemPrompt,
    env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
    packages: [...input.packages].sort(),
  });
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
