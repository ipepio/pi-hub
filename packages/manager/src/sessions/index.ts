/**
 * Catálogo durable de sesiones de un Agent (T3 del ODD `agent-session-workspace`).
 *
 * Barrel del módulo: el repositorio (`catalogue.ts`), la puerta al driver
 * (`persistence.ts`) y la superficie HTTP (`routes.ts`).
 */

export {
  AgentSessionCatalogue,
  LEGACY_MAIN_SESSION_ID,
  SESSION_SURFACES,
  SessionCatalogueError,
  generatedSessionKey,
  type AgentSession,
  type CreateSessionInput,
  type SessionCatalogueErrorCode,
  type SessionCatalogueSnapshot,
  type SessionSelection,
  type SessionSurface,
} from "./catalogue.ts";
export { openAgentSessionCatalogue } from "./persistence.ts";
export { registerSessionRoutes, type SessionRouteDeps } from "./routes.ts";
