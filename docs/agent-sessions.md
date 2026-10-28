# Sesiones de un Agent (catálogo durable)

Esta nota describe el **catálogo durable de sesiones** que el Manager estrena en la
unidad T3 del ODD `odd/tasks/agent-session-workspace.md` (specs S2 y S7). Es el
sustrato de identidad sobre el que se apoyarán la admisión de un único turno
cross-origin (T4), el transcript compartido (T5) y los comandos de sesión de
Telegram (T6); ninguno de esos comportamientos está implementado todavía y este
documento no los promete.

## Modelo

- Un **Agent** tiene N sesiones durables. Una sesión es una conversación con su
  propio contexto en el Runner.
- La identidad durable de una sesión es `(agent, id)`. `id` es opaco para el
  Runner y estable para siempre; `key` es lo que el Runner usa para abrir su
  directorio de sesión.
- Las claves generadas se ven así: `agent:<nombre>:session:<uuid>`. Llevan el
  Agent dentro, igual que la clave del runtime pre-catálogo, así que dos Agents no
  pueden compartir contexto.
- Hay **una selección por superficie**: `web` y `telegram` eligen de forma
  independiente sobre el **mismo** catálogo. Cambiar la sesión de Telegram no
  mueve la de la web y viceversa.

### La key: qué se acepta

La `sessionKey` se convierte en el nombre del directorio con el que el Runner abre
la sesión y en el espacio de nombres del Agent, así que la regla se aplica en el
catálogo (`sessions/catalogue.ts`, `normaliseKey`) y **solo** ahí: el schema HTTP
valida el tipo y delega la forma, para no tener dos verdades que divergan.

Se acepta lo que ya existe:

- un UUID (por ejemplo el de una Initiative);
- un nombre simple, como `main` o `Sesion_de_prueba.v2`;
- una key del **propio** Agent, como `agent:<este nombre>:main`.

Se rechaza (`400 BAD_REQUEST`, sin crear fila): clave vacía, de más de 200
caracteres, con espacios o caracteres de control, con separadores de ruta (`/` o
`\`), un segmento de traversal (`.` o `..`) y cualquier key estructurada
`agent:<otro>:…` que pertenezca a otro Agent. La regla prohíbe la forma, no el
contenido: los callers legacy no cambian.

### La entrada legacy

Antes de este catálogo, web y Telegram compartían una única conversación: la
sesión principal `agent:<nombre>:main`. La primera vez que se toca el catálogo de
un Agent se **adopta** esa sesión tal cual:

- se materializa como entrada con `id: "main"`, `key: "agent:<nombre>:main"` y
  `legacy: true`;
- pasa a ser la selección por defecto de **las dos** superficies;
- su `createdAt` es el epoch (`1970-01-01T00:00:00.000Z`), el marcador
  determinista de «fecha desconocida»: la sesión existía antes que el catálogo y
  no inventamos cuándo nació (ni dependemos del reloj de la primera lectura).

Consecuencias que importan:

- No se mueve, renombra ni borra ningún fichero del Runner: la sesión ya existía
  en disco; el catálogo solo le pone nombre.
- El comportamiento actual (una conversación compartida) sigue siendo el estado
  inicial de todo Agent. Nadie pierde su historial por actualizar.
- **Los UUID históricos del transcript del dashboard no se adoptan.** Son
  identificadores del transcript web, no contextos independientes del Runner;
  importarlos prometería una reanudación que no existe. Su inspección y migración
  pertenecen a T5, y la UI debe seguir tratándolos como historial de solo lectura
  hasta que esa unidad exista.

## API

Todas las rutas viven bajo `/api/v1` y heredan el guard dual (Bearer de servicio o
cookie de panel + CSRF) del router: no hay una puerta de autenticación nueva.

### `POST /agents/:name/sessions`

Crea —o devuelve, si ya existe— una sesión del Agent. `404 AGENT_NOT_FOUND` se
responde **antes** de validar el body, igual que antes: un Agent inexistente no
revela si el payload era válido.

```json
{ "channel": "web", "sessionKey": "clave-estable", "name": "Plan semanal" }
```

Los tres campos son opcionales:

- `channel` (`web` | `telegram`, por defecto `web`) es la superficie de **origen**;
  no restringe desde dónde se puede seleccionar después.
- `sessionKey` es la key legacy aportada por el caller. Si se omite, el Manager
  genera `agent:<nombre>:session:<uuid>`. Su forma se valida en el catálogo (ver
  «La key: qué se acepta»); lo rechazado responde `400 BAD_REQUEST`.
- `name` es la etiqueta humana, 1–120 caracteres, se recorta. Rechaza vacío,
  espacios y caracteres de control.

Responde `201`:

```json
{
  "id": "9f2a…",
  "key": "clave-estable",
  "channel": "web",
  "agent": "agent",
  "name": "Plan semanal",
  "legacy": false,
  "createdAt": "2026-10-28T10:00:00.000Z"
}
```

El contrato legacy documentado en `docs/manager-api-v1.md` §8 sigue vigente: `key`,
`channel`, `agent` y `createdAt` están ahí con el mismo significado. `id`, `name` y
`legacy` son aditivos.

**Crear es idempotente por `(agent, sessionKey)`.** Repetir el mismo `sessionKey`
devuelve la fila original con su `id` y su `createdAt` intactos, no una segunda
sesión para la misma key: dos filas con la misma key serían dos nombres para un
solo contexto. Si el replay cambia `channel`, gana el origen ya registrado.

### `GET /agents/:name/sessions`

Lista el catálogo del Agent y la selección por superficie.

```json
{
  "agent": "agent",
  "sessions": [
    { "id": "main", "key": "agent:agent:main", "channel": "web",
      "agent": "agent", "name": null, "legacy": true,
      "createdAt": "1970-01-01T00:00:00.000Z" }
  ],
  "selection": { "web": "main", "telegram": "main" }
}
```

La entrada legacy aparece primero y no se desplaza al crear sesiones nuevas. La
primera lectura de un Agent **materializa** la entrada legacy y las selecciones por
defecto; es la única escritura que hace un `GET`, es idempotente y está probada
(`test/api-v1-sessions.test.ts`). La alternativa —sintetizar el legado en cada
lectura— impediría seleccionarlo explícitamente por su `id`.

### `POST /agents/:name/sessions/:sessionId/select`

```json
{ "channel": "web" }
```

Cambia la sesión seleccionada **en esa superficie** y devuelve
`{ agent, channel, session }`. La superficie es obligatoria y el body es estricto:
un campo de más se rechaza (`400 BAD_REQUEST`) para que un caller no crea que está
cambiando otra cosa.

- Un `id` que no exista en el catálogo **de este Agent** responde
  `404 SESSION_NOT_FOUND`. El id de otro Agent es, para este, un id inexistente: no
  se revela su existencia ni se puede seleccionar por accidente.
- Seleccionar dos veces la misma sesión es idempotente.
- Seleccionar la entrada legacy por su `id` (`main`) es explícito y no crea filas.

## Invariantes

1. **Propiedad por Agent.** La PK es `(agent, id)` y `session_key` es única por
   Agent. La FK compuesta de la selección impide por esquema que una superficie
   apunte a una sesión de otro Agent.
2. **Todo-o-nada.** Cada escritura (crear, adoptar, seleccionar) ocurre en una
   transacción `BEGIN IMMEDIATE`: o entran la fila, la adopción y la selección, o
   no entra ninguna. Dos peticiones simultáneas no pueden crear dos filas para la
   misma key ni dejar la selección apuntando a una fila inexistente.
3. **Sin catálogo no hay promesa.** Si el composition root no compuso almacén
   durable, las tres rutas responden `503 RESOURCE_UNAVAILABLE` en vez de inventar
   un catálogo en memoria que mentiría sobre su persistencia.
4. **Un solo handle.** El catálogo se construye una vez por base abierta
   (`openManagerStore`) y se cierra con el store. Nunca se abre por request.
5. **Una key es un nombre de directorio.** La forma de la key se decide en el
   catálogo (`normaliseKey`): sin separadores, sin traversal, sin control y sin el
   namespace de otro Agent. El schema HTTP no la repite.
6. **Un Agent borrado no tiene catálogo.** La purga es por Agent y es parte del
   contrato del borrado: si falla, el Agent no se borra.

## Borrar un Agent

`DELETE /agents/:name` purga el catálogo de **ese** Agent — sus sesiones y la
selección de las dos superficies — antes de borrar su directorio. Sin esto, el
estado de SQLite sobrevivía al `rm -rf` del directorio y un Agent recreado con el
mismo nombre heredaba historiales y selección de una conversación que ya no
existe.

La semántica de fallo es explícita y distinta a la de los canales, que es
best-effort: si el catálogo no se puede purgar, el borrado responde
`500 INTERNAL_ERROR` y **el Agent sigue existiendo**, para que el caller reintente.
Un Agent a medias dejaría el historial anterior disponible para el siguiente que
reutilice el nombre; purgar después de borrar el directorio respondería 500 sobre
un Agent que ya no está.

## Lo que esta unidad NO hace

- No bloquea sesiones concurrentes ni admite un único turno cross-origin (T4).
- No persiste ni sirve el transcript completo (T5).
- No expone comandos `/new`, `/sessions`, `/session` en Telegram (T6).
- No reanuda el contexto del Runner tras un reinicio por sí mismo: la continuidad
  del `sessionKey` es del Runner, que ya guarda su directorio por clave. Este
  catálogo solo garantiza que la identidad y la selección sobrevivan.
- No toca los ficheros del Runner ni reescribe la identidad del transcript: adoptar
  el legacy es nombrar lo que ya estaba en disco, y los UUID históricos del
  dashboard siguen sin adoptarse (T5).
