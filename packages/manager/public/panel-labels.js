/*
 * Catálogo de copy del panel de sesiones (S4).
 *
 * S4 pide que todo el texto visible de la UI nueva o tocada sea un label y nunca un
 * literal escondido en el componente: encabezados, botones, textos de accesibilidad,
 * placeholders, errores, confirmaciones y estados vacío/cargando. Este archivo es la
 * ÚNICA fuente de esa copy, igual que `src/channels/labels.ts` lo es para los
 * mensajes de sistema de los canales y `agent-detail/labels.ts` para la UI del
 * dashboard.
 *
 * Cada label declara sus placeholders con `{nombre}` y `formatLabel` los sustituye;
 * no hay ninguna otra forma de interpolar. Un placeholder sin valor se conserva tal
 * cual, para que un olvido se vea en el texto en vez de imprimir `undefined` — la
 * MISMA regla que `systemLabel` en `src/channels/labels.ts`.
 */
export const SESSIONS_PANEL_LABELS = {
  /** Encabezado de la sección de sesiones del Agent (S2/S3). */
  sessionsHeading: "Sesiones",
  /**
   * Nombre accesible del disparador del tooltip del encabezado: el texto del tooltip
   * es la explicación, pero el botón necesita su propio nombre.
   */
  sessionsTooltipLabel: "Qué es una sesión",
  /**
   * Tooltip del encabezado (S4): el concepto que más se confunde es que varias
   * sesiones del MISMO Agent son conversaciones distintas, no copias.
   */
  sessionsTooltip:
    "Cada sesión es una conversación independiente del mismo Agent: comparten Agent, " +
    "Persona y Skills, pero no el historial. Cambiar de sesión conserva el historial de " +
    "todas, así que puedes volver a la anterior cuando quieras.",

  /** Fila del catálogo cuyo nombre el servidor no conoce (`name: null`). */
  sessionUnnamed: "Sesión sin nombre",
  /**
   * Marca de la entrada adoptada del runtime anterior. Por la decisión registrada en
   * el ADR 0107 solo se puede leer: no consta que su historial corresponda a un
   * contexto que se pueda reanudar (S7).
   */
  sessionLegacy: "Histórica (solo lectura)",
  /** Nombre accesible del disparador del tooltip de `sessionLegacy`. */
  sessionLegacyTooltipLabel: "Qué implica una sesión histórica",
  sessionLegacyTooltip:
    "Por la decisión registrada en el ADR 0107 las sesiones históricas solo se pueden " +
    "leer, nunca continuar: no consta que su historial corresponda a un contexto que se " +
    "pueda reanudar.",
  /**
   * Fecha de creación que el catálogo no conoce: la entrada legacy se adoptó con
   * epoch 0 y el epoch no es una fecha que se pueda enseñar. Se dice la verdad en vez
   * de inventar un dato (S7).
   */
  sessionUnknownDate: "Fecha desconocida",

  /** Selección por superficie (S3): la web y Telegram tienen punteros propios. */
  sessionSelectedWeb: "Seleccionada en web",
  sessionTelegramMark: "Seleccionada en Telegram",

  /** Acciones sobre una sesión. */
  sessionSelectAction: "Seleccionar",
  /**
   * Nombre accesible del botón de cada fila (`{name}` = sesión): varias sesiones
   * comparten el copy "Seleccionar", así que sin el nombre el botón no se distingue
   * ni con lector de pantalla ni en un test.
   */
  sessionSelectActionFor: "Seleccionar {name}",
  sessionCreateAction: "Crear sesión",
  sessionNamePlaceholder: "Nombre de la sesión (opcional)",

  /** Estados vacío/cargando/error (S4). */
  sessionsEmpty: "Este Agent todavía no tiene sesiones.",
  sessionsLoading: "Cargando sesiones…",
  sessionsLoadError: "No se pudieron cargar las sesiones.",
  sessionsRetryAction: "Reintentar",

  /** Confirmaciones (`role="status"`) y errores de acción (`role="alert"`). */
  sessionCreatedConfirmation: "Sesión creada y seleccionada en web.",
  sessionSelectedConfirmation: "Sesión seleccionada en web.",
  sessionActionError: "No se pudo completar la acción sobre la sesión.",
  /**
   * Aviso fail-closed: sin sesión web seleccionada no se envía el mensaje. El
   * catálogo es la autoridad de la identidad de sesión (S2/S3), así que inventar una
   * key local aquí recrearía justo las sesiones huérfanas que la unidad cierra.
   */
  sessionRequiredForTurn:
    "Selecciona una sesión web o crea una nueva antes de enviar un mensaje: sin sesión " +
    "no se puede empezar el turno.",
};

/** Render de un label del catálogo; los placeholders sin valor se conservan. */
export function formatLabel(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (placeholder, name) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}
