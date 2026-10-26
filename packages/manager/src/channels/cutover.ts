import { listAgents, readAgent, writeAgent } from "@pihub/shared";
import { readChannelRecords } from "./store.js";

/**
 * Cutover del doble bot (channels-and-mcp, slice (c) part 3b, riesgo R3 del
 * proposal).
 *
 * Hasta este corte había DOS procesos haciendo long-polling del mismo token de
 * Telegram: el bot grammy del Runner (alimentado por `agent.json.telegramToken`)
 * y el `ChannelAdapter` del Manager (alimentado por el canal proyectado por el
 * Dashboard). Telegram solo entrega cada update a uno de los dos `getUpdates`,
 * así que la mezcla no da un error ruidoso: da mensajes que llegan a medias y
 * sesiones que se abren en un proceso u otro según el azar. Por eso el corte es
 * una sola tarea y por eso esta aserción existe: si las dos caminos siguen
 * encendidos, el Manager se niega a arrancar.
 *
 * La condición es la INTERSECCIÓN, no cualquiera de las dos mitades:
 * - token legado en `agent.json` sin canal proyectado ⇒ un único dueño (ninguno,
 *   en realidad: el bot del Runner ya no existe) y el residuo se limpia solo en
 *   la próxima escritura por `agents.ts`;
 * - canal proyectado sin token legado ⇒ arranque normal, que es el objetivo.
 *
 * Abortar fue la decisión original (coherente con `STARTUP_RECOVERY_FAILED`),
 * pero el review de confiabilidad la revocó (H6): el bot del Runner ya no existe
 * en este mismo corte, así que la condición es data muerta de una instalación
 * anterior — tumbar TODA la flota por un residuo inerte es peor que limpiarlo.
 * La disposición final es limpiar-y-loguear: el Manager elimina el `telegramToken`
 * residual del `agent.json`, emite un warning ruidoso y arranca normal.
 */

/** Nombre de error estable: lo buscan los logs y el `journalctl` del operador. */
export const DOUBLE_TELEGRAM_BOT_ERROR = "DOUBLE_TELEGRAM_BOT";

export class DoubleTelegramBotError extends Error {
  readonly code = DOUBLE_TELEGRAM_BOT_ERROR;
  readonly agents: string[];

  constructor(agents: string[]) {
    super(
      `${DOUBLE_TELEGRAM_BOT_ERROR}: ${agents.join(", ")} — un Agent con canal ` +
        `proyectado (channels.json) conserva además el campo legado ` +
        `telegramToken en su agent.json. El bot de Telegram lo posee ahora el ` +
        `Manager: borra telegramToken del agent.json (o quita el canal) para ` +
        `arrancar. Dos bots sobre el mismo token se roban updates entre sí.`,
    );
    this.name = "DoubleTelegramBotError";
    this.agents = agents;
  }
}

/**
 * Agents que tienen, a la vez, un canal proyectado y el token legado en su
 * config. Exportado separado del `assert` para poder reportarlo sin lanzar (el
 * panel de diagnóstico, un `--check` de CLI).
 */
export async function findDoubleTelegramBotAgents(
  dataDir: string,
): Promise<string[]> {
  const agents = await listAgents(dataDir);
  const conflicted: string[] = [];
  for (const config of agents) {
    if (!config.telegramToken) continue;
    const records = await readChannelRecords(dataDir, config.name);
    if (records.length > 0) conflicted.push(config.name);
  }
  return conflicted.sort();
}

    /**
     * H6 (review de confiabilidad): limpia-y-loguea en lugar de abortar. Para
     * cada Agent en conflicto: elimina el `telegramToken` residual del
     * `agent.json` (el bot que lo usaba ya no existe en este mismo corte) y
     * emite un warning ruidoso con los nombres. El arranque continúa.
     */
    export async function assertNoDoubleTelegramBot(dataDir: string): Promise<void> {
      const conflicted = await findDoubleTelegramBotAgents(dataDir);
      if (conflicted.length === 0) return;
      for (const name of conflicted) {
        const config = await readAgent(dataDir, name);
        if (!config) continue;
        delete config.telegramToken;
        await writeAgent(dataDir, config);
      }
      // Ruidoso a propósito: el operador tiene que saber que se tocó su config.
      console.error(
        `[pihub] ${DOUBLE_TELEGRAM_BOT_ERROR}: se eliminó el telegramToken legado de: ` +
          `${conflicted.join(", ")}. El bot de Telegram lo posee ahora el Manager ` +
          `(vía el canal proyectado por el dashboard); el campo en agent.json era ` +
          `un residuo del corte y ningún proceso lo leía ya.`,
      );
    }
