# Fase 1 — definición del esquema SQLite del Manager

**Estado:** definición para revisión; no es una migración ejecutable ni código de producción.

## 0. Alcance y restricciones heredadas

SQLite es el almacén ya decidido para la Agenda y el estado terminal de turnos; no se redefine aquí esa elección. El alcance tampoco es un log de eventos de turno: los eventos SSE siguen siendo transporte efímero. Hoy el Manager conserva la idempotencia en un `Map` por instancia (`packages/manager/src/api-v1/routes.ts:107-108`), registra la key antes de abrir el WebSocket (`packages/manager/src/api-v1/routes.ts:968-976`) y pierde o expulsa entradas al reiniciar o al superar 10.000 (`packages/manager/src/api-v1/turns.ts:1-14,16-29`). El esquema debe reemplazar esa reserva de idempotencia, no solo guardar el resultado después de terminar.

El vocabulario de estados es cerrado y exacto:

`queued` · `running` · `waiting_human` · `waiting_agent` · `succeeded` · `failed` · `expired` · `cancelled`.

Una Initiative nace de un Trigger, de un Callback o de input humano. Una Initiative autónoma usa el mismo camino de turno existente, que ya recibe una `sessionKey` (`packages/manager/src/api-v1/routes.ts:947-966`) y la pasa al Runner (`packages/manager/src/api-v1/routes.ts:983-990`). No se define un segundo protocolo.

### Convenciones físicas

- Identificadores: `TEXT`, opacos y estables; este documento no fija UUID frente a otro generador.
- Fechas: `INTEGER`, milisegundos UTC desde epoch. Evita depender de normalización textual y mantiene orden numérico para las consultas por fecha.
- Booleanos: `INTEGER NOT NULL CHECK (valor IN (0,1))`.
- JSON: `TEXT`; el repositorio valida y serializa una forma versionada antes de escribir. La forma concreta de los payloads marcados como pendientes no se decide aquí.
- Todas las conexiones activan `PRAGMA foreign_keys = ON`.
- No hay foreign key hacia `AgentConfig`: hoy un Agent se persiste como `/data/agents/<name>/agent.json`, no como fila SQLite (`packages/shared/src/types.ts:13-27`). `agent_name` conserva el nombre de dominio del Agent y la integridad con el registro de Agents se valida en el repositorio.

## 1. Esquema lógico

### 1.1 `triggers`

Un Trigger es la condición determinista y estructurada que dispara una Initiative. La v1 solo ejecuta `schedule`, pero `kind` no lleva un `CHECK` que cierre el catálogo: así una clase futura es aditiva en datos y contrato.

| Columna | Tipo | Clave / nulabilidad | Significado de dominio |
|---|---|---|---|
| `id` | `TEXT` | **PK**, `NOT NULL` | Identidad estable del Trigger. |
| `agent_name` | `TEXT` | `NOT NULL` | Agent cuya Agenda recibirá la Initiative cuando se dispare. |
| `kind` | `TEXT` | `NOT NULL` | Tipo estructural del Trigger. La aplicación v1 acepta únicamente `schedule`; el almacenamiento no impide tipos futuros. |
| `definition_json` | `TEXT` | `NOT NULL` | Definición determinista del Trigger. Para `schedule`, contiene el schedule estructurado. **Pendiente:** forma y versionado del schedule (zona horaria, recurrencia y tratamiento de saltos horarios). |
| `intent` | `TEXT` | `NOT NULL` | Intent que se interpretará cuando el Trigger dispare una Initiative. |
| `mode` | `TEXT` | `NOT NULL`, `CHECK (mode IN ('solo','ask'))` | Modo por defecto declarado por el Intent. |
| `suggested_skill` | `TEXT` | `NULL` | Skill sugerida por el Trigger; el Agent decide si la usa. |
| `created_by` | `TEXT` | `NOT NULL`, `CHECK (created_by IN ('owner','control_plane','agent'))` | Autoría: quién creó el Trigger. El dueño humano del Agent, el control plane por `/api/v1`, o el propio Agent. `agent` no crea: introduce una propuesta pendiente de aprobación. |
| `authority` | `TEXT` | `NOT NULL`, `CHECK (authority IN ('owner','control_plane'))` | Ámbito o autoridad: quién tiene la autoridad de creación, edición y revocación del Trigger. En modo gobernado es `control_plane` — puede revocar incluso los creados localmente porque en ese modo es la autoridad —; en modo no gobernado es `owner`. |
| `proposal_state` | `TEXT` | `NULL`, `CHECK (proposal_state IN ('proposed','approved'))` | Estado de propuesta. `NULL` cuando `created_by` es `owner` o `control_plane` (el Trigger nace activo); `proposed` cuando el Agent lo propone y queda pendiente de aprobación del humano por el Primary Channel; `approved` cuando esa aprobación llega. |
| `enabled` | `INTEGER` | `NOT NULL`, booleano | Si el Trigger puede dispararse. Deshabilitarlo conserva su definición y evita nuevos disparos; es ortogonal a `proposal_state`. |
| `next_fire_at` | `INTEGER` | `NULL` | Próxima fecha calculada de disparo. `NULL` significa que no hay un vencimiento programado (por ejemplo, Trigger deshabilitado). |
| `last_fired_at` | `INTEGER` | `NULL` | Fecha del último disparo completado por el Loop; no es historial de todos los disparos. |
| `created_at` | `INTEGER` | `NOT NULL` | Fecha de creación del Trigger. |
| `updated_at` | `INTEGER` | `NOT NULL` | Fecha de su última modificación declarativa o de planificación. |

Comprobación a nivel de fila en la propia tabla:

- `CHECK ((created_by='agent' AND proposal_state IS NOT NULL) OR (created_by IN ('owner','control_plane') AND proposal_state IS NULL))`: la propuesta del Agent nunca nace activa, y el dueño o el control plane nunca crean un Trigger pendiente de aprobación.

La autoridad de creación, edición y revocación de Triggers queda fijada: el **dueño humano** del Agent, y en modo **gobernado** también el **control plane** por `/api/v1`, que puede revocar los creados localmente porque en ese modo es la autoridad. El propio **Agent no puede crear** Triggers; solo puede **proponerlos**, y quedan pendientes de aprobación del humano por el Primary Channel. Esa asimetría es deliberada: el ADR `0005` prohíbe el auto-encolado libre para que un Agent no se realimente solo, y si pudiera crear sus propios Triggers se auto-encolaría con un paso extra.

`proposal_state` es una columna separada de `enabled` a propósito: una propuesta pendiente de aprobación no es lo mismo que un Trigger deshabilitado. Si se mezclaran, un Trigger que el humano nunca aprobó parecería uno que apagó a propósito, y su aprobación sería indistinguible de una re-habilitación. Un Trigger `proposal_state='proposed'` no se dispara: el repositorio no planifica su `next_fire_at`, y el índice parcial de la sección 2 solo recoge los que vencen.

Sigue pendiente únicamente la **forma del campo de Triggers en `AgentConfig`** (`packages/shared/src/types.ts:13-27`): hoy esa interfaz no contiene Triggers.

### 1.2 `initiatives`

Esta es la Agenda durable. Una fila es una Initiative y contiene todo lo necesario para localizarla, despacharla o reanudarla sin inferir su origen desde el texto o desde la `sessionKey`.

| Columna | Tipo | Clave / nulabilidad | Significado de dominio |
|---|---|---|---|
| `id` | `TEXT` | **PK**, `NOT NULL` | Identidad estable de la Initiative. |
| `agent_name` | `TEXT` | `NOT NULL` | Agent dueño de la Agenda donde vive y que la ejecuta. |
| `state` | `TEXT` | `NOT NULL`, `CHECK (state IN ('queued','running','waiting_human','waiting_agent','succeeded','failed','expired','cancelled'))` | Initiative State exacto: `queued`, `running`, `waiting_human`, `waiting_agent`, `succeeded`, `failed`, `expired` o `cancelled`. |
| `origin` | `TEXT` | `NOT NULL`, `CHECK (origin IN ('trigger','callback','human'))` | Origen explícito de la Initiative: Trigger, Callback o input humano transferido. Es el origen autónomo que viajará por el camino de turnos. |
| `trigger_id` | `TEXT` | `NULL`, **FK** → `triggers(id)` | Trigger originador cuando `origin='trigger'`; `NULL` en los otros orígenes. La FK usa `ON DELETE RESTRICT` para no borrar la explicación de una Initiative existente. |
| `intent` | `TEXT` | `NOT NULL` | Intent que el Agent interpreta al ejecutar. En una reanudación por Callback conserva la continuación de la Initiative originadora. |
| `mode` | `TEXT` | `NOT NULL`, `CHECK (mode IN ('solo','ask'))` | Modo efectivo de la Initiative. Solo puede escalar de `solo` a `ask`; esa transición la valida el repositorio. |
| `session_key` | `TEXT` | `NOT NULL` | `sessionKey` aislada propia de la Initiative frente a los Channels humanos. En una entrega de Callback se usa la de la Initiative `parent` para reanudar su misma sesión. |
| `available_at` | `INTEGER` | `NOT NULL` | Fecha a partir de la cual el Loop puede despacharla. Es la fecha de la consulta caliente de la Agenda. |
| `bound_model` | `TEXT` | `NULL` | Model fijado en el primer despacho, si se acepta la calibración de binding. Permanece en reanudaciones. |
| `turn_id` | `TEXT` | `NULL` | Último turno usado para ejecutar o reanudar esta Initiative. No es el historial de turnos. La relación completa se valida junto con `agent_name` contra `turns`. |
| `chain_depth` | `INTEGER` | `NOT NULL`, `CHECK (chain_depth >= 0)` | Profundidad transportada por la cadena. La raíz empieza en 0 y cada Callback hereda `parent + 1`. |
| `chain_deadline_at` | `INTEGER` | `NULL` | Deadline absoluto transportado por la cadena. Toda Initiative en `waiting_agent` —incluida la raíz que delega— lo fija al delegar, y cada Callback lo hereda del `parent`. **Pendiente:** duración concreta. |
| `visible_effects_declared` | `INTEGER` | `NOT NULL`, booleano | La cadena declaró efectos visibles; permite aplicar la decisión de avisar por el Primary Channel si un Callback queda huérfano. No afirma que el efecto se ejecutó. |
| `summary` | `TEXT` | `NULL` | Resumen durable de la Initiative, fijado al entrar en `waiting_human` (decisión 7 / `0043`) para conservarlo si pasa a `expired`; nunca es transcript interno. |
| `ask_correlation` | `TEXT` | `NULL` | Handle durable de la correlación explícita de la respuesta humana (decisión 11): el `reply_to` de Telegram o el identificador de la tarjeta web de la Initiative. Se fija en la misma transacción que pasa a `waiting_human` y se conserva o limpia al salir de ese estado. **Pendiente:** forma versionada exacta (JSON único o `type`+`ref`). La columna existe ya en Fase 1 porque la Fase 4 cuelga de ella y añadirla después sería una migración de datos, no de esquema. |
| `failure_reason` | `TEXT` | `NULL` | Motivo estable cuando termina en `failed`, incluida profundidad superada, recuperación tras arranque o Callback huérfano. |
| `result` | `TEXT` | `NULL` | Resultado durable de la Initiative, proyectado por el dashboard como `InitiativeSummary.result`. Se fija en la transacción que alcanza un estado terminal a partir del resultado del turno terminal y sobrevive a la purga de turnos de 30 días. |
| `created_at` | `INTEGER` | `NOT NULL` | Fecha de creación de la Initiative. |
| `state_changed_at` | `INTEGER` | `NOT NULL` | Fecha de la transición más reciente de Initiative State; no sustituye una auditoría de transiciones. |
| `started_at` | `INTEGER` | `NULL` | Fecha del primer paso a `running`. |
| `finished_at` | `INTEGER` | `NULL` | Fecha terminal para `succeeded`, `failed`, `expired` o `cancelled`; `NULL` en los demás estados. |

Comprobaciones a nivel de fila escritas como `CHECK` en la propia tabla (defensa en profundidad: no dependen de que el repositorio las valide):

- Invariante 1: `CHECK ((origin='trigger' AND trigger_id IS NOT NULL) OR (origin IN ('callback','human') AND trigger_id IS NULL))`.
- Invariante 2: `CHECK ((state IN ('succeeded','failed','expired','cancelled') AND finished_at IS NOT NULL) OR (state IN ('queued','running','waiting_human','waiting_agent') AND finished_at IS NULL))`.
- `CHECK (state <> 'waiting_human' OR summary IS NOT NULL)`: al entrar en `waiting_human` existe ya el resumen que conservar si caduca.

Invariantes que debe imponer el repositorio dentro de la misma transacción (implican varias tablas o varias filas; no son expresables como `CHECK`):

3. `waiting_human` se puede llevar a `expired` conforme a Agent Policy; `waiting_agent` no hereda esa caducidad.
4. El paso a `running` fija `bound_model` una sola vez si se aprueba esa calibración.
5. Una Initiative con origen `callback` debe tener exactamente una fila en `callbacks` con el mismo `id`; cómo se defiende se detalla en 1.3.
6. Toda Initiative en `waiting_agent` —incluida la raíz que delega y pasa a esperar— lleva `chain_deadline_at` fijado **al delegar**; una Initiative Callback lo hereda del `parent` junto con `chain_depth = parent + 1`, y al superar el máximo pasa a `failed`. **Pendiente:** profundidad máxima y duración del deadline.
7. La política ya decidida de arranque cambia cada `running` durable a `failed`, conserva resumen y motivo, y no la vuelve a despachar.

No se añade unicidad a `session_key`: una entrega de Callback reanuda la sesión aislada de `parent`, por lo que la misma key puede aparecer durante esa continuación. El repositorio debe tratar la `session_key` del `parent` como autoridad en esa entrega.

`ask_correlation` existe desde la Fase 1 aunque su forma se cierre en la Fase 4: una Initiative en `waiting_human` puede vivir hasta siete días (decisión 7 / `0043`), más que la vida de cualquier proceso del Manager. Si el Manager reinicia dentro de esa ventana, sin columna durable el `reply_to` entrante no sabría a qué Initiative responde; añadirla más tarde sería una migración de datos, no de esquema. Lo mismo motiva `result`: el dashboard lo proyecta como `InitiativeSummary.result` y no puede depender de un `turns.result` que se purga a los 30 días.

### 1.3 `callbacks`

Callback es una especialización 1:1 de Initiative, no una segunda Agenda. Su identidad es la de la Initiative que lleva el resultado y la continuación.

| Columna | Tipo | Clave / nulabilidad | Significado de dominio |
|---|---|---|---|
| `id` | `TEXT` | **PK**, `NOT NULL`, **FK** → `initiatives(id)` `ON DELETE CASCADE` | Identidad de la Initiative cuyo origen es `callback`; hace explícita la relación 1:1. |
| `parent_id` | `TEXT` | `NOT NULL`, **FK** → `initiatives(id)` `ON DELETE RESTRICT` | `parent`: Initiative originadora que debe reactivarse en su sesión aislada. |
| `result` | `TEXT` | `NOT NULL` | `result`: resultado que se inyecta como contexto al reactivar `parent`; viaja junto con la continuación. |
| `created_at` | `INTEGER` | `NOT NULL` | Fecha de creación y entrega durable del Callback a la Agenda del Agent de `parent`. |

Restricción a nivel de fila en la propia tabla:

- `CHECK (parent_id <> id)`: un Callback no puede ser su propio `parent`. Un self-Callback es un auto-encolado con paso extra, exactamente lo que la decisión 15 previene para los Triggers —el Agent que se realimenta a sí mismo—, y cierra la puerta trasera al bucle que el ADR `0005` no cubre.

La especialización 1:1 se defiende en el repositorio: el `INSERT` de `callbacks` corre siempre en la misma transacción que el `INSERT` de la Initiative Callback, y se rechaza cualquier `UPDATE` que rompa la correspondencia (invariante 5). SQLite no puede expresar "existe fila en otra tabla" como `CHECK`; se cubre con un test de integración. No se añade una columna `origin` redundante en `callbacks` en esta fase: la auditoría puede hacer el `JOIN`, y añadirla es un cambio aditivo posterior si se quiere auditar sin `JOIN`.

La profundidad, el deadline y la declaración de efectos están en `initiatives`, no duplicados aquí: son propiedades transportadas por toda la cadena y deben estar disponibles también en el `parent` antes de crear el siguiente Callback. El deadline, además, lo fija la raíz **al delegar** (invariante 6), de modo que el tiempo que la raíz pasa en `waiting_agent` se cuenta. El `failed` por profundidad excedida se valida en el flujo de creación del siguiente Callback; el repositorio lo documenta con un test de integración.

El modelo v1 de delegación es **un delegado a la vez**: a lo sumo un Callback pendiente por `parent`. Es el modelo de ADR `0008`/`0002` ("un delegado, un callback de retorno") y el que la decisión 12 describe en singular ("el loop reactiva la iniciativa pausada"). Dos Callbacks simultáneos para el mismo `parent` dejarían sin definir cuál reactiva la iniciativa. El repositorio impone esa unicidad de pendencia en el `INSERT`; la consulta de validación la sirve el índice de la sección 2.5. La unicidad no puede vivir en un índice único parcial: "pendiente" es el estado del `parent` (`waiting_agent`), que vive en `initiatives`, no en `callbacks`.

El paso de la Initiative originadora a `waiting_agent` ocurre cuando delega trabajo, antes de que exista el Callback de retorno. Más tarde, la entrega válida del Callback reactiva `parent` usando su `session_key`; la actualización de ambas Initiatives debe confirmarse en una sola transacción. El repositorio verifica además que `callbacks.parent_id` apunte a una Initiative del **mismo** `agent_name` que la Initiative Callback, porque la reactivación usa la `session_key` aislada de ese Agent. Si `parent` está `expired` o `cancelled`, o su Agent ya no existe, la Initiative Callback pasa a `failed`, conserva `failure_reason` y produce auditoría; si `visible_effects_declared=1`, se avisa por el Primary Channel. Esas consecuencias vienen decididas; el payload del aviso queda fuera de este esquema. La decisión 14 captura aquí el *qué* de la auditoría (`failure_reason` + `visible_effects_declared`); el *cuándo y quién* del evento queda fuera hasta que exista la tabla append-only (pendiente 8).

### 1.4 `turns`

Aunque el alcance durable es el estado terminal, una fila debe reservar primero la idempotency key. Si se insertara únicamente al final, dos peticiones simultáneas podrían ejecutar el mismo turno antes de que existiera la fila; eso no absorbería el `Map` actual, que reserva antes del WebSocket (`packages/manager/src/api-v1/routes.ts:968-990`). La fila no registra deltas ni transiciones: es una reserva durable que luego recibe una única fotografía terminal.

| Columna | Tipo | Clave / nulabilidad | Significado de dominio |
|---|---|---|---|
| `agent_name` | `TEXT` | **PK compuesta**, `NOT NULL` | Agent que ejecuta el turno. El código vivo ya cualifica `turnId` por Agent porque no presupone unicidad global (`packages/manager/src/api-v1/routes.ts:109-115`). |
| `turn_id` | `TEXT` | **PK compuesta**, `NOT NULL` | `turnId` aportado por quien inicia el turno. |
| `idempotency_key` | `TEXT` | `NOT NULL`, **UNIQUE** | Reserva global que hace que un reintento devuelva el `turnId` original en vez de ejecutar de nuevo, reproduciendo la semántica actual (`packages/manager/src/api-v1/routes.ts:968-976`). |
| `final_state` | `TEXT` | `NULL`, `CHECK (final_state IN ('succeeded','failed','cancelled'))` | Estado final del turno en vocabulario de dominio. `NULL` solo mientras existe la reserva pero aún no se observó terminal. |
| `result` | `TEXT` | `NULL` | Resultado terminal serializado. **Pendiente:** envelope exacto y si se conserva texto final, metadatos o ambos; no contiene deltas ni transcript. |
| `claimed_at` | `INTEGER` | `NOT NULL` | Fecha en que se ganó de forma atómica la idempotency key. |
| `finished_at` | `INTEGER` | `NULL` | Fecha de la fotografía terminal; `NULL` mientras `final_state` sea `NULL`. |

La idempotencia es **global a propósito**: `idempotency_key` es única entre Agents, reproduciendo el `Map` vivo que cualifica solo por `idempotencyKey` (`packages/manager/src/api-v1/routes.ts:107-108`). Su ventana, por tanto, cruza Agents: dos Agents con la misma key colisionan en la reserva y el segundo obtiene el `turnId` del primero como duplicado. La colisión es prácticamente nula —las keys son UUIDs del caller— y se conserva tal cual como comportamiento vigente.

Flujo atómico de idempotencia:

1. Antes de comprobar/abrir el Runner, insertar `(agent_name, turn_id, idempotency_key, claimed_at)`.
2. Si falla `UNIQUE(idempotency_key)`, leer y devolver el `turn_id` ya reservado.
3. Al observar `turn-complete`, `turn-error` o `turn-aborted` —los tres terminales actuales (`packages/manager/src/api-v1/routes.ts:1059-1066`)— actualizar una sola vez `final_state`, `result` y `finished_at`.

El mapeo terminal SSE ↔ `final_state` queda fijado: `turn-complete`→`succeeded`, `turn-error`→`failed`, `turn-aborted`→`cancelled` (`packages/manager/src/api-v1/routes.ts:1059-1066`).

**Pendiente importante:** el plan solo decide que una Initiative `running` pasa a `failed` al arrancar; no decide qué estado terminal asignar a una reserva de turno humano cuyo proceso cayó antes del terminal. Esas filas no se purgan ni se convierten automáticamente hasta resolver esa política. Aun así, conservar la reserva evita que un reinicio repita efectos.

## 2. Índices y consultas que los justifican

Solo se definen índices asociados a consultas concretas.

### 2.1 Qué vence ahora

1. Índice parcial `initiatives(available_at) WHERE state='queued'` con nombre conceptual `initiatives_due`.

   Consulta: `state='queued' AND available_at <= ahora`, ordenada por `available_at`, para que el Loop obtenga Initiatives despachables sin recorrer toda la Agenda. Es parcial sobre `state='queued'`: la forma compuesta no parcial solo serviría a consultas no declaradas (p. ej. contar `running`); si se quieren, se declaran aparte.

2. Índice parcial `triggers(next_fire_at) WHERE enabled=1 AND kind='schedule' AND (proposal_state IS NULL OR proposal_state='approved')` con nombre conceptual `schedule_triggers_due`.

   Consulta: `next_fire_at <= ahora` para calcular qué Trigger `schedule` debe dispararse. Es parcial porque la v1 no ejecuta otros tipos ni Triggers deshabilitados; el predicado de `proposal_state` refleja el conjunto realmente disparable —un Trigger `proposed` no se planifica (`next_fire_at IS NULL`) y no debe aparecer en el barrido—.

3. Índice parcial `initiatives(state_changed_at) WHERE state='waiting_human'` con nombre conceptual `initiatives_waiting_human_expiry`.

   Consulta: localizar `waiting_human` cuyo plazo de Agent Policy venció. No incluye `waiting_agent`, porque a ese estado no se aplica la caducidad.

4. Índice parcial `initiatives(chain_deadline_at) WHERE state IN ('queued','running','waiting_agent','waiting_human')` con nombre conceptual `initiatives_chain_deadline_due`.

   Consulta: el barrido `chain_deadline_at <= ahora` sobre Initiatives no terminales, que las pasa a `failed` con motivo de deadline vencido (decisión 13). Se ejecuta periódicamente **y al arranque**, de modo que un apagón más largo que el deadline no quede sin detectar; alcanza también a `waiting_agent`, que no tiene caducidad por tiempo humano pero sí esta red de seguridad de cadena.

### 2.2 Qué quedó `running` al arrancar

5. Índice parcial `initiatives(id) WHERE state='running'` con nombre conceptual `initiatives_running_at_startup`.

   Consulta de recuperación: leer todas las filas `running` y cambiarlas a `failed`. El índice parcial es pequeño y permite el barrido exacto; indexar todos los valores de `state` no aporta otra consulta caliente declarada. Es una lista reducida de rowids para ese barrido, **no** un índice de búsqueda por `id` —la PK ya cubre la búsqueda por `id`—.

### 2.3 Purga propuesta de turnos

6. **Solo si se aprueba la retención de 30 días:** índice parcial `turns(finished_at) WHERE final_state IS NOT NULL` con nombre conceptual `finished_turns_retention`.

   Consulta: borrar fotografías terminales con `finished_at < corte`. Las reservas sin terminal quedan fuera por la política pendiente descrita antes. La purga **no debe** borrar turnos aún referenciados por una Initiative no terminal (`initiatives.turn_id`), para no romper la trazabilidad de una cadena viva; para las Initiatives terminales el valor que sobrevive es `initiatives.result`, no el turno.

### 2.4 El terminal de un turno localiza su Initiative

7. Índice parcial `initiatives(agent_name, turn_id) WHERE turn_id IS NOT NULL` con nombre conceptual `initiatives_by_turn`.

   Consulta: `WHERE agent_name = ? AND turn_id = ?` para localizar la Initiative cuyo estado debe avanzarse cuando llega `turn-complete`, `turn-error` o `turn-aborted`. Es la escritura del camino crítico de *cada* turno, humano o autónomo, y sin índice sería un full scan sobre una tabla que crece sin cota. Es parcial porque los turnos humanos no dejan Initiative y muchas filas tendrán `turn_id IS NULL` tras reanudaciones.

### 2.5 Callbacks

8. Índice `callbacks(parent_id)` con nombre conceptual `callbacks_by_parent`.

   Consulta de validación en el `INSERT`: comprobar "a lo sumo un Callback pendiente por `parent`" (modelo un-delegado-a-la-vez de 1.3). La unicidad de pendencia se impone en el repositorio, en la misma transacción: "pendiente" es el estado del `parent` (`waiting_agent`), que vive en `initiatives`; un índice único parcial sobre `callbacks(parent_id)` no puede expresarlo sin referenciar otra tabla. El índice cubre también el hueco que antes este documento declaraba innecesario.

No se añade índice a `initiatives.agent_name`, `triggers.agent_name` ni a fechas meramente diagnósticas: este diseño no tiene todavía una consulta caliente que lo justifique. PK, FK con unicidad 1:1 y `UNIQUE(idempotency_key)` crean los índices necesarios para sus restricciones.

## 3. Versionado y migraciones al arrancar

### 3.1 Precedente existente

pihub no tiene hoy un versionador de datos equivalente: el arranque prepara directorios, inicializa Providers, provisiona Agents y arranca el Supervisor (`packages/manager/src/index.ts:17-33`), sin paso de migración ni versión de esquema. El dashboard sí declara `storageSchemaVersion` en cada Runtime Release (`../goguest-ai-dashboard-new/packages/control-plane/src/runtime/runtime-release.ts:12-22,31-37`) y su camino incompatible toma snapshot del volumen antes de tocarlo (`../goguest-ai-dashboard-new/packages/control-plane/src/runtime/migrate-user-runtime-storage.ts:18-26,49-60`), restaurando snapshot e imagen previa si falla (`../goguest-ai-dashboard-new/packages/control-plane/src/runtime/migrate-user-runtime-storage.ts:88-120`). Son dos niveles distintos:

- `PRAGMA user_version` versiona este fichero SQLite y gobierna migraciones internas, incrementales y forward-only.
- `storageSchemaVersion` versiona compatibilidad del volumen con una Runtime Release. Si una futura migración SQLite fuese incompatible con rollback de imagen, esa release debe coordinar el incremento y snapshot del nivel exterior. Cuándo una migración interna exige ese incremento queda **pendiente** del proceso de releases; no se inventa aquí.

### 3.2 Protocolo de arranque

1. Ejecutar el scaffold de `dataDir`.
2. Abrir el `.db`, activar `foreign_keys`, configurar WAL y leer `PRAGMA user_version`.
3. Si la versión en disco es mayor que la soportada por la imagen, abortar el Manager: una imagen antigua no debe interpretar un esquema nuevo.
4. Aplicar en orden cada migración numerada pendiente. Cada versión completa corre dentro de `BEGIN IMMEDIATE`; sus DDL/DML y el cambio de `user_version` se confirman en el mismo `COMMIT`.
5. Solo después de completar todas las versiones se inicializan Providers, se provisionan Agents, se ejecuta la recuperación de Initiatives `running` y el barrido de `chain_deadline_at` vencido (sección 2.1), se arranca el Supervisor y se publica HTTP. Hoy el Supervisor se arranca antes de crear la API (`packages/manager/src/index.ts:23-35`); el paso SQLite debe insertarse antes de esas actividades observables.

Las migraciones deben ser deterministas y no depender de red ni de un Agent activo. No se omiten versiones y no se baja `user_version` automáticamente.

### 3.3 Fallo a medias

- Si falla una sentencia, SQLite hace `ROLLBACK`; ni los cambios de esa versión ni su `user_version` quedan confirmados.
- El Manager termina con error y no arranca Runners ni escucha HTTP. systemd puede reintentarlo; el siguiente arranque vuelve a ver la versión anterior y repite la migración completa.
- Una migración no debe hacer operaciones de filesystem externas dentro de la transacción; no podrían revertirse con SQLite.
- Para una migración exterior incompatible, el rollback pertenece al precedente del dashboard: snapshot e imagen se restauran juntos. El Manager por sí solo no finge un rollback destructivo de esquema.
- Un `SIGKILL` o un OOM a mitad de migración no es un fallo de sentencia: la atomicidad la garantiza la recuperación del WAL al reabrir (replay del `-wal` y descarte de los cambios no confirmados), y `user_version` queda sin incrementar porque viajaba en la misma transacción. El reintento de systemd depende de que esa reapertura sea idempotente, que es lo que la recuperación de WAL proporciona.

## 4. Ubicación del fichero

Propuesta: **`${dataDir}/manager/agenda.sqlite3`**. Con el valor por defecto, `/data/manager/agenda.sqlite3`; `dataDir` hoy sale de `PIHUB_DATA_DIR` o `/data` (`packages/shared/src/env.ts:60-63`).

Razones:

- Es estado del Manager y de todo el User Runtime, no de un Agent individual.
- Evita `${dataDir}/global`, que es el directorio de Pi compartido: el registro actual define allí memoria y recursos globales (`packages/shared/src/registry.ts:32-38,103-108`).
- El Providers Module usa `${dataDir}/global/auth.json` y `models.json` (`packages/providers/src/index.ts:362-369`), y además `managed-providers.json` (`packages/providers/src/index.ts:452-454`). Sus mutaciones reescriben esos JSON de forma atómica (`packages/providers/src/index.ts:248-255,496-507,527-536`) y la inicialización puede materializar `models.json` (`packages/providers/src/index.ts:654-672`). El `.db` no debe mezclarse con esos ficheros ni quedar bajo un directorio que Pi considera propio.
- `${dataDir}/manager` es un nuevo límite explícito; el scaffold debe crearlo con los mismos permisos del volumen antes de abrir SQLite.

Los ficheros auxiliares WAL/SHM viven junto a `agenda.sqlite3`; forman parte del mismo almacén y no deben copiarse por separado mientras la base esté abierta.

## 5. Concurrencia

### 5.1 Modo SQLite

Usar **WAL**:

- permite lectores mientras un escritor confirma;
- evita que las lecturas del Loop bloqueen innecesariamente escrituras de Trigger, Callback o input humano;
- conserva la serialización real de escritores de SQLite, adecuada porque todos viven dentro del mismo proceso y las transacciones deben ser cortas.

Cada comando de dominio abre una transacción breve (`BEGIN IMMEDIATE` cuando vaya a escribir), valida el estado observado y aplica juntas todas las filas relacionadas. Ejemplos: disparar un Trigger + crear su Initiative + avanzar `next_fire_at`; crear un Callback + cambiar su `parent`; reservar idempotencia; completar turno + cambiar Initiative State. No se mantiene una transacción abierta mientras corre un Model, se espera al humano o se llama a un Channel.

Se configura un `busy_timeout` para absorber contención breve, pero su valor concreto queda **pendiente de calibración** con la librería SQLite elegida. También queda pendiente el valor de `synchronous` y la política de checkpoint; este documento no los fija sin medición operativa.

### 5.2 Lock de memoria por Agent

El lock en memoria por Agent decidido en la sesión serializa exclusivamente el read-modify-write del índice de memoria del Agent. Es una sección crítica **distinta** de la transacción SQLite:

- el lock por Agent protege el fichero de memoria frente a dos sesiones paralelas;
- SQLite protege Agenda, Trigger, Callback y turnos entre Loop, Trigger, Callback e input humano;
- humano e Initiative siguen pudiendo correr en paralelo; solo se ordena su escritura al índice de memoria.

No se debe mantener el lock de memoria mientras se espera el writer lock de SQLite, ni al revés. SQLite y filesystem no pueden formar una transacción atómica común. El orden y la recuperación cuando una misma acción cambie memoria y Agenda quedan **pendientes**; no se amplía silenciosamente uno de los locks para simular atomicidad. Esa decisión de orden debe cerrarse **antes de las fases 2 y 5**, que son donde un Callback toca memoria del Agent y Agenda a la vez (pendiente 10).

## 6. Revisión de calibraciones propuestas

Estas son recomendaciones, no decisiones adoptadas por este documento.

### 6.1 Binding de Model al despachar

**Encaja con el esquema y se recomienda mantener la propuesta.** `bound_model` es `NULL` en `queued`; el primer despacho lo fija en la misma transacción que pasa a `running`; una reanudación conserva el valor. Fijarlo al crear podría quedar obsoleto antes de ejecutar, y resolverlo de nuevo en cada reanudación rompería continuidad de una Initiative larga.

**Pendiente:** qué hacer si el Provider o el Model fijado deja de estar disponible durante `waiting_human` o `waiting_agent`. No se decide fallback automático.

### 6.2 Retención de turnos terminados durante 30 días

**Encaja, con una salvedad de idempotencia.** Se recomienda la purga por `finished_at` y el índice parcial descrito, pero purgar hace que una `idempotency_key` de más de 30 días vuelva a poder ejecutarse, igual que hoy una key expulsada se comporta como nueva (`packages/manager/src/api-v1/turns.ts:8-12`). Debe documentarse como ventana de idempotencia, no solo como limpieza diagnóstica.

No se purgan reservas con `final_state IS NULL` hasta decidir su recuperación. La periodicidad exacta, el tamaño de lote y si la purga corre al arranque o en temporizador quedan pendientes.

**Consecuencias adicionales de la purga (M8).** La purga a 30 días deja dos efectos que este esquema cierra en origen. El resultado que el dashboard proyecta como `InitiativeSummary.result` ya no se hereda de `turns.result` (que se borra): vive en `initiatives.result`, durable. Y la trazabilidad Initiative↔turno no se pierde en una cadena viva: la purga respeta los turnos referenciados por Initiatives no terminales (sección 2.3). Qué hacer con `initiatives.turn_id` de una Initiative terminal al purgar su turno —dejarlo colgando o ponerlo a `NULL` con registro en auditoría— queda en pendientes (pendiente 12), atado a la decisión del contenedor de auditoría.

**Retención de Initiatives terminales (B15).** Las filas terminales (`succeeded`/`failed`/`expired`/`cancelled`) **se conservan**: son la proyección histórica que consume el dashboard (la decisión 7 pide conservar resumen e historial) y el futuro soporte de auditoría. Los índices parciales las excluyen de las consultas calientes, así que el crecimiento es lateral y no degrada el camino crítico; una retención o archivo para estas filas es una calibración futura, no adoptada.

### 6.3 Auditoría por evento de dominio, sin transcript

**Es compatible con el límite de “sin log de eventos de turno”**: transición de Initiative State, disparo de Trigger, entrega de Callback y efecto declarado son hechos de dominio, no deltas SSE ni razonamiento interno. Se recomienda conservar la propuesta y excluir explícitamente transcripts.

No se incluye una tabla de auditoría en el esquema base porque todavía están pendientes su retención, consumidor, envelope, correlación y autoridad de escritura, y el plan sitúa auditoría en una fase posterior. Si se aprueba la calibración antes de implementar Fase 1, debe añadirse una tabla append-only en una migración definida antes del primer despliegue, de modo que el hecho y la transición de dominio se confirmen en la misma transacción. No debe reconstruirse auditoría a posteriori desde `state_changed_at`.

La decisión 14 exige que el Callback huérfano "siempre se registre en auditoría", y la 7 conserva "resumen e historial": mientras no exista la tabla append-only, esas decisiones están parcialmente sin soporte por el sistema, no por el esquema de Agenda. `failure_reason` + `visible_effects_declared` + `state_changed_at` capturan el *qué* del hecho, pero el *cuándo y quién* quedan fuera. La decisión de la calibración de auditoría debe atarse a las fases 5/6 para no llegar a una Fase 1 desplegada sin dónde escribir el evento de Callback huérfano si se aprueba entre medias (pendiente 8).

## 7. Pendientes que bloquean detalles, no este esquema base

1. Forma versionada de `definition_json` para `schedule`, incluida zona horaria.
2. Forma y proyección del campo de Triggers en `AgentConfig`; la autoridad de creación/revocación ya está decidida en la sección 1.1.
3. Profundidad máxima y duración del deadline de cadenas. El deadline ya tiene columna, invariante de `waiting_agent` y barrido (A3); queda solo su valor concreto.
4. Envelope exacto de `turns.result` y política de reservas sin terminal tras reinicio.
5. Conducta cuando un `bound_model` deja de estar disponible durante una espera.
6. Parámetros operativos de `busy_timeout`, `synchronous` y checkpoint WAL.
7. Cadencia y lotes de retención si se aceptan los 30 días, y si la purga corre al arranque o en temporizador.
8. Contrato, retención y **contenedor append-only** de auditoría (M11): la decisión 14 exige que el Callback huérfano *siempre* se registre en auditoría y la 7 conserva "resumen e historial"; sin tabla, esas decisiones quedan parcialmente sin soporte. El informe la considera necesaria antes de llegar a una Fase 1 desplegada con el evento de Callback huérfano por escribir; bloquea las fases 5 (callbacks) y 6 (contrato HTTP y auditoría).
9. Regla que determina cuándo una migración interna incrementa también `storageSchemaVersion` en la Runtime Release.
10. Orden y recuperación de una operación que deba escribir tanto memoria de Agent como SQLite (M12): no existe atomicidad entre ambos almacenes, y el informe pide cerrar el orden —y la compensación en fallo— **antes de las fases 2 y 5**, que son donde un Callback toca memoria del Agent y Agenda a la vez. No se amplía silenciosamente uno de los locks para simular atomicidad.
11. Forma versionada de `ask_correlation` (A2): la columna ya existe desde Fase 1; la Fase 4 cuelga de ella y solo queda fijar el envelope —JSON único o `type`+`ref`—.
12. Política de `initiatives.turn_id` ante la purga de turnos de 30 días (M8): ponerlo a `NULL` al terminar con registro en auditoría, o que la purga respete los referenciados. No bloquea la proyección —`initiatives.result` es durable— pero define el alcance de la trazabilidad Initiative↔turno y depende del contenedor de auditoría (pendiente 8).

---

## Correcciones aplicadas

- **A1** — Índice parcial `initiatives(agent_name, turn_id) WHERE turn_id IS NOT NULL` (§2.4): la actualización del estado de la Initiative en cada terminal de turno ya tiene consulta servida por índice; antes no existía ninguno para esa escritura del camino crítico.
- **A2** — Añadida `initiatives.ask_correlation` desde Fase 1 (§1.2), con justificación en el texto: la correlación de `ask` (decisión 11) debe sobrevivir a un reinicio dentro de la ventana de siete días y la Fase 4 cuelga de ella; añadirla después sería migración de datos. Su forma exacta queda en pendiente 11.
- **A3** — El invariante 6 exige ahora `chain_deadline_at` en toda Initiative `waiting_agent`, incluida la raíz que delega; añadidos el índice parcial `initiatives_chain_deadline_due` y el barrido periódico + de arranque (§2.1, §3.2); el `failed` por profundidad se documenta como validación del flujo de creación de Callbacks (§1.3).
- **M4** — Invariante 5 reforzado (§1.3): `INSERT` de `callbacks` siempre en la misma transacción que la Initiative Callback y rechazo de `UPDATE`s que rompan la correspondencia; documentado como regla del repositorio con test de integración, porque SQLite no expresa "existe fila en otra tabla" como `CHECK`. No se añade `origin` redundante en `callbacks`.
- **M5** — Añadido `CHECK (parent_id <> id)` en `callbacks` (§1.3) y verificación en el repositorio de que `parent` pertenece al mismo `agent_name` que la Initiative Callback.
- **M6** — El `CHECK` de `initiatives.state` se escribe literal en la tabla, con los ocho valores de Initiative State (§1.2).
- **M7** — Los invariantes 1 y 2 pasan a `CHECK` de fila en `initiatives` (§1.2), y `created_by`↔`proposal_state` en `triggers` (§1.1). Los invariantes multi-tabla/multi-fila (4, 5, 6, 7) se documentan como reglas del repositorio.
- **M8** — Añadida `initiatives.result` como resultado durable proyectado por `InitiativeSummary.result` (§1.2); la purga respeta los turnos referenciados por Initiatives no terminales (§2.3); la política del `turn_id` terminal queda en pendiente 12.
- **M9** — Cubierto por A3: el barrido de `chain_deadline_at` corre al arranque y periódicamente y alcanza a `waiting_agent` (§2.1, §3.2).
- **M10** — Documentado el modelo v1 "un delegado a la vez" (§1.3): a lo sumo un Callback pendiente por `parent`, validado en el `INSERT` y servido por el índice `callbacks_by_parent` (§2.5). Se explica por qué la unicidad no puede vivir en un índice único parcial.
- **M11** — No se inventa el contenedor de auditoría. Pendiente 8 reescrita citando por qué el informe lo considera necesario (las decisiones 7 y 14 afirman auditoría sin tabla) y en qué fases bloquea (5 y 6); nota añadida en §6.3 y §1.3.
- **M12** — No se decide el orden de locks. Pendiente 10 ampliada con el razonamiento del informe y exigencia de cerrarlo antes de las fases 2 y 5; nota añadida en §5.2.
- **B13** — Índice 1 ahora parcial `WHERE state='queued'`; índice 2 amplía su predicado a `(proposal_state IS NULL OR proposal_state='approved')` (§2.1).
- **B14** — Nota añadida al índice 5: es una lista reducida de rowids para el barrido de arranque, no un índice de búsqueda por `id` (§2.2).
- **B15** — Documentado que las Initiatives terminales se conservan para proyección histórica y auditoría pendiente (§6.2); una retención/archivo queda como calibración futura no adoptada.
- **B16** — Añadida la frase sobre `SIGKILL`/OOM a mitad de migración y la recuperación del WAL al reabrir (§3.3).
- **B17** — Documentado que la idempotencia es global a propósito y que su ventana cruza Agents; el esquema no cambia (§1.4).
- **B18** — Fijado el mapeo `turn-complete`→`succeeded`, `turn-error`→`failed`, `turn-aborted`→`cancelled` (§1.4).
- **B19** — Añadido `CHECK (state <> 'waiting_human' OR summary IS NOT NULL)` (§1.2).
