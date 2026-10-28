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
