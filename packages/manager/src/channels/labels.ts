/**
 * Catálogo de copy de los mensajes de SISTEMA del inbound de canales (S4).
 *
 * S4 pide que todo el texto visible sea un label y nunca un literal escondido en
 * el handler. Estos son mensajes de SISTEMA: los manda el Manager por el outbox,
 * no el modelo, así que no son la respuesta de un Agent, no gastan un turno y no
 * necesitan (ni deben tener) un canal propio de entrega.
 *
 * Cada label declara sus placeholders con `{nombre}` y `systemLabel` los sustituye;
 * no hay ninguna otra forma de interpolar. Un placeholder sin valor se conserva
 * tal cual, para que un olvido se vea en el texto en vez de imprimir `undefined`.
 */
export const SYSTEM_LABELS = {
  /**
   * Código de emparejamiento de un chat todavía no enlazado. Es el texto que ya
   * se enviaba: se conserva carácter a carácter y solo cambia de dueño, para que
   * el handler no tenga copy propio.
   */
  pairingCode:
    "Este canal aún no está emparejado. Pide al propietario del agente que " +
    "introduzca este código de emparejamiento: {code}\n" +
    "Caduca en 1 hora y solo funciona desde este chat.",
  /**
   * Agent con un turno vivo (S2 / T4b). El mensaje recibido **no se ejecutó** y
   * no queda encolado: se descarta con este aviso y el usuario puede reenviarlo
   * cuando el turno en curso termine.
   */
      turnBusy:
        "El agente está ocupado con otro turno, así que este mensaje no se ha " +
        "ejecutado. Vuelve a enviarlo cuando termine el turno en curso.",

      /**
       * Comandos de texto del chat enlazado (T6a). Las respuestas de un comando son
       * mensajes de SISTEMA por el outbox: nunca un turno del Agent.
       */
      sessionRef: "{name} ({id})",
      /** Cómo se nombra una sesión que todavía no tiene nombre humano. */
      sessionUnnamed: "sin nombre",
      /** Marca de la sesión seleccionada en el listado de `/sessions`. */
      sessionSelectedMark: "(seleccionada)",
      sessionCreated:
        "He creado la sesión «{session}» y este chat ya la está usando.",
      sessionList: "Sesiones de este agente ({count} de {total}):\n{lines}",
      sessionCurrent: "Este chat está usando la sesión {session}.\nEstado del agente: {status}",
      sessionNone: "Este chat no tiene ninguna sesión seleccionada.\nEstado del agente: {status}",
      sessionSwitched: "Hecho: este chat seguirá la sesión {session}.",
      sessionUnknownTarget:
        "No hay ninguna sesión llamada «{target}» en este agente. Usa /sessions para ver " +
        "la lista y /session <nombre o id> para cambiar.",
      agentBusy: "ocupado, con un turno en curso",
      agentIdle: "libre",
      unknownCommand:
        "No conozco el comando «/{command}». Comandos disponibles: /new [nombre], " +
        "/sessions, /session [nombre o id] y /stop.",
      commandFailed:
        "No he podido ejecutar «/{command}»: el catálogo de sesiones ha fallado. " +
        "Inténtalo de nuevo.",
      stopRequested: "He pedido al agente que aborte el turno en curso.",
      stopNothing: "No hay ningún turno en curso que abortar.",
    } as const;

export type SystemLabelKey = keyof typeof SYSTEM_LABELS;

/** Render de un label del catálogo; los placeholders sin valor se conservan. */
export function systemLabel(
  key: SystemLabelKey,
  params: Readonly<Record<string, string>> = {},
): string {
  return SYSTEM_LABELS[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    params[name] ?? placeholder,
  );
}
