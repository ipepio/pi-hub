import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../storage/sqlite.ts";
import { mainSessionKeyOf } from "../channels/inbound.ts";

/**
 * Catálogo durable de sesiones de un Agent (T3 del ODD `agent-session-workspace`,
 * specs S2 y S7).
 *
 * QUÉ ES: el hecho «este Agent tiene estas conversaciones» vive aquí y en ningún
 * otro sitio. Un Agent deja de tener UNA sesión y pasa a tener N historiales
 * durables, con UNA seleccionada por superficie (web / Telegram) que el humano
 * puede cambiar sin perder las demás.
 *
 * QUÉ NO ES TODAVÍA: este módulo no ejecuta turnos, no bloquea sesiones
 * concurrentes y no reanuda contexto del Runner. La admisión de un único turno
 * cross-origin (T4) y el transcript compartido (T5) se apoyarán en estas filas,
 * pero sus invariantes no se afirman aquí.
 *
 * Decisiones que el catálogo toma y sostiene:
 *  1. **Identidad por Agent.** La PK es `(agent_name, session_id)` y `session_key`
 *     es única POR Agent. Una sesión de `alice` no se puede seleccionar desde
 *     `bob`: la consulta está calificada por Agent y la FK compuesta de la
 *     selección lo vuelve imposible por esquema.
 *  2. **La key es lo que ve el Runner, el id lo que ve el humano/API.** Las keys
 *     generadas llevan el Agent dentro (`agent:<nombre>:session:<uuid>`), que es
 *     el mismo espacio de nombres que el `agent:<nombre>:main` del runtime actual.
 *  3. **Una sola adopción del legado.** El `agent:<nombre>:main` que hoy usan web y
 *     Telegram se materializa como entrada `legacy: true` la PRIMERA vez que el
 *     catálogo de ese Agent se toca, y se convierte en la selección por defecto de
 *     las dos superficies. Así el comportamiento actual (una conversación
 *     compartida) sobrevive intacto hasta que alguien seleccione otra sesión. No
 *     se mueve ni se borra ningún fichero del Runner: la sesión ya existe en disco,
 *     aquí solo se la nombra.
 *  4. **Crear es idempotente por key.** Un caller legacy que reintenta el mismo
 *     `{channel, sessionKey}` recibe LA MISMA fila (mismo id, mismo `createdAt`),
 *     no una segunda sesión apuntando a la misma clave del Runner — dos filas con
 *     la misma key serían dos nombres para un solo contexto.
 *  5. **Los ids legacy del dashboard no se adoptan.** Las filas históricas del
 *     transcript web usan UUIDs que NO corresponden a contextos independientes del
 *     Runner; importarlas prometería una reanudación que no existe (S7). Su
 *     inspección/migración es de otra unidad (T5).
 *  6. **La forma de la key se decide AQUÍ, y solo aquí.** La key nombra el
 *     directorio de sesión del Runner y el espacio de nombres del Agent, así que se
 *     rechazan separadores de ruta, traversal, control/espacios y el namespace
 *     `agent:<otro>:…`. Lo que ya existe (UUID, nombre simple, la key de este
 *     Agent) sigue valiendo. El schema HTTP no repite la regla: ver `normaliseKey`.
 *  7. **Borrar el Agent borra su catálogo.** `deleteForAgent` es la mitad de estado
 *     que el borrado del directorio no alcanza; sin él, recrear el mismo nombre
 *     hereda historiales y selección.
 *
 * Lecturas que escriben, a propósito: `list()` materializa la entrada legacy y las
 * selecciones por defecto (misma operación idempotente que `create()`/`select()`,
 * vía `ensureAgentCatalogue`). Se documenta y se prueba porque un GET que escribe
 * es una decisión, no un accidente: la alternativa sería sintetizar el legado en
 * cada lectura y no poder seleccionarlo explícitamente.
 */

/** Las dos superficies con selección independiente (S3). */
export type SessionSurface = "web" | "telegram";

export const SESSION_SURFACES: readonly SessionSurface[] = ["web", "telegram"];

/** Id estable de la entrada legacy: el `agent:<nombre>:main` del runtime actual. */
export const LEGACY_MAIN_SESSION_ID = "main";

/**
 * `createdAt` de la entrada legacy adoptada: el epoch, no el reloj de la primera
 * lectura.
 *
 * La sesión `agent:<nombre>:main` existía ANTES de que este catálogo existiera, así
 * que su fecha de creación es desconocida. Guardar `now` al adoptarla convertía
 * «cuándo se leyó por primera vez» en «cuándo nació la conversación»: dos Managers
 * con el mismo pasado veían fechas distintas por el mismo hecho y el orden del
 * catálogo dependía de cuándo arrancó cada uno. El epoch es el marcador honesto y
 * determinista de «desconocido» (S7: no inventamos datos del legado).
 */
export const LEGACY_CREATED_AT = 0;

export interface AgentSession {
  readonly agentName: string;
  readonly id: string;
  /** Key con la que el Runner abre el contexto (su directorio de sesión). */
  readonly key: string;
  /** Superficie de ORIGEN. No restringe desde dónde se puede seleccionar. */
  readonly channel: SessionSurface;
  /** Etiqueta humana opcional; `null` = sin nombre todavía. */
  readonly name: string | null;
  /** `true` solo para la entrada adoptada del runtime pre-catálogo. */
  readonly legacy: boolean;
  readonly createdAt: number;
}

/** Qué sesión está seleccionada en cada superficie; `null` = ninguna. */
export interface SessionSelection {
  web: string | null;
  telegram: string | null;
}

export interface SessionCatalogueSnapshot {
  readonly sessions: AgentSession[];
  readonly selection: SessionSelection;
}

export interface CreateSessionInput {
  agentName: string;
  channel: SessionSurface;
  /** Key legacy aportada por el caller; ausente = el catálogo la genera. */
  sessionKey?: string;
  name?: string;
  now: number;
}

export interface SelectSessionInput {
  agentName: string;
  /** Superficie DESDE la que se elige; la otra no se toca (S3). */
  channel: SessionSurface;
  sessionId: string;
  now: number;
}

/** Pregunta «qué sesión está seleccionada en ESTA superficie» (T5b/2). */
export interface SelectedSessionInput {
  agentName: string;
  /** Superficie del turno que se va a abrir (no restringe las demás). */
  channel: SessionSurface;
  now: number;
}

/** Catálogo cerrado de lo que este módulo lanza; las rutas lo mapean a HTTP tal cual. */
export type SessionCatalogueErrorCode = "BAD_REQUEST" | "SESSION_NOT_FOUND";

export class SessionCatalogueError extends Error {
  readonly code: SessionCatalogueErrorCode;

  constructor(code: SessionCatalogueErrorCode, message: string) {
    super(message);
    this.name = "SessionCatalogueError";
    this.code = code;
  }
}

/**
 * Key generada de una sesión nueva. Vive en el espacio de nombres del Agent para
 * que el runner nunca pueda confundir dos conversaciones de Agents distintos, y
 * para que sea legible en `logs`/`sessions` sin traducir un hash.
 */
export function generatedSessionKey(agentName: string, sessionId: string): string {
  return `agent:${agentName}:session:${sessionId}`;
}

interface RawSession {
  agent_name: string;
  session_id: string;
  session_key: string;
  channel: string;
  name: string | null;
  legacy: number;
  created_at: number;
}

interface RawSelection {
  channel: string;
  session_id: string;
}

const SQL_INSERT_LEGACY_MAIN = `
  INSERT OR IGNORE INTO agent_sessions
    (agent_name, session_id, session_key, channel, name, legacy, created_at)
  VALUES (?, ?, ?, 'web', NULL, 1, ?)
`;

const SQL_BY_KEY =
  "SELECT * FROM agent_sessions WHERE agent_name = ? AND session_key = ?";

const SQL_BY_ID =
  "SELECT * FROM agent_sessions WHERE agent_name = ? AND session_id = ?";

/**
 * La entrada legacy primero (`legacy DESC`): es la conversación que el humano ya
 * tenía y la que el catálogo selecciona por defecto, así que aparece arriba y no
 * se mueve cuando se crean sesiones nuevas.
 */
const SQL_LIST = `
  SELECT * FROM agent_sessions
  WHERE agent_name = ?
  ORDER BY legacy DESC, created_at ASC, session_id ASC
`;

const SQL_INSERT_SESSION = `
  INSERT INTO agent_sessions
    (agent_name, session_id, session_key, channel, name, legacy, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?)
`;

const SQL_DEFAULT_SELECTION = `
  INSERT OR IGNORE INTO agent_session_selection
    (agent_name, channel, session_id, selected_at)
  VALUES (?, ?, ?, ?)
`;

const SQL_LIST_SELECTION =
  "SELECT channel, session_id FROM agent_session_selection WHERE agent_name = ?";

const SQL_SELECTION_BY_SURFACE = `
  SELECT channel, session_id
  FROM agent_session_selection
  WHERE agent_name = ? AND channel = ?
`;

const SQL_DELETE_SELECTION_FOR_AGENT =
  "DELETE FROM agent_session_selection WHERE agent_name = ?";

const SQL_DELETE_SESSIONS_FOR_AGENT =
  "DELETE FROM agent_sessions WHERE agent_name = ?";

/**
 * La selección es un UPSERT sobre `(agent_name, channel)`: cada superficie tiene
 * UNA fila y elegir otra sesión la reemplaza. `BEGIN IMMEDIATE` en `select()` hace
 * que la comprobación de propiedad y la escritura sean la misma transacción, así
 * que dos peticiones simultáneas no pueden dejar la selección apuntando a una fila
 * que ya no existe.
 */
const SQL_SELECT_SESSION = `
  INSERT INTO agent_session_selection
    (agent_name, channel, session_id, selected_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(agent_name, channel) DO UPDATE SET
    session_id = excluded.session_id,
    selected_at = excluded.selected_at
`;

function toSession(raw: RawSession): AgentSession {
  return {
    agentName: raw.agent_name,
    id: raw.session_id,
    key: raw.session_key,
    channel: raw.channel as SessionSurface,
    name: raw.name,
    legacy: raw.legacy === 1,
    createdAt: Number(raw.created_at),
  };
}

function assertAgentName(agentName: string): void {
  if (typeof agentName !== "string" || agentName.trim() === "") {
    throw new SessionCatalogueError("BAD_REQUEST", "A session needs an agent name");
  }
}

function assertSurface(channel: string): asserts channel is SessionSurface {
  if (!SESSION_SURFACES.includes(channel as SessionSurface)) {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      `Unknown session surface: ${String(channel)}`,
    );
  }
}

/**
 * Nombre humano normalizado: se recorta y se rechaza lo que un chat no puede
 * pintar (vacío o caracteres de control). El límite de longitud lo valida el
 * schema HTTP; aquí se repite porque el repositorio también se usa desde tests.
 */
function normaliseName(name: string | undefined): string | null {
  if (name === undefined) return null;
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new SessionCatalogueError("BAD_REQUEST", "A session name cannot be blank");
  }
  if (trimmed.length > 120) {
    throw new SessionCatalogueError("BAD_REQUEST", "A session name is too long");
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      "A session name cannot contain control characters",
    );
  }
  return trimmed;
}

/**
 * Forma estructurada que el runtime y este catálogo usan para nombrar un
 * contexto: `agent:<nombre>:<resto>`. El `<nombre>` tiene que ser el Agent
 * dueño del catálogo; enseñar la key de otro Agent sería abrir SU contexto.
 */
const STRUCTURED_KEY = /^agent:([^:]+):/;

/**
 * LA regla de una key, y el único sitio donde vive.
 *
 * La key se convierte en el nombre del directorio con el que el Runner abre la
 * sesión, así que lo que no puede ser un nombre de directorio estable y seguro se
 * rechaza aquí: separadores de ruta, segmentos de traversal, espacios y caracteres
 * de control. Además, una key estructurada `agent:<nombre>:…` solo se acepta si
 * `<nombre>` es ESTE Agent: la key de otro Agent no se puede declarar desde aquí.
 *
 * Las keys legacy arbitrarias que ya existen (UUID de Initiative, nombre simple,
 * `agent:<este Agent>:main`) siguen valiendo: la regla prohíbe la forma, no el
 * contenido. La validación HTTP no repite estas reglas (ver
 * `api-v1/schemas.ts`): una copia en el schema divergiría de esta en el primer
 * cambio y dejaría dos verdades para el mismo invariante.
 */
function normaliseKey(
  key: string | undefined,
  agentName: string,
): string | undefined {
  if (key === undefined) return undefined;
  if (key.trim() === "") {
    throw new SessionCatalogueError("BAD_REQUEST", "A session key cannot be blank");
  }
  if (key.length > 200) {
    throw new SessionCatalogueError("BAD_REQUEST", "A session key is too long");
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(key)) {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      "A session key cannot contain whitespace or control characters",
    );
  }
  if (/[\\/]/.test(key)) {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      "A session key cannot contain path separators",
    );
  }
  if (key === "." || key === "..") {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      "A session key cannot be a traversal segment",
    );
  }
  const owner = STRUCTURED_KEY.exec(key)?.[1];
  if (owner !== undefined && owner !== agentName) {
    throw new SessionCatalogueError(
      "BAD_REQUEST",
      "A session key cannot belong to another Agent",
    );
  }
  return key;
}

export class AgentSessionCatalogue {
  // Campo explícito y no parameter property: `node --test` ejecuta este fichero
  // con strip-only TypeScript, que rechaza el atajo del constructor.
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * Crea (o devuelve, si la key ya existe para ese Agent) una sesión.
   *
   * La idempotencia es por `(agentName, sessionKey)`: el caller legacy que repite
   * `{channel, sessionKey}` obtiene la fila original con su `createdAt` intacto.
   * Sin key se genera una identidad nueva — nunca se reutiliza una key ajena.
   */
  create(input: CreateSessionInput): AgentSession {
    assertAgentName(input.agentName);
    assertSurface(input.channel);
    const name = normaliseName(input.name);
    const requestedKey = normaliseKey(input.sessionKey, input.agentName);

    return this.transaction(() => {
      this.ensureAgentCatalogue(input.agentName, input.now);

      if (requestedKey !== undefined) {
        const existing = this.db
          .prepare(SQL_BY_KEY)
          .get(input.agentName, requestedKey) as RawSession | undefined;
        if (existing) return toSession(existing);
      }

      const id = randomUUID();
      const key = requestedKey ?? generatedSessionKey(input.agentName, id);
      this.db
        .prepare(SQL_INSERT_SESSION)
        .run(input.agentName, id, key, input.channel, name, input.now);

      const created = this.db
        .prepare(SQL_BY_ID)
        .get(input.agentName, id) as RawSession | undefined;
      if (!created) {
        throw new Error(`session catalogue lost row for ${input.agentName}/${id}`);
      }
      return toSession(created);
    });
  }

  /**
   * Catálogo completo de un Agent más la sesión seleccionada en cada superficie.
   *
   * Materializa la entrada legacy y las selecciones por defecto si es la primera
   * lectura de ese Agent (ver cabecera). Es idempotente: leer dos veces no añade
   * filas ni mueve selecciones explícitas.
   */
  list(agentName: string, now: number): SessionCatalogueSnapshot {
    assertAgentName(agentName);

    return this.transaction(() => {
      this.ensureAgentCatalogue(agentName, now);

      const rows = this.db.prepare(SQL_LIST).all(agentName) as RawSession[];
      const selection: SessionSelection = { web: null, telegram: null };
      for (const row of this.db
        .prepare(SQL_LIST_SELECTION)
        .all(agentName) as RawSelection[]) {
        selection[row.channel as SessionSurface] = row.session_id;
      }

      return { sessions: rows.map(toSession), selection };
    });
  }

  /**
   * Selecciona una sesión para UNA superficie. La otra conserva lo que tuviera.
   *
   * Rechaza con `SESSION_NOT_FOUND` un id que no exista en el catálogo de ESTE
   * Agent: el id de otro Agent es, para este, un id inexistente — no se revela su
   * existencia ni se puede seleccionar por accidente. La transacción revierte la
   * adopción legacy si el id no existe, así que un select rechazado no deja rastro.
   */
  select(input: SelectSessionInput): AgentSession {
    assertAgentName(input.agentName);
    assertSurface(input.channel);
    if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
      throw new SessionCatalogueError("SESSION_NOT_FOUND", "Session not found");
    }

    return this.transaction(() => {
      this.ensureAgentCatalogue(input.agentName, input.now);

      const raw = this.db
        .prepare(SQL_BY_ID)
        .get(input.agentName, input.sessionId) as RawSession | undefined;
      if (!raw) {
        throw new SessionCatalogueError("SESSION_NOT_FOUND", "Session not found");
      }

      this.db
        .prepare(SQL_SELECT_SESSION)
        .run(input.agentName, input.channel, input.sessionId, input.now);
      return toSession(raw);
    });
  }

      /**
       * Lee la sesión seleccionada de UNA superficie, lista para abrir un contexto
       * (T5b/2).
       *
       * Contrato, y por qué tiene esta forma:
       * - **Síncrona.** Su caller de producción es el inbound de un canal
       *   (`channels/inbound.ts`), que captura la selección en el instante en que
       *   ACEPTA el mensaje y antes de cualquier `await` de la cola: así un cambio de
       *   selección con el turno siguiente en vuelo no puede reatribuir el pasado.
       * - **Reutiliza los helpers del módulo.** `ensureAgentCatalogue` (adopción legacy
       *   + siembra de la selección por defecto) y `transaction` (una sola
       *   `BEGIN IMMEDIATE`), sin transacciones anidadas ni SQL duplicado: la primera
       *   lectura de un Agent es la misma operación idempotente de siempre.
       * - **Falla CERRADO.** Si la superficie tuviera una selección cuyo id no resuelve
       *   (catálogo corrupto), se lanza `SESSION_NOT_FOUND` en vez de devolver la main:
       *   un puntero roto no puede convertirse en «la conversación de siempre» sin que
       *   nadie se entere.
       */
      getSelectedSession(input: SelectedSessionInput): AgentSession {
        assertAgentName(input.agentName);
        assertSurface(input.channel);

        return this.transaction(() => {
          this.ensureAgentCatalogue(input.agentName, input.now);

          const selection = this.db
            .prepare(SQL_SELECTION_BY_SURFACE)
            .get(input.agentName, input.channel) as RawSelection | undefined;
          const raw = selection
            ? (this.db
                .prepare(SQL_BY_ID)
                .get(input.agentName, selection.session_id) as RawSession | undefined)
            : undefined;
          if (!raw) {
            throw new SessionCatalogueError(
              "SESSION_NOT_FOUND",
              "The session selected on this surface does not exist",
            );
          }
          return toSession(raw);
        });
      }

      /**
       * Punto único de "este Agent ya tiene catálogo": adopta la entrada legacy y
       * siembra la selección por defecto de las dos superficies.
   *
   * Es el helper que TODOS los caminos (create/list/select) reutilizan para que la
   * clave durable, la transaccionalidad y la propiedad por Agent se sostengan en un
   * solo sitio. `INSERT OR IGNORE` + el índice único de key lo hacen idempotente sin
   * leer antes de escribir.
   *
   * Si un caller ya había creado una sesión con la key `agent:<nombre>:main`, la
   * adopción NO la duplica: la fila existente pasa a ser la seleccionada por
   * defecto. Nunca se reescribe su `legacy`.
   */
      private ensureAgentCatalogue(agentName: string, now: number): void {
        const mainKey = mainSessionKeyOf(agentName);
        this.db
          .prepare(SQL_INSERT_LEGACY_MAIN)
          .run(
            agentName,
            LEGACY_MAIN_SESSION_ID,
            mainKey,
            LEGACY_CREATED_AT,
          );

    const main = this.db
      .prepare(SQL_BY_KEY)
      .get(agentName, mainKey) as RawSession | undefined;
    if (!main) {
      throw new Error(
        `session catalogue could not adopt ${mainKey}: the key belongs to another row`,
      );
    }

    for (const surface of SESSION_SURFACES) {
      this.db
        .prepare(SQL_DEFAULT_SELECTION)
        .run(agentName, surface, main.session_id, now);
    }
  }

  /**
   * Borra TODO el catálogo de un Agent: sus sesiones y la selección de cada
   * superficie. Devuelve cuántas sesiones se borraron (`0` = no tenía catálogo,
   * que no es un error).
   *
   * Es la mitad del estado del Agent que `deleteAgent` no alcanza: el directorio se
   * va con un borrado recursivo, las filas de SQLite no. Sin este método, recrear un
   * Agent con el mismo nombre hereda los historiales y la selección de una
   * conversación que ya no existe.
   *
   * La cláusula `WHERE agent_name = ?` es el mismo criterio de propiedad que
   * sostiene el módulo: se borra el catálogo de ESTE Agent, nunca en global. La
   * selección se borra explícitamente antes que las sesiones (aunque la FK la
   * cubra con `ON DELETE CASCADE`) para no depender de que el `PRAGMA
   * foreign_keys` esté activo en la conexión que ejecuta el borrado.
   */
  deleteForAgent(agentName: string): number {
    assertAgentName(agentName);

    return this.transaction(() => {
      this.db.prepare(SQL_DELETE_SELECTION_FOR_AGENT).run(agentName);
      const changes = this.db
        .prepare(SQL_DELETE_SESSIONS_FOR_AGENT)
        .run(agentName).changes;
      return Number(changes);
    });
  }

      /**
       * Una escritura del catálogo es todo-o-nada: la fila nueva, la adopción legacy y
       * la selección por defecto entran juntas o no entra ninguna. `BEGIN IMMEDIATE`
       * toma el lock de escritura antes de leer, así que dos peticiones simultáneas no
       * pueden crear dos filas para la misma key.
       */
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
