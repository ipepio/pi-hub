# Sesiones de un Agent (catálogo durable)

Esta nota describe el **catálogo durable de sesiones** que el Manager estrena en la
unidad T3 del ODD `odd/tasks/agent-session-workspace.md` (specs S2 y S7), la
**admisión de un único turno por Agent** de la unidad T4a, la **política de
persistencia del transcript** de la unidad T5a y los **comandos de texto de Telegram**
de la unidad T6a (`/new`, `/sessions`, `/session`, `/stop`). La migración/UI de
sesiones del dashboard (T5b restante) sigue pendiente, y este documento no la promete.

La política de transcript tiene su propia sección (`## Transcript persistence
policy (T5a)`): léela antes de tocar `channel_exchanges` o de prometer «historial
completo» en una superficie.

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

## Admisión: un turno por Agent (T4a)

S2 exige «at most one executing turn across web, Telegram and autonomy». La regla
vive en **un solo sitio**, `TurnExecution.startTurn` (`agenda/turn-execution.ts`),
que es el puente compartido por la ruta HTTP `POST /agents/:name/turns`, el
inbound de canales y el Loop de autonomía:

- la comprobación y la reserva son **síncronas** y ocurren **antes** de crear el
  socket contra el Runner: dos peticiones en el mismo tick no pueden colarse entre
  «mirar» y «abrir», y un turno rechazado no deja ningún WS abierto;
- un segundo turno del **mismo** Agent se rechaza con el `DomainError`
  `TURN_IN_PROGRESS`, que la frontera HTTP traduce al código cerrado del catálogo:
  `409 TURN_IN_PROGRESS`. En `POST /api/v1/agents/:name/turns` la respuesta es
  **JSON y sale antes de abrir el SSE**, así que un rechazo nunca se disfraza de
  `200` con un stream que no ejecuta nada;
- no se mira el `sessionKey` ni el origen: el turno de una sesión B del mismo
  Agent mientras la sesión A ejecuta también se rechaza. Agents **distintos**
  siguen ejecutando en paralelo;
- la admisión se libera **solo** por el terminal existente (`turn-complete`,
  `turn-aborted`, `turn-error`) o por la pausa humana durable. `POST
  …/turns/:turnId/abort` **no** la libera: el abort marca el turno y el Agent
  sigue ocupado hasta que el Runner cierra. Tampoco la libera que el cliente
  HTTP/SSE se vaya: `disconnect()` **pide el mismo abort** contra el Runner y el
  turno conserva su sitio en la admisión hasta el terminal real, que es lo único
  que libera. Ese corte no publica ningún terminal propio, y el sink de ese
  cliente queda anulado, así que el terminal posterior no se entrega a un stream
  que ya no existe (se escribe igual en el repositorio durable);
- la `idempotencyKey` se recuerda **solo** cuando el turno fue aceptado. Una
  petición rechazada por ocupado no queda envenenada — el mismo caller puede
  reintentar con la misma key cuando el Agent quede libre — y un replay de un
  turno ya aceptado sigue devolviendo `{turnId, duplicate:true}` sin ejecutar
  (spec §5).

## Qué hace cada origen no HTTP cuando su turno es rechazado (T4b)

La admisión es del `TurnExecution`; la **política** del origen que se queda fuera
es de cada origen, y estas son las dos que existen:

- **Inbound de canales** (`channels/inbound.ts`). Un mensaje de un chat enlazado
  cuyo turno se rechaza por ocupado **no se ejecuta** y **no se queda en la cola**
  para ejecutarse por sorpresa después: se descarta, se registra en el log y el
  usuario recibe por el mismo outbox —con la misma política de reintento que el
  resto de mensajes de sistema— un aviso del catálogo `channels/labels.ts` que
  dice que el mensaje no se ha ejecutado y que puede volver a enviarlo cuando el
  turno en curso termine. Nunca se abre un segundo turno ni se simula una
  respuesta del modelo. El aviso va **solo** al chat enlazado: el emparejamiento
  se resuelve antes, así que un remitente ajeno no recibe nada.
  El drenado consume **todos** sus rechazos (resolver, cola u outbox): cada fallo
  se registra y el drenado sigue con el mensaje siguiente de esa cola, sin dejar
  promesas rechazadas sin consumidor y sin perder el drenado futuro. Un outbox
  caído no tumba el proceso.
- **Loop de autonomía** (`agenda/loop.ts`). Antes de reclamar, el Loop consulta la
  MISMA autoridad (`TurnExecution.hasLiveTurnForAgent`) de forma síncrona y sin
  ningún `await` entre la lectura, el claim y `startTurn`. Si el Agent tiene un
  turno vivo —humano, de canal o de otra Initiative— su Initiative sigue
  `queued`: no se reclama ningún turno, no se marca `failed` y no se quema nada.
  El Agent ocupado no gasta el slot del dial, así que otro Agent inactivo arranca
  en el mismo tick; cuando el turno ajeno termina, el `tick` periódico reevalúa y
  la despacha. La matriz `errored`/`stopped` y el round-robin entre Agents no
  cambian.

Lo que sigue abierto en **T4c**, y este documento no promete todavía: la
reconciliación tras un reinicio del Manager (su registro de turnos vivos es en
memoria, así que un Manager recién arrancado podría admitir un segundo turno
contra un Runner que sigue ejecutando — el Runner ya lo rechaza, ver abajo, pero
el Manager aún no lo presenta como `409`) y la parte del fencing del Supervisor
que no es el puerto. La semántica de `disconnect()` **sí** está hecha (pide abort
y no libera, ver arriba) y el arranque del Supervisor ya está fenced contra un
puerto ocupado (ver la sección siguiente).

    ## Comandos de texto de Telegram (T6a)

    Un mensaje del **chat enlazado** que empieza por `/` es un **comando**, no un
    prompt. Los comandos viven en `channels/inbound.ts` y su copy en el catálogo de
    labels (`channels/labels.ts`): ni una sola frase visible está escrita en el
    handler.

    | Comando | Qué hace |
    | --- | --- |
    | `/new [nombre]` | Crea una sesión del Agent y la **selecciona** en la superficie del canal. |
    | `/sessions` | Lista las sesiones (máximo **10**, con `id` y marca de la seleccionada). |
    | `/session` | Dice la sesión que este chat está usando y si el Agent está ocupado. |
    | `/session <nombre o id>` | Selecciona esa sesión **para este chat**. |
    | `/stop` | Pide abortar el turno vivo del Agent; sin turno vivo contesta que no hay nada en marcha. |
    | cualquier otra cosa | «No conozco el comando» con la lista de comandos disponibles. |

    Reglas que sostiene la unidad, y por qué:

    1. **Después del binding, antes del turno.** Un chat **no enlazado** recibe el flujo
       de emparejamiento de siempre (código o auto-pair) y **nunca** un comando: el
       catálogo no se toca desde un chat que aún no es del Agent.
    2. **Un comando no gasta el turno del Agent.** No entra en la cola FIFO ni llama a
       `startTurn`; contesta como mensaje de **sistema** por el outbox. Consecuencia
       deliberada: crear, listar, seleccionar y abortar funcionan **con el Agent
       ocupado**, que es exactamente cuando el humano los necesita.
    3. **La selección es la misma del catálogo y de una sola superficie.** `/new` y
       `/session` mueven la selección de `telegram` y **no** la de `web` (S3). El
       mensaje siguiente corre en la sesión recién elegida porque el inbound la lee al
       **aceptar** el mensaje, no al despachar el turno.
    4. **Resolución del argumento de `/session`:** primero el `id` (opaco, sin
       ambigüedad), después el **nombre exacto**. Un nombre inexistente —o repetido— no
       selecciona nada: adivinar «la primera» sería elegir por el humano.
    5. **La lista está acotada a 10** con el recuento `10 de N`: un catálogo puede
       crecer sin límite y un chat no es un dashboard.
    6. **Un catálogo caído no deja al humano sin respuesta:** el fallo se registra y se
       contesta «no he podido ejecutar», nunca se abre un turno por accidente.
    7. **Sin comandos inyectados, `/` es texto normal.** La composición inyecta
       `sessionCommands` (el adaptador real es `catalogueSessionCommands`, en
       `channels/inbound.ts`); una composición que no lo inyecte conserva el camino
       histórico, y por eso los tests anteriores a esta unidad no cambian.

    `/stop` aborta el turno **vivo del Agent** (de cualquier origen), y solo puede
    llegar aquí el chat enlazado: la comprobación de propiedad ya ocurrió. La costura es
    `abortIfLive(agentName)`, inyectada por la composición sobre
    `TurnExecution.liveTurnIdForAgent` + `abort` — la misma autoridad de admisión que
    rechaza un segundo turno.

    Los comandos (`channels/inbound.ts`), su adaptador y la inyección en la composición
    (`channels/composition.ts`) son de esta unidad y van en el mismo commit.

    ## Defensa del Runner: una ejecución por proceso (T4c, parcial)

La admisión del Manager es en memoria: si el Manager se reinicia, o si su propio
proceso pierde la conexión, el Manager puede creer que el Agent está libre
mientras el Runner sigue ejecutando. Por eso la defensa **autoritativa**
vive también en el proceso que tiene la `AgentSession`, y ya está implementada:

- **Una gate por Runner** (`packages/runner/src/execution-gate.ts`), compartida
  por el hub por defecto y todos los hubs keyed (`SessionHubRegistry` se la
  adjunta a cada `ChatHub`, incluido el que construye el arranque). No es un
  singleton global: dos Agents en procesos distintos no se ven.
- **Admisión síncrona antes del primer `await`**, es decir antes de crear la
  `AgentSession`: dos prompts del mismo tick no pueden colarse entre «mirar» y
  «crear». La gate se mantiene hasta que la promesa del `prompt` del SDK se
  asienta, que en el SDK instalado (0.80.3) ocurre **después** de `agent_end`
  (`_runAgentPrompt` → `agent.finishRun`).
- **Sin cola**: un segundo prompt se rechaza con `ExecutionBusyError`
  (`code: "TURN_IN_PROGRESS"`, código de protocolo interno). No se encola como
  `followUp` del SDK, porque se ejecutaría más tarde sin que nadie lo pidiera.
- **El error del rechazo va solo al socket que lo pidió.** El borde WS nunca
  difunde el rechazo al hub del turno activo: un `error` ahí se leería como un
  terminal falso. Una promesa rechazada sin consumidor tumbaría el Runner, así
  que `prompt`, `abort`, `new_session` y `set_model` siempre tienen consumidor.
- **El abort no libera la admisión**: lo hace el asentamiento real del SDK. Una
  petición de abort, un cliente que se desconecta o un observador que se va no
  pueden soltar la ejecución de otra generación.
- **`new_session`, `reset()` y `set_model` no tocan una generación en curso**:
  `new_session`/`set_model` se rechazan mientras el turno corre (la ruta HTTP
  `POST /api/session/new` responde con el error del hub) y `reset()` —que también
  usan la recarga de recursos y el apagado— se ignora en silencio con log en vez
  de descartar la sesión que ejecuta.

    Lo que esta defensa **no** hace todavía: reconciliar el estado del Manager tras
    su reinicio, preservar el turno cuando el Manager pide `abort`, ni aplicar un
    protocolo de propiedad del puerto entre procesos. T4c no está terminado.

    ## Fencing del arranque del Supervisor (T4c, parcial)

    Antes de abrir el log del Runner y de spawnearlo, el Supervisor comprueba que el
    puerto del Agent **se pueda atar en exclusiva**. Es un fence *fail-closed*: si el
    puerto ya está ocupado, ese arranque no ocurre. La decisión es **rechazar**, no
    adoptar ni reclamar: no se habla con el ocupante, no se asume que sea un Runner
    de un Manager anterior ni se le manda ninguna señal.

    - **Dónde vive.** En el camino común `spawnRunner` (`supervisor.ts`), no en
      `start`: así quedan fenced el arranque inicial (`startAll`/`start`) y también el
      **auto-reinicio** tras una salida inesperada.
    - **Cómo se mide.** Un `net.createServer().listen({ host, port, exclusive: true })`
      sobre la MISMA dirección que ata el Runner real (`0.0.0.0`), cerrado antes del
      spawn y acotado a 5 s. La dirección importa: en Darwin un socket que escucha en
      `127.0.0.1:P` no impide atar `0.0.0.0:P` (y al revés), así que sondear otra
      dirección daría falsos «libre» en esta máquina. `EADDRINUSE` produce un error
      explícito y cualquier otro fallo de bind (permisos, dirección no disponible)
      también rechaza: no se arranca `a ciegas`.
    - **Qué ve el usuario.** `start()` rechaza, el Agent queda `stopped` (nunca
      «en marcha») y `runnerPortOf()` devuelve `undefined`, así que el panel no
      pinta un Runner que no existe. Ni siquiera se abre `runner.log` ni se emite la
      credencial de callback del spawn.
    - **Auto-reinicio.** El rechazo del fence durante un auto-reinicio se consume y se
      registra dentro de `supervisor.ts`: sin ese consumidor sería un
      `unhandledRejection` que tumbaría el Manager entero. El Agent sigue `stopped` y
      el fallo queda en el log; el arranque inicial, en cambio, sí ve el error.
    - **Idempotencia.** Si el Supervisor ya tiene un hijo vivo de ese Agent, `start()`
      devuelve sin sondear nada.

    Lo que este fence **no** hace y no se debe leer como si lo hiciera: no cierra la
    ventana entre el sondeo y el bind del Runner (TOCTOU), no prueba propiedad del
    puerto y no implementa ningún protocolo de traspaso. La garantía de una sola
    ejecución por Agent sigue siendo la gate del Runner. Consecuencia operativa: si
    quedó un Runner huérfano (por ejemplo, un proceso suelto de un Manager anterior)
    el Supervisor **se niega** a arrancar ese Agent hasta que el puerto quede libre;
    entonces basta con arrancar/`restart` del Agent, y si no queda libre porque el
    Manager entero conserva estado viejo, un reinicio completo del runtime.

## Transcript persistence policy (T5a)

Decisión del usuario, verbatim: **«si, y recuerda documentar todo bien»**. Se concreta
en tres reglas, y las tres se pueden comprobar en código.

### 1. Quién es el dueño del transcript

- El transcript **autoritativo y durable es del runtime**, por `sessionKey`: es el
  directorio de sesión que el Runner ya guarda en disco y el contexto que reanuda un
  turno nuevo. El Manager no lo reescribe y **no lo reconstruye** a partir de ningún
  espejo.
- El **Manager** produce los intercambios que ocurren fuera de la web (Telegram,
  Initiative) y los persiste como hechos ocurridos. No hay dirección de confianza
  P→D: el Dashboard los drena.
- El **Dashboard es capa de presentación** de esos hechos. Su transcript propio es su
  registro de lo que retransmitió (ADR 0100 del dashboard: guarda cada turno mientras
  lo emite, y deliberadamente no le pide historial a pihub). Ni el Manager escribe el
  transcript del dashboard ni el dashboard reconstruye el contexto del Runner.
- Consecuencia que no hay que perder de vista: **reanudar contexto** es del Runner
  (misma `sessionKey`); que el dashboard muestre el historial **no** reanuda nada.

### 2. Qué guarda el espejo `channel_exchanges`

Migraciones v6 y v7 (aditivas, `packages/manager/src/storage/migrations.ts`):

| columna           | desde | contenido                                                        |
|-------------------|-------|------------------------------------------------------------------|
| `user_text`       | v4    | mitad del humano, **semántica intacta** (completa, sin recortes)   |
| `reply_text`      | v4    | mitad del Agent, **semántica intacta**                            |
| `user_full_text`  | v6    | mitad del humano acotada al techo documentado; NULL si es legacy  |
| `reply_full_text` | v6    | mitad del Agent acotada al techo documentado; NULL si es legacy   |
| `session_key`     | v7    | key de la sesión en la que corrió el turno; NULL si es legacy     |

Reglas del escritor (`channels/exchange-log.ts`):

- Toda fila **nueva** escribe las dos mitades full, también cuando una mitad es
  vacía (un turno proactivo no tiene texto del humano: `""` es una mitad real).
- El techo es `CHANNEL_FULL_TEXT_MAX_CHARS = 32_768` caracteres por mitad. Es un
  **máximo duro documentado**, no un preview: hasta 32.768 el texto se guarda
  literal. Por encima, la columna full guarda el **prefijo** de ese tamaño (un
  `slice`, nunca una redacción ni un resumen) y `hasFull` sigue siendo `true`
  porque el contrato define «completo» **hasta ese techo explícito**. El motivo del
  techo es de forma, no de contenido: una fila no puede deshacer el acotado de
  página del feed (`EXCHANGE_FEED_MAX_LIMIT`) ella sola.
- **El recorte de preview no es del Manager.** El Manager nunca recortó al escribir;
  el preview acotado es del Dashboard (`TEXT_PREVIEW_MAX_CHARS = 512` en
  `packages/control-plane/src/agents/sync-channel-transcript.ts`, que compone
  `userText → replyText` y recorta). Repartir el recorte entre las dos partes sería
  tener dos dueños del mismo hecho; el dueño es D.
- Un **replay** (mismo `turn_id`, hook de entrega at-least-once) no duplica ni
  reescribe: `INSERT OR IGNORE` y se devuelve la fila que ya estaba.
- No hay redacción nueva. Las dos columnas guardan lo que el humano escribió y lo que
  el Agent respondió, igual que v4 documenta. La redacción de tokens existente vive
  en otra parte y **no cambia**: solo afecta a líneas de log de arranque de canal
  (`channels/registry.ts`, `describeStartFailure`), no al espejo.

### 3. Filas legacy: historia READ-ONLY

Lo que existía antes de v6 son filas de sesiones locales **antiguas** cuya identidad
no correspondía a un contexto independiente del Runner. El usuario decidió que son
**historia honesta e inmutable**: se muestran, no se reescriben y no prometen
reanudación. Ver ADR 0107 del dashboard
(`goguest-ai-dashboard-new/docs/adr/0107-keep-legacy-agent-sessions-read-only.md`).

En el Manager eso significa, literalmente:

- la migración **no hace backfill**: las columnas full quedan `NULL` para siempre;
- `hasFull` es `false`, así que el feed dice la verdad sobre lo que no tiene en vez de
  rellenar el hueco con el preview;
- ninguna ruta ni escritura puede convertir una fila legacy en una fila con
  transcripción completa: el único escritor es `append` y su `INSERT OR IGNORE` no
  toca una fila existente.

    La contrapartida, que es la mitad útil de la decisión: las **sesiones nuevas** sí son
    reanudables, y su historial completo está disponible en las dos superficies a través
    del mismo feed.

    ### 4. Identidad de la sesión de cada intercambio (T5b/2)

    Hasta la v7 el espejo respondía «qué se dijo» pero no «en qué sesión». La migración
    **v7** es aditiva y sin backfill: `channel_exchanges.session_key TEXT` NULLable. El
    Dashboard ya podía mostrar historial y distinguir completo/preview; ahora puede
    **atribuir** cada intercambio a una sesión de su Agent.

    - **El valor es el del turno, no el de la selección de ahora.** `CompletedTurn` lleva
      `sessionKey` — la MISMA key con la que `startTurn` abrió el contexto del Runner — y
      `channels/delivery-router.ts` la escribe tal cual. Ningún punto de la entrega
      consulta el catálogo: leer la selección al entregar atribuiría el pasado con el
      puntero de hoy, que es exactamente lo que esta unidad evita.
    - **Un mensaje entrante captura su sesión al ACEPTARSE.** `channels/inbound.ts` resuelve
      `sessionKeyFor` cuando el mensaje entra en la cola (antes de cualquier `await` del
      drenado), así que cambiar la selección de Telegram con el turno anterior en vuelo
      no reatribuye ni ese turno ni los mensajes ya encolados; el siguiente mensaje sí usa
      la selección nueva. Una `A` capturada se despacha y se refleja como `A` aunque el
      humano elija `B` a mitad de turno.
    - **La selección es por Agent y por superficie.** `AgentSessionCatalogue.getSelectedSession`
      es la lectura estrecha de T5b/2: síncrona, en UNA transacción, reutilizando
      `ensureAgentCatalogue` (adopción legacy + siembra por defecto). Web y Telegram tienen
      punteros independientes y la selección de un Agent no influye en la de otro.
    - **Fail-closed.** Si la selección de la superficie apuntara a una sesión que no existe,
      el inbound **descarta** el mensaje con una línea de log: nunca cae a
      `agent:<nombre>:main`. La main solo se usa cuando el catálogo la adoptó de verdad
      (primera lectura del Agent, `legacy: true`), que es el comportamiento histórico.
    - **NULL es «desconocido», no `main`.** Toda fila anterior a v7 queda con
      `session_key NULL`, y el feed la publica como `sessionKey: null`: el consumidor debe
      agruparla como «sin atribuir» en vez de adivinar. Lo mismo para una entrega que no
      viene de un turno (tarjeta `waiting_human`, proactive interno): ahí no hay identidad
      que atribuir.
    - **La key viaja verbatim, aunque no esté en el catálogo.** Un turno de Initiative con
      `agent:<nombre>:initiative:<id>` se refleja con esa key y el catálogo **no** adopta
      una fila nueva por ello: el espejo informa lo que ocurrió, no inventa identidad.
    - **Compatibilidad.** `CompletedTurn.sessionKey` es OPCIONAL en el tipo para no romper
      fixtures/helpers anteriores; `TurnExecution` la adjunta siempre. `AppendExchangeInput`
      acepta la key opcional y la escribe como `null` cuando no la tiene: el techo de
      32.768, `hasFull` y `INSERT OR IGNORE` no cambian (un replay no reescribe la
      atribución de la fila original).

## Lo que esta unidad NO hace

- No persiste ni sirve el transcript completo de una fila **legacy**: T5a entrega el
  historial completo solo para filas nuevas; lo anterior es preview-only por decisión
  del usuario (ADR 0107). Tampoco trae la migración/API/UI del dashboard (T5b).
- No atribuye el pasado: las filas anteriores a v7 quedan `sessionKey: null` para
  siempre. T5b/2 publica la identidad de aquí en adelante, no reescribe historia.
- No trae el lado del dashboard: el cliente interno todavía no declara `sessionKey` en
  su tipo de fila ni lo usa para pintar historial por sesión, y no hay DB, ruta propia
  ni UI de sesiones en D. Esas unidades siguen pendientes (T5b restante).
    - No expone la **UI ni la migración** de sesiones del dashboard (T5b restante). Los
      comandos de texto de Telegram (`/new`, `/sessions`, `/session`, `/stop`) sí están
      aquí (T6a), y `/stop` no puede abortar todavía un turno **web** porque
      `TurnExecution` no publica el `turnId` vivo por Agent: la costura `abortIfLive`
      espera esa pieza.
- No reanuda el contexto del Runner tras un reinicio por sí mismo: la continuidad
  del `sessionKey` es del Runner, que ya guarda su directorio por clave. Este
  catálogo solo garantiza que la identidad y la selección sobrevivan.
- No toca los ficheros del Runner ni reescribe la identidad del transcript: adoptar
  el legacy es nombrar lo que ya estaba en disco, y los UUID históricos del
  dashboard siguen sin adoptarse (T5).

## Estado final de la feature (T9, 2026-10-29)

Lo entregado en esta rama (`feat/agent-session-workspace`, commits locales):

- T3 `568963c` — catálogo durable, selección por superficie, adopción legacy, API `/api/v1`.
- T4 (acotado) `cd90c6c` — un turno por Agent: 409 `TURN_IN_PROGRESS` antes del SSE,
  política por origen (Telegram avisa vía outbox, Autonomía queda `queued`), gate de
  ejecución en el Runner, `disconnect()` no termina el turno, fence de arranque del
  Supervisor. No entregado a propósito: recuperación de huérfanos post-restart y 409
  durable (el registro de turnos vivos sigue en memoria; fallback: reinicio del Agent
  o del runtime completo).
- T5a `34cdc87` / T5b/2 `232dcfd` — transcript completo en filas nuevas (v6) e
  identidad de sesión del turno al espejo (v7). Legacy: READ-ONLY para siempre.
- T6a `f66426f` — comandos Telegram `/new` `/sessions` `/session` `/stop`, copy vía
  `channels/labels.ts`, nunca gastan el slot de admisión. T6b (botones inline
  `callback_query`) sigue pendiente.
- T7/3 `abc7af3` — el panel del Manager adopta el catálogo como única fuente de la
  identidad de sesión del turno: crea, lista y selecciona sesiones; adopta la key de
  la sesión seleccionada en web; sin catálogo o sin selección el turno se bloquea
  fail-closed (nunca inventa una key local). La key no se muestra en la UI.
- T8 `17391a5` — `docs/pi-mcp-adapter-compatibility.md`: veredicto NO instalar
  pi-mcp-adapter por defecto con el SDK 0.80.3 (peer range incompatible + política
  invertida + herencia de env). Camino condicional documentado allí.

Verificación T9: suite raíz completa **1025/1025** (0 fail, 0 cancelados), typecheck
de todos los workspaces exit 0. El par dashboard (goguest-ai-dashboard-new) refleja
el estado completo en `docs/agent-session-integration.md` §10 y en el tracker ODD
`odd/tasks/agent-session-workspace.md`.
