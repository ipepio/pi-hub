/**
 * Máquina de estados de Initiative — Fase 2.1 del plan de Fase 2 (`/tmp/f2plan.md`).
 *
 * Pura: sin disco, sin SQLite, sin `async`. Nada de este módulo toca la base;
 * el estado durable lo escriben los repositorios (`initiatives.ts`, Fase 2.2)
 * pasando siempre por `canTransition` (autoridad declarativa, §5.1).
 *
 * La tabla consolida los dos diseños previos según §12.1: la reanudación va a
 * `queued` (no a `running`), tanto desde `waiting_human` como desde
 * `waiting_agent`, porque el Loop es el dispatcher único y reanudar a `queued`
 * hace que recolocque el despacho bajo su control de concurrencia (ADR 0004).
 */

/** Los ocho estados de una Initiative (`CONTEXT.md` "Initiative State"; `migrations.ts` CHECK de `state`). */
export type InitiativeState =
  | "queued"
  | "running"
  | "waiting_human"
  | "waiting_agent"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

/**
 * Tabla de transiciones legítimas (§4.1 y matriz de adyacencia §4.2 del plan).
 * Los cuatro terminales no tienen salida (absorbentes): cualquier comando de
 * transición sobre ellos falla. En particular `running→queued` es ilegal
 * (reencolado automático, ADR `0005`) y `waiting_agent→expired` también
 * (la caducidad de Agent Policy no aplica a `waiting_agent`, `CONTEXT.md:40`).
 */
export const LEGAL_TRANSITIONS: Readonly<Record<InitiativeState, readonly InitiativeState[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_human", "waiting_agent", "succeeded", "failed", "cancelled"],
  waiting_human: ["queued", "failed", "expired", "cancelled"],
  waiting_agent: ["queued", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  expired: [],
  cancelled: [],
};

/** ¿Es legal la transición `from → to` según la tabla consolidada del plan? */
export function canTransition(from: InitiativeState, to: InitiativeState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Estados desde los que es legal transitar a `to` — derivado en cada llamada de
 * `LEGAL_TRANSITIONS`/`canTransition`, nunca hardcodeado aparte.
 *
 * Los barridos en lote del §6 (T9/T10, `initiatives.ts`) y la red de seguridad
 * de cadena de la recuperación (§7.2, `recovery.ts`) lo usan para que su
 * `WHERE state IN (...)` sea literalmente la función pura aplicada en lote:
 * ningún camino escribe estado sin pasar por `canTransition` (el único bypass
 * es ADR 0007, §5.2).
 */
export function legalSourcesFor(to: InitiativeState): readonly InitiativeState[] {
  return (Object.keys(LEGAL_TRANSITIONS) as InitiativeState[]).filter((from) =>
    canTransition(from, to),
  );
}

const TERMINAL_STATES = new Set<InitiativeState>(["succeeded", "failed", "expired", "cancelled"]);

/**
 * ¿Es terminal el estado? Los terminales tienen `finished_at IS NOT NULL`
 * (`migrations.ts` CHECK); sobre ellos ninguna transición es legal.
 */
export function isTerminal(state: InitiativeState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Modo de ejecución de una Initiative (`migrations.ts` CHECK de `mode`;
 * `CONTEXT.md` "Solo mode" / "Ask mode").
 */
export type InitiativeMode = "solo" | "ask";

/**
 * Cambio de `mode` permitido: el Agent puede escalar `solo→ask` en runtime,
 * pero no `ask→solo` (`CONTEXT.md:52,68`). El plan (§4.1) condiciona además el
 * escalado a que ocurra al entrar en `waiting_human`; esa condición la valida
 * el comando de transición (Fase 2.2), que conoce el estado destino. Aquí se
 * fija solo la regla pura de dirección del cambio.
 */
export function canChangeMode(from: InitiativeMode, to: InitiativeMode): boolean {
  return from === "solo" && to === "ask";
}
