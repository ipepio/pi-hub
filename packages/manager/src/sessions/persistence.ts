import type { SqliteDb } from "../storage/sqlite.ts";
import { AgentSessionCatalogue } from "./catalogue.ts";

/**
 * Puerta estrecha del catálogo de sesiones, hermana de `openChannelPersistence`.
 *
 * `ManagerStore` esconde el `SqliteDb` a propósito (el driver es un detalle de
 * `storage/`), así que la producción no puede construir el catálogo por su cuenta:
 * se lo entrega esta fábrica, ya atado al MISMO driver y a la MISMA base migrada
 * que la Agenda y los canales. El caller no recibe el driver y no puede ejecutar
 * sentencias por su cuenta.
 */
export function openAgentSessionCatalogue(db: SqliteDb): AgentSessionCatalogue {
  return new AgentSessionCatalogue(db);
}
