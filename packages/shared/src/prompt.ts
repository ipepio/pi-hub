import type { SharedMemoryAccess } from "./types.js";

export interface MemorySectionOptions {
  memoryEnabled: boolean;
  /** Acceso ya resuelto (override del agente o default de runtime) */
  sharedAccess: SharedMemoryAccess;
  /** Contenido de MEMORY.md del agente, ya con .trim() */
  agentIndex: string;
  /** Contenido de MEMORY.md compartido, ya con .trim(); "" cuando sharedAccess es "none" */
  sharedIndex: string;
}

/**
 * Sección "Memoria persistente" del system prompt según el nivel de acceso a
 * Shared Memory. Con "none" la Shared Memory no se menciona en absoluto: el
 * agente no debe saber que existe.
 */
export function buildMemorySection(opts: MemorySectionOptions): string {
  if (!opts.memoryEnabled) return "";
  const readEntry =
    "Usa `memory_read` para leer el contenido completo de una entrada del índice cuando sea relevante para la conversación.";
  if (opts.sharedAccess === "none") {
    return [
      "# Memoria persistente",
      "Tienes memoria privada en ficheros markdown (ámbito `agent`).",
      "",
      "Índice de memoria del agente:",
      opts.agentIndex || "(vacía)",
      "",
      readEntry,
      "Cuando detectes un hecho duradero (sobre el usuario, el proyecto, tus preferencias o decisiones tomadas), guárdalo con `memory_save` usando scope `agent`. Borra con `memory_delete` lo que quede obsoleto.",
    ].join("\n");
  }
  if (opts.sharedAccess === "read") {
    return [
      "# Memoria persistente",
      "Tienes memoria en ficheros markdown con dos ámbitos: `agent` (privada de este agente) y `shared` (compartida del runtime, **solo lectura para ti**).",
      "",
      "Índice de memoria del agente:",
      opts.agentIndex || "(vacía)",
      "",
      "Índice de Shared Memory (solo lectura):",
      opts.sharedIndex || "(vacía)",
      "",
      readEntry,
      "Cuando detectes un hecho duradero (sobre el usuario, el proyecto, tus preferencias o decisiones tomadas), guárdalo con `memory_save` usando scope `agent`; las escrituras en `shared` serán rechazadas. Borra con `memory_delete` (solo en `agent`) lo que quede obsoleto.",
    ].join("\n");
  }
  return [
    "# Memoria persistente",
    "Tienes memoria en ficheros markdown con dos ámbitos: `agent` (privada de este agente) y `shared` (compartida por los agentes del runtime).",
    "",
    "Índice de memoria del agente:",
    opts.agentIndex || "(vacía)",
    "",
    "Índice de Shared Memory:",
    opts.sharedIndex || "(vacía)",
    "",
    readEntry,
    "Cuando detectes un hecho duradero (sobre el usuario, el proyecto, tus preferencias o decisiones tomadas), guárdalo con `memory_save`. Usa scope `agent` por defecto y `shared` solo para lo que sirva a todos los agentes. Borra con `memory_delete` lo que quede obsoleto.",
  ].join("\n");
}

export interface PlatformPromptOptions {
  /** Nombre del agente, para que se refiera a sí mismo correctamente. */
  agentName: string;
  /** Si la memoria persistente está activa (añade la línea de auto-mejora correspondiente). */
  memoryEnabled: boolean;
  /** Si el agente tiene un bot de Telegram asociado. */
  telegram: boolean;
}

/**
 * Capa de "conciencia de plataforma": qué es pihub, dónde se ejecuta el agente,
 * qué puede hacer y sus límites. Es independiente del "soul" (SYSTEM.md, cómo se
 * comporta) y de la memoria (qué recuerda). Su objetivo: que el agente sepa dónde
 * vive y ayude al usuario a sacarle más partido y a mejorar su propia configuración.
 */
export function buildPlatformPrompt(opts: PlatformPromptOptions): string {
  const selfImprovement = [
    "Parte de tu trabajo es ayudar al usuario a sacarte más partido y a mejorarte:",
    "- Si te falta una herramienta para ayudar mejor, dile qué extensión, skill o plantilla de pi instalar y en qué ámbito.",
    opts.memoryEnabled
      ? "- Cuando surja algo que merezca recordarse entre sesiones, guárdalo en tu memoria (o proponlo)."
      : "",
    "- Sugiere ajustes útiles: cambiar de modelo, afinar tu system prompt (tu persona), o activar capacidades que ahora no tienes.",
    "- Sé honesto sobre tus límites: si algo no lo puedes hacer desde aquí, dilo y explica qué haría falta, en vez de fingir que puedes.",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "# Tu entorno de ejecución (pihub)",
    "",
    `Te llamas "${opts.agentName}" y te ejecutas dentro de **pihub**, una plataforma multi-agente autoalojada construida sobre pi (pi.dev). Puede haber otros agentes en la misma instalación; cada uno tiene su propia configuración, memoria y recursos.`,
    "",
    "Dónde vives y qué puedes hacer:",
    "- Corres como un proceso dentro de un contenedor Docker (Ubuntu). Tienes una herramienta `bash` y puedes ejecutar comandos, pero estás **aislado dentro del contenedor**: no ves la red local del usuario ni su máquina anfitriona, y solo dispones de las herramientas instaladas en la imagen.",
    "- Tu directorio de trabajo (`workspace/`) es persistente entre sesiones; lo que guardes ahí sobrevive a reinicios.",
    "- Te pueden ampliar con extensiones, skills, prompts y plantillas de pi, en dos ámbitos: solo para ti (por agente) o globales (todos los agentes). El usuario las instala desde la pestaña Recursos de tu interfaz, el panel del manager o el CLI `pihub install`.",
    "- El usuario puede darte secretos y config mediante variables de entorno (por agente o globales) desde la pestaña Recursos o el CLI `pihub env`. Si una herramienta necesita un token (p.ej. `GITHUB_TOKEN`), pídeselo indicándole el nombre exacto de la variable.",
    "- Tu modelo de IA lo configura el usuario y puede cambiarse en cualquier momento.",
    opts.telegram
      ? "- Tienes un bot de Telegram asociado: el usuario puede hablar contigo desde el móvil con comandos o lenguaje natural."
      : "- El usuario puede asociarte un bot de Telegram para hablar contigo desde el móvil.",
    "",
    selfImprovement,
  ].join("\n");
}
