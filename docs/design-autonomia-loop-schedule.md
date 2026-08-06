# Fase 3 — Plan consolidado: el Loop y el despacho por `schedule`

**Estado:** diseño, no implementación. No se escribe ni se commitea código de
producción. Cita `ruta:línea` real, verificada contra `main`.

Repo: `/Users/iasacpepio/Workspace/EGOB/goguest_ai_dashboard/goguest_agent_pi`, rama `main`.

Este plan consolida dos diseños independientes de la Fase 3 (`/tmp/fase3-glm.md`
y `/tmp/fase3-sol.md`) según la decisión del coordinador. Donde ambos coincidían
se consolida sin reabrir; donde el coordinador decidió (Agent `errored` →
`failed`) se adopta la decisión y se fundamenta; donde difieren en algo no
decidido, se elige y se justifica. Los ADR `0001`, `0004`, `0005`, `0007`,
`0013` son la autoridad; el vocabulario es el de `CONTEXT.md`.

---

## 0. Base vigente (no se reinventa)

El Loop cuelga de la capa de dominio ya entregada en Fase 2. Operaciones
atómicas con frontera transaccional cerrada (contrato de seis pasos):

| Operación | Repo, ruta:línea | Frontera tx |
|---|---|---|
| `initiatives.listDue(now)` | `packages/manager/src/agenda/initiatives.ts:174-180` | lectura |
| `initiatives.listRunning()` | `packages/manager/src/agenda/initiatives.ts:183-187` | lectura |
| `initiatives.transition(cmd)` | `packages/manager/src/agenda/initiatives.ts:197-239` | 1 tx |
| `initiatives.sweepChainDeadline(now)` | `packages/manager/src/agenda/initiatives.ts` (T9) | 1 tx |
| `initiatives.sweepWaitingHumanExpiry(now)` | `packages/manager/src/agenda/initiatives.ts` (T10) | 1 tx |
| `triggers.fireTrigger(id, now)` | `packages/manager/src/agenda/triggers.ts:108-180` | 1 tx |
| `turns.reserveIdempotency(...)` | `packages/manager/src/agenda/turns.ts:60-90` | 1 tx |
| `turns.complete(...)` | `packages/manager/src/agenda/turns.ts:108-191` | 1 tx |
| `recoverRunningOnStartup(now)` | `packages/manager/src/agenda/recovery.ts:36-73` | 1 tx |

Arranque vigente (`packages/manager/src/startup.ts:106-131`):
`openStore → providers.initialize → provision → recover → createSupervisor →
startAll → createOAuth → createApp → serve`. Shutdown vigente
(`packages/manager/src/index.ts:49-62`): `stopAll → store.close →
server.close → exit(0)` en `SIGTERM`/`SIGINT`.

**Hueco detectado (input al diseño, no implementación):** `TriggerRepository`
expone `fireTrigger` pero **no** la lectura "qué `schedule` vencen ahora". El
índice `schedule_triggers_due` ya existe en disco
(`packages/manager/src/storage/migrations.ts:24-25`) pero la consulta no está
en el repo. La Fase 3 añade `triggers.listDueSchedule(now)` (§3).

---

## 1. Dónde vive el Loop, cómo arranca y para

### 1.1 Dónde vive

El Loop es un módulo del Manager, no un proceso aparte (ADR `0001`:
"infraestructura de plataforma, código, sin LLM"). Vive como `AgendaLoop`
(nombre de trabajo) en `packages/manager/src/agenda/loop.ts`, instanciado en el
arranque. No es un Agent ni un Runner.

Composición (todo inyectable, patrón ya usado en
`packages/manager/src/startup.ts:34-58`):

| Pieza | Origen | Inyección |
|---|---|---|
| `agenda: AgendaRepository` | `runtime.store.agenda` | por constructor |
| `supervisor: Supervisor` | `runtime.supervisor` | por constructor |
| `turns: TurnExecution` (§4) | compartido con la ruta HTTP | por constructor |
| `now(): number` | `Date.now` | inyectable (tests sin tiempo real) |
| `dispatchConcurrency: number` | config (default `1`, ADR `0004`) | por constructor |
| `tickIntervalMs: number` | config (default `1000`, §2.3) | por constructor |

El `AgendaLoop` no recibe el `SqliteDb` ni la app HTTP: solo `agenda`
(encapsula el driver, `packages/manager/src/agenda/index.ts:9-18`) y
`supervisor` (ciclo de vida de Agents, `packages/manager/src/supervisor.ts`).

### 1.2 Arranque: después de `serve`

**Decisión:** el Loop arranca **después** de `serve` (paso nuevo al final de
`runStartup`). El `TurnExecution` compartido (§4) se construye **antes** de
`createApp`, porque la ruta HTTP lo consume; el Loop reutiliza la misma
instancia.

Orden propuesto (los pasos nuevos se marcan **+**):

1. `openStore` — 2. `providers.initialize` — 3. `provision` — 4. `recover`
   (ADR `0007`) — 5. `createSupervisor` — 6. `supervisor.startAll` —
   **7+. `new TurnExecution(agenda, supervisor)`** — 8. `createOAuth` —
   9. `createApp` (usa `TurnExecution`) — 10. `serve` (HTTP público) —
   **11+. `new AgendaLoop(agenda, supervisor, turns, …)` y `loop.start()`**.

| Razón | Detalle |
|---|---|
| Disco consistente antes de despachar | la recuperación (ADR `0007`) corre en el paso 4, antes que cualquier despacho (`packages/manager/src/agenda/recovery.ts:36-73`). |
| Nada despacha antes de servir | el Loop despacha *después* de `serve`; la invariante de Fase 2.4 (recuperar → agentes → servir) se conserva sin esfuerzo adicional. |
| Si `serve` falla, el Loop no arranca | no hay autonomía desde una runtime a medio publicar. |
| El Loop no depende de HTTP | porque se rechaza el loopback HTTP (§4.1), el Loop no consume su propio socket; por eso puede arrancar después de `serve` sin acoplarse al socket. |

**Considerada y rechazada:** arrancar el Loop **antes** de `serve` (propuesta
del diseño `/tmp/fase3-sol.md` §2.1). Publicaría autonomía antes que HTTP y, si
`loop.start` falla, dejaría la runtime parcialmente disponible. No aporta nada
que `serve`-primero no cumpla.

### 1.3 Apagado con Initiatives en vuelo

**Decisión:** shutdown con gracia acotada + abort + *fallback* a recuperación
al arranque (ADR `0007`). Nunca se escribe `failed` durante el shutdown.

Orden propuesto para `shutdown()` (`packages/manager/src/index.ts:49-62`):

1. `loop.stop({ graceMs })` — ver abajo.
2. `supervisor.stopAll()` (mata Runners, `packages/manager/src/supervisor.ts`).
3. `store.close()` — cierra SQLite.
4. `server.close()` — cierra HTTP.

`loop.stop({ graceMs })` hace, en orden:

1. Pone un flag `stopping`; ningún `tick` nuevo reclama ni dispara Triggers.
   El `tick` en curso (síncrono, breve) termina su transacción.
2. Espera hasta `graceMs` terminales **naturales** de los turnos en vuelo (los
   Runners siguen vivos durante la gracia). Cada terminal natural escribe su
   `turns.complete` normalmente (`packages/manager/src/agenda/turns.ts:108-191`).
3. Al vencer la gracia, llama `abort()` en cada `TurnHandle` vivo
   (`TurnExecution.abort`, §4); el Runner emite `turn-aborted` → T6 escribe
   `cancelled`.
4. Espera un margen corto y acotado a esos `turn-aborted`.
5. Resuelve `stop`.

| Invariante | Por qué |
|---|---|
| Nunca `failed` en shutdown | escribir `failed` bajo `SIGTERM` con el Runner quizá aún corriendo crea la carrera "el Runner termina bien después del `close()` y la Initiative ya es `failed` sin motivo". `cancelled` solo se escribe cuando el Runner **él mismo** emitió `turn-aborted` (su terminal), así que no hay carrera. |
| Lo que quede `running` se recupera solo | al siguiente arranque, ADR `0007` / `recovery.ts:38-55` lo pasa a `failed` con `failure_reason='startup_recovery'`. El Trigger que lo originó vuelve a disparar. |
| El shutdown está acotado | `graceMs` y el margen post-abort son configurables; si `graceMs=0` equivale a "no esperar" (abort inmediato), que es el mínimo de `/tmp/fase3-glm.md` §1.3. |

**No determinado:** el valor de `graceMs` y del margen post-abort. Requieren
una política operativa de systemd/contenedor; deben ser configuración, no
constantes enterradas. (Calibración, fuera de Fase 3.)

`loop.stop()` es idempotente y no lanza (se llama desde un handler de señal).

---

## 2. El ciclo de despacho

### 2.1 El `tick`

Auto-programado: al terminar un `tick`, se reprograma el siguiente con
`setTimeout(tick, tickIntervalMs)` — **no** `setInterval` (evita reentrada si
un `tick` tardara más que el intervalo). Cada `tick` es síncrono y breve; no
espera al Runner (el terminal llega asíncrono por `turns.complete`, §4.4).

Cada `tick`, en orden:

1. **Barridos T9/T10** (`sweepChainDeadline`, `sweepWaitingHumanExpiry`). Correr
   en el `tick` (y no solo al arranque) lo decidió Fase 1: "se ejecuta
   periódicamente y al arranque". Sin esto, un proceso largo sin reinicios
   dejaría caducas sin avanzar.
2. **Disparo de Triggers `schedule` vencidos** (§3). Antes que el despacho: una
   Initiative nacida en T1 puede ocupar un slot en el mismo `tick`.
3. **Despacho de Initiatives `queued`** respetando el dial (§2.2).

Cada paso es idempotente: todos sus efectos viven en transacciones atómicas del
repo. Si el `tick` cae a mitad, el siguiente recoloca. El Loop no mantiene
estado en memoria que sobreviva a un reinicio salvo `stopping`, el dial y un
cursor efímero de round-robin (§2.3).

### 2.2 El dial de concurrencia

ADR `0004`: "nunca se despachan dos iniciativas del mismo agente en paralelo";
el dial (default 1) es cuántas Initiatives vuelan a la vez globalmente. El
dial **solo** rige Initiatives entre sí: **no** bloquea al canal humano
(sesiones aisladas por `sessionKey`, ADR `0003`; el Runner admite varios
`ChatHub` por key, `packages/runner/src/hub.ts:141-162`; confirmado por
ADR `0004` "Contexto posterior").

**Fuente de verdad del dial: `listRunning()` (disco), no un `Set` en memoria.**
Razón: el disco es lo que ya ve la recuperación (ADR `0007`) y
`turns.complete` (`packages/manager/src/agenda/turns.ts:140-160`). Un contador
en memoria se desincronizaría del disco si un turno terminara entre `ticks` y
el Loop no lo supiera. `listRunning()` se sirve del índice parcial
`initiatives_running_at_startup`; con default 1 el coste por `tick` es
despreciable.

**Latencia al liberar un slot:** además de la fuente durable, el Loop mantiene
un `Set` en memoria de los `turnHandle` que él despachó, **solo** para
disparar un `tick` inmediato cuando uno resuelve (wakeup), sin esperar el
siguiente `tickIntervalMs`. Ese `Set` no es fuente de verdad: si se pierde, el
próximo `tick` periódico reevalúa desde `listRunning()`. Es una optimización de
latencia, no de corrección.

Regla de un `tick` (consolidada de ambos diseños):

```
enVuelo = listRunning()                         // disco, fuente de verdad
ocupados = groupBy(enVuelo, agentName)          // exclusión por Agent (ADR 0004)
capacidad = dispatchConcurrency - |enVuelo|     // dial global
if capacidad <= 0: terminar
due = listDue(now)                               // ordenado por (available_at, id)
elegidas = seleccionar(due, ocupados, capacidad) // §2.3: round-robin + 1 por Agent
for ini in elegidas:
    if !agentDespachable(ini.agentName): aplicar matriz §6; continue
    dispatch(ini)                                // §4
```

Con dial 1: si existe una sola `running` global, el Loop no despacha (el Agent
de esa `running` ya está ocupado y, además, el dial global está lleno).
Secuencial puro (ADR `0004`: "con default 1, el modelo es secuencial puro").

### 2.3 Selección: round-robin entre Agents + FIFO dentro de cada Agent

**Decisión:** entre Agents, round-robin con cursor efímero en memoria; dentro
de cada Agent, FIFO por `(available_at, id)` (lo que ya devuelve `listDue`,
`initiatives.ts:174-180`). El cursor se pierde al reiniciar sin afectar
corrección (la próxima selección empieza de cero; el disco decide el resto).

| Alternativa | Por qué no |
|---|---|
| FIFO global puro | con dial 1, una Agenda larga y antigua de un Agent hambrearía al resto. |
| Prioridades persistidas | exige vocabulario/esquema no pedido; fuera de alcance. |

Ejemplo dial 2, `due = [A1, A2, B1, C1]`: arrancan `A1` y `B1`; `A2` queda
excluida mientras `A1` vuele; al liberar `B1` puede arrancar `C1`; al liberar
`A1`, `A2`. Un turno humano de A coexiste con `A1` porque el conjunto de
exclusión contiene solo Initiatives.

### 2.4 Periodicidad y configuración

`tickIntervalMs` default **1000 ms**, configurable. Lecturas por segundo con
default 1 son despreciables; los schedules se miden en minutos/horas. La
configuración entra por entorno (adición de Fase 3, hoy `PihubEnv` no la
proyecta, `packages/shared/src/env.ts:3-25`):

- `PIHUB_LOOP_CONCURRENCY` (entero ≥1, default 1).
- `PIHUB_LOOP_POLL_MS` (entero positivo, default 1000).

> **Marcado (pendiente 10, orden lock memoria ↔ SQLite):** el despacho (§4)
> escribe Agenda en SQLite y, al abrir el WS, pide al Runner una sesión aislada
> que toca el índice de memoria del Agent. El diseño vigente
> (`docs/design-autonomia-agenda-sqlite.md:256-264`) exige que ese orden se
> cierre **antes de las fases 2 y 5** y prohíbe anidar los locks. **Fase 3 no lo
> resuelve**: el Loop **no** toma el lock de memoria alrededor de la tx de
> `transition`; la sesión aislada vive en el Runner. El lock de memoria, cuando
> se cierre el pendiente 10, vivirá en `TurnExecution`/Runner, no en el Loop.

---

## 3. Triggers `schedule`

### 3.1 Qué vence ahora y la lectura que falta

Nuevo método del repo (implementación fuera de alcance, frontera sí):

```
triggers.listDueSchedule(now): readonly { id: string; agentName: string; … }[]
```

Su SQL es el predicado literal del índice `schedule_triggers_due`
(`packages/manager/src/storage/migrations.ts:24-25`):

```sql
SELECT id, next_fire_at FROM triggers
WHERE enabled = 1 AND kind = 'schedule'
  AND (proposal_state IS NULL OR proposal_state = 'approved')
  AND next_fire_at IS NOT NULL AND next_fire_at <= ?
ORDER BY next_fire_at, id;
```

Frontera: **lectura** (no abre tx de escritura). El disparo (`fireTrigger`) es
el que escribe, en su propia tx (`packages/manager/src/agenda/triggers.ts:117-166`).
`fireTrigger` **no** valida `next_fire_at <= now` (`triggers.ts:108-115`): el
Loop decide a quién disparar; el repo ejecuta. Separar lectura de escritura es
deliberado y ya es el diseño vigente.

### 3.2 Avance de `next_fire_at` y disparos perdidos: una Initiative por Trigger

**Decisión consolidada (ambos diseños coinciden):** ante un Trigger vencido,
**una sola Initiative por Trigger**, nunca una por ocurrencia perdida. Es el
comportamiento de `fireTrigger` por construcción (`triggers.ts:149-166`): crea
una Initiative `queued` y avanza `next_fire_at`; no encola atrasados.

**Matiz incorporado del diseño `/tmp/fase3-sol.md` (§4.3):** el "coalescer" debe
producir un `next_fire_at` **estrictamente posterior a `now`**, no iterar desde
el `next_fire_at` viejo. Esto es lo que lo hace correcto con horario de verano
y lo que evita una segunda Initiative en el `tick` siguiente.

Dos familias de schedule, explícitas:

| Familia | Cálculo del siguiente vencimiento | DST |
|---|---|---|
| **Intervalo** (`{version:1, kind:"interval", intervalMs}`, v1) | `now + intervalMs` (resincroniza desde `now`). | Ninguna: es duración en UTC epoch, sin calendario. Ya implementado (`triggers.ts:53-95`). |
| **Calendario** (pendiente 1, futura) | **primera ocurrencia civil posterior a `now`** en la zona IANA del Trigger, **no** iteración desde el viejo `next_fire_at`. | Ver §3.3. |

Política de apagón (Manager caído N horas): al volver, el primer `tick` ve todos
los Triggers con `next_fire_at <= now`; dispara **uno** por Trigger y salta a un
vencimiento futuro. Con dial 1, los disparos se serializan en `ticks`
sucesivos — no hay tormenta.

> **Límite de diseño deliberado (no hueco a cerrar en Fase 3):** la
> deduplicación de *efectos* (el mismo Trigger disparado dos veces seguidas
> tras un apagón podría repetir un efecto visible) **no** la cubre ADR `0007`
> (que solo cubre el reintento del *mismo* turno caído). Pertenece al
> Intent/skill del Agent, no al Loop.

### 3.3 Zona horaria y horario de verano (semántica y forma fijadas)

La **forma JSON versionada** del schedule con calendario quedó fijada en la
**Fase 3.6** como la unión cerrada `version: 1` (interval, sin cambios) /
`version: 2` (`daily` y `weekly`, con `timeZone` IANA obligatoria y `at` HH:mm).
La semántica de abajo es la que esa forma respeta, para que el Loop y
`triggers.ts` sean correctos:

- `next_fire_at` se almacena siempre como `INTEGER` ms UTC epoch
  (`docs/design-autonomia-agenda-sqlite.md` §0). Las comparaciones de
  vencimiento son siempre sobre UTC ms (orden numérico).
- El schedule con hora del día **debe** exigir zona IANA (`Europe/Madrid`, no
  offset fijo). La conversión civil→UTC ocurre solo al calcular el siguiente
  `next_fire_at`, nunca al comparar vencimientos.
- El cálculo del siguiente vencimiento usa una librería con tzdb IANA (no
  aritmética manual de ms), vive encapsulado en `triggers.ts` (donde hoy vive
  `nextFireAtFromDefinition`, `triggers.ts:53-95`), **no** en el Loop. El Loop
  solo llama `listDueSchedule` y `fireTrigger`.

Política DST para calendario local (incorporada de `/tmp/fase3-sol.md` §4.2):

| Caso | Decisión |
|---|---|
| Hora inexistente al adelantar reloj (gap, p. ej. 02:30 en el salto) | Ejecutar **una vez**, desplazando la hora civil hacia delante por la duración del hueco (comportamiento `compatible` de Temporal). |
| Hora ambigua al atrasar reloj (overlap, 02:30 ocurre dos veces) | Ejecutar **una sola vez**, en la **primera** ocurrencia cronológica. |
| Cambio de offset entre ocurrencias normales | Mantener la hora civil configurada; cambia el UTC correspondiente. |
| Zona IANA desconocida o definición inválida | `TRIGGER_NOT_DISPARABLE` (`packages/manager/src/agenda/errors.ts`): no crea Initiative ni avanza T1 (rollback). |

La librería concreta es `@js-temporal/polyfill@0.5.1` con `disambiguation:
"compatible"`, elegida porque la política DST de esta sección es literalmente
ese parámetro.

---

## 4. De Initiative a turno: el módulo compartido `TurnExecution`

### 4.1 Nombre y decisión

**Decisión:** extraer el camino de turno a un módulo compartido, con la ruta
HTTP y el Loop como dos consumidores. **Nombre elegido: `TurnExecution`.**

Justificación del nombre: nombra la **acción** (ejecutar un turno), alineado
con el lenguaje del ADR `0013` ("la Initiative se **ejecuta** como un turno").
`TurnDispatcher` —la propuesta de `/tmp/fase3-glm.md`— se rechaza como nombre
porque **sobrecarga** el verbo "despachar", que el ADR `0004` ya reserva para el
Loop (despachar Initiatives). El Loop *despacha* Initiatives; `TurnExecution`
*ejecuta* turnos. Dos verbos, dos módulos.

Las tres opciones de invocación:

| Opción | Veredicto | Razón |
|---|---|---|
| **A. Loopback HTTP** a `POST /api/v1/agents/:name/turns` | **Rechazada** (decisiva) | (1) El Loop consumiría su propio SSE como un cliente externo: torpe, mezcla transporte HTTP con flujo interno. (2) **Argumento decisivo incorporado de `/tmp/fase3-sol.md` §5.1:** el loopback **obligaría a arrancar el Loop después del servidor HTTP**, atando la autonomía al socket y contradiciendo el orden de Fase 2.4 (recuperar → agentes → servir). Atar la autonomía a que el socket HTTP esté publicado es una dependencia artificial. |
| **B. Llamar al Supervisor + abrir el WS desde el Loop** | **Rechazada** | Duplica idempotencia, puente WS→SSE, abort y traducción terminal — exactamente el "segundo protocolo" que ADR `0013` rechaza (`docs/adr/0013-initiative-runs-as-turn-with-own-origin.md`). |
| **C. `TurnExecution` compartido** (ruta HTTP = adaptador) | **Adoptada** | Una sola implementación de lookup, WS, abort, eventos y terminal; la ruta y el Loop la comparten sin duplicar. Requiere refactor de `routes.ts` (§4.6). |

### 4.2 Superficie de `TurnExecution`

Módulo (nombre de trabajo) `packages/manager/src/agenda/turn-execution.ts`:

| Método | Qué hace | Reutiliza |
|---|---|---|
| `startTurn(command): TurnHandle` | reserva idempotencia (o claim unificado, §4.5), abre WS al Runner, traduce WS→eventos, y al terminal llama `turns.complete`. | el puente hoy inline en `packages/manager/src/api-v1/routes.ts:991-1066`. |
| `abort(agentName, turnId)` | aborta un turno en curso. | hoy en `packages/manager/src/api-v1/routes.ts:1103-1134`. |

`TurnHandle` expone `completion: Promise<TurnTerminal>` (resuelve **exactamente
una vez**) y, para la ruta HTTP, un canal de eventos para traducir a SSE. El
Loop solo consume el terminal; no traduce SSE.

> **No determinado (implementación, no arquitectura):** la firma exacta de
> eventos de `TurnExecution` (callback / `AsyncIterable` / `Promise<Terminal>`
> + suscripción aparte). El coordinador puede fijarla. Este plan solo fija que
> **hay** una capa intermedia y que ruta y Loop la comparten.

### 4.3 Origen: parámetro de `TurnExecution`, no schema HTTP

ADR `0013` deja "pendiente la forma exacta de ese campo en el contrato". El
Loop no pasa por HTTP (opción C), así que el "contrato" que toca es la firma de
`TurnExecution.startTurn`, no el schema HTTP.

- Para Initiatives: `origin = { kind: 'initiative', initiativeId, cause: 'trigger' | 'callback' | 'human' }`.
- Para turnos humanos: `origin = { kind: 'human' }`.

La Initiative ya trae `origin` durable (`initiatives.origin`,
`packages/manager/src/storage/migrations.ts` CHECK `origin IN ('trigger','callback','human')`);
`TurnExecution` lo recibe y lo registra para auditoría/proyección. La **frontera
HTTP no cambia en Fase 3** (el contrato de proyección es Fase 6, fuera de
alcance).

**Aporte incorporado de `/tmp/fase3-sol.md` §5.2 (verificado y citado):** el
Runner hoy **solo** recibe `{ type: "prompt", text }` por WS
(`packages/manager/src/api-v1/routes.ts:1032-1041`; tipo en
`packages/shared/src/types.ts:55-62`). Por tanto, **si** en el futuro el Runner
necesitara distinguir el origen (v1 no lo requiere: corre el `intent` por
`sessionKey` aislada, `packages/runner/src/hub.ts:141-162`), la forma de
hacerlo es **ampliar ese mismo mensaje `prompt`**, no crear otro protocolo.
Esa es la razón por la que la opción B es el "segundo protocolo" rechazado y la
opción C no crea ninguno.

### 4.4 Cómo se cierra la Initiative al recibir el terminal

El terminal del turno ya está mapeado: `turn-complete`→`succeeded`,
`turn-error`→`failed`, `turn-aborted`→`cancelled` (`turns.ts:108-112` mapea;
`routes.ts:1059-1066` origina). `turns.complete` hace, **en la misma tx**
(`turns.ts:130-160`): `UPDATE turns` (CAS `final_state IS NULL`) +
`UPDATE initiatives SET state=finalState … WHERE state='running'`.

Es decir: **el terminal del turno ya cierra la Initiative**. El Loop **no**
mantiene un `Map<turnId, InitiativeId>` para cerrar; el repo localiza la
Initiative por `(agent_name, turn_id)`. ¿Qué hace el Loop al recibir el
terminal? **Nada**, salvo log y wakeup. El próximo `tick` ve la Initiative ya
terminal y el dial se libera solo.

### 4.5 Claim unificado en una transacción

**Decisión (adopta `/tmp/fase3-sol.md` §3.4, sustituye el two-step de
`/tmp/fase3-glm.md` §4.5):** añadir a `AgendaRepository` un **comando estrecho
de claim** que reserva T7 (idempotencia) **y** aplica T2 (`queued→running` con
`turnId`) en **una sola** `BEGIN IMMEDIATE`. El caller entrega
`initiativeId`, `turnId`, `idempotencyKey`, `now` (y `boundModel` si aplica);
recibe la Initiative `running` o `INITIATIVE_STATE_CONFLICT` /
`TURN_ID_CONFLICT`.

Razón para sustituir el two-step: reservar la idempotencia y *luego*
transicionar por separado (como proponía `/tmp/fase3-glm.md`) deja una
**reserva sin terminal** si el CAS pierde — exactamente el estado
compensatorio que roza el **pendiente 4** (reserva sin terminal,
`docs/design-autonomia-agenda-sqlite.md:152`). El claim unificado **no crea**
esa reserva huérfana: o el claim queda `running` con su turno, o no queda nada
(rollback). No resuelve el pendiente 4 (que es sobre el *Manager* caído antes
del terminal), pero reduce su superficie y no lo agrava.

El comando compone las dos invariantes detrás del seam de `AgendaRepository`
(`packages/manager/src/agenda/index.ts:9-18`), sin reinventar la máquina de
estados (`packages/manager/src/agenda/state.ts`) ni T7/T2: las sigue usando por
dentro. Una carrera produce `INITIATIVE_STATE_CONFLICT`
(`initiatives.ts:197-239`) y el Loop descarta esa fotografía; el estado durable
ganador decide el siguiente `tick`.

`transition(queued→running)` fija `bound_model` solo si era `NULL`
(`initiatives.ts`, invariante 4). **Decisión:** v1 no fija `bound_model` desde
el Loop; pasa `undefined` y el Agent usa su modelo por defecto
(`AgentConfig.model`). El binding queda para una calibración futura
(**pendiente 5**, `docs/design-autonomia-agenda-sqlite.md:270-274`).

### 4.6 El refactor que exige

La ruta `POST /agents/:name/turns` (`packages/manager/src/api-v1/routes.ts:947-1066`)
hoy tiene el puente WS→SSE **inline**. El refactor la convierte en un
**adaptador fino**: parsea body, valida (`createTurnV1Schema`), llama
`TurnExecution.startTurn`, y traduce los eventos a SSE (`streamSSE`). El Loop
llama al mismo `TurnExecution.startTurn` pero consume solo `completion`.

**Hueco que el refactor cierra (exigencia de ambos diseños):** la ruta hoy, ante
un `close` del Runner **sin** terminal ni abort, cierra el stream
silenciosamente (`packages/manager/src/api-v1/routes.ts:1077-1097`:
`if (turno?.abortRequested) finalizar({event:'turn-aborted'}) else finalizar()`
— `finalizar()` sin terminal). Para el Loop eso es inaceptable: una Initiative
`running` sin terminal queda colgada para siempre.

**Decisión:** `TurnExecution` trata **todo** cierre del Runner sin terminal
limpio (`close` sin abort, error de conexión, timeout) como `turn-error` → T6
escribe `failed`. Todo turno aceptado produce **exactamente un** terminal. Esto
**diverge** del comportamiento actual de la ruta HTTP (donde un close sin
terminal cierra el stream en silencio); la ruta HTTP **hereda** el nuevo
comportado al usar el mismo `TurnExecution`. Es una mejora deliberada y
consistente: el cliente SSE externo también recibirá un `turn-error` en vez de
un corte mudo, lo que es más correcto. Tocar la frontera del turno HTTP **es**
parte de Fase 3 (es el refactor); lo que queda fuera es el **contrato de
proyección** (Fase 6), no este.

**Watchdog de apertura/silencio (nuevo respecto a la ruta actual):**
`TurnExecution.startTurn` gana un `dispatchTimeoutMs` (calibración,
inyectable) que aborta el turno si no hay `agent_start`/actividad en ese plazo
y emite `turn-error`. La ruta HTTP actual no tiene este timeout; se justifica
porque el Loop, a diferencia de un cliente SSE externo, no tiene a quién
devolver un stream colgado. Valor **no determinado** (requiere medir duración
máxima aceptable de Model/tools; debe ser configurable).

### 4.7 `correlationId`

`TurnExecution.startTurn` recibe un `correlationId` de despacho, **distinto** de
`ask_correlation` (que es el **pendiente 11**, Fase 4, fuera de alcance). La
ruta HTTP hoy ya lo valida (`packages/manager/src/api-v1/schemas.ts:25-37`); el
Loop genera el suyo.

---

## 5. Matriz completa de fallos y reintentos

Principio rector: el Loop **no** reintenta por construcción (ADR `0005`:
auto-encolado inmediato prohibido; reintentar es auto-encolado). La única
"repetición" automática es **reevaluar** trabajo que **nunca salió de
`queued`**. La recuperación de un fallo durable es: el Trigger vuelve a
disparar en su próximo `next_fire_at` (ADR `0007`), o el humano reencola.

`running→queued` es ilegal (`packages/manager/src/agenda/state.ts:28-35`): un
fallo posterior al claim nunca se reencola.

### 5.1 Matriz por estado del Agent (decisión del coordinador)

| Estado del Agent (`supervisor.state`, `supervisor.ts:200-208`) | Initiative | Razón |
|---|---|---|
| `running` | **despacha** | el Runner acepta WS. |
| `stopped` | **sigue `queued`** | el Agent está apagado; se reevalúa al arrancar. |
| arrancando / reiniciando (backoff) | **sigue `queued`** | indisponibilidad transitoria gobernada por el Supervisor; se reevalúa en el siguiente `tick`/wakeup. |
| **`errored`** | **`failed`** con `failure_reason='agent_errored'` | ver §5.2. |

**Por qué `errored` → `failed` (decisión del coordinador, adoptada de
`/tmp/fase3-sol.md`, sustituye el "`queued`" de `/tmp/fase3-glm.md`):**

- **Contradice la decisión de coalescer.** Ambos diseños evitan la ráfaga tras
  un apagón disparando **una** Initiative por Trigger (§3.2). Dejar
  Initiatives encoladas contra un Agent roto produce **exactamente esa ráfaga**
  cuando el Agent vuelve: se ejecuta de golpe todo lo acumulado.
- **`errored` no es indisponibilidad transitoria.** Es el Supervisor declarando
  que **dejó de reintentar** tras `MAX_RESTARTS`
  (`packages/manager/src/supervisor.ts:97-101`:
  `if (managed.restarts >= MAX_RESTARTS) { managed.errored = true; … }`).
  Nadie lo va a levantar solo.
- **Diagnóstico.** Una Initiative `failed` con `failure_reason` se ve; una
  `queued` durante tres días no la ve nadie.
- **La recuperación ya existe** por el mismo mecanismo de ADR `0007`: el
  **Trigger vuelve a disparar** en su próximo `next_fire_at`. Se pierde una
  ocurrencia, no la intención.

> **Tensión menor (no resuelta, marcada):** el coordinador fijó solo el caso
> `errored`. `/tmp/fase3-sol.md` proponía además que un Agent **inexistente**
> (config ausente) pasara a `failed` con `agent_not_found`. La matriz de
> `/tmp/fase3-glm.md` mantenía "no existe → `queued`" (un Agent podría
> re-provisionarse). Sigo la matriz del coordinador ("el resto se mantiene"):
> **no existe → `queued`**. Aplicar la misma lógica de diagnóstico que justificó
> `errored`→`failed` llevaría a `agent_not_found`→`failed`, pero como el
> coordinador no lo movió, lo dejo en `queued` y lo señalo. Si el coordinador
> quiere cerrarlo, es un cambio de una línea en la matriz.

### 5.2 Matriz completa de fallos

| Fallo | Momento | Initiative final | `failure_reason` | ¿Loop reintenta? |
|---|---|---|---|---|
| Agent no existe (config ausente) | antes del claim | `queued` (no se transiciona) | — | no; reevalúa al re-provisionar (ver tensión §5.1) |
| Agent `stopped` | antes del claim | `queued` | — | reevalúa al arrancar |
| Agent arrancando/reiniciando | antes del claim | `queued` | — | reevalúa siguiente `tick` |
| **Agent `errored`** | antes del claim | **`failed`** | **`agent_errored`** | no; Trigger redispara |
| Runner no abre WS / error de conexión | después de `running` | `failed` vía T6 | `runner_unavailable` | no |
| Runner acepta pero no hay actividad antes de `dispatchTimeoutMs` | después de `running` | abort + `failed` vía T6 | `runner_unavailable` | no |
| `close` del Runner sin terminal ni abort | después de `running` | `failed` vía T6 | `runner_unavailable` | no |
| El turno emite `turn-error` | después de `running` | `failed` vía T6 | `turn_failed` | no |
| El turno emite `turn-aborted` (abort explícito) | después de `running` | `cancelled` vía T6 | — | no |
| El turno emite `turn-complete` | después de `running` | `succeeded` vía T6 | — | no |
| `TurnExecution.startTurn` lanza **antes** del claim | aún `queued` | `queued` | — | error transitorio: reevalúa; error de programación/storage: sube a health/log |
| `TurnExecution.startTurn` lanza **después** del claim | `running` | `failed` vía T6 | `dispatch_failed` | no |
| Claim pierde el CAS contra otra transición | claim | estado del ganador | — | no sobre la fotografía vieja; el siguiente `tick` reevalúa |
| `fireTrigger` lanza `TRIGGER_NOT_DISPARABLE` | antes de crear Initiative | sin Initiative (rollback) | — | el resto del `tick` continúa; el Trigger se reevalúa |
| `fireTrigger` lanza antes de `COMMIT` | antes de crear Initiative | sin Initiative; `next_fire_at` intacto (rollback WAL) | — | el próximo `tick` lo vuelve a ver |

**Refactor que exige la matriz:** hoy `turns.complete` fija **literalmente**
`failure_reason='turn_failed'` para cualquier terminal `failed`
(`packages/manager/src/agenda/turns.ts:176-183`). La matriz distingue
`turn_failed` (el Runner emitió `turn-error`), `runner_unavailable` (cierre/timeout
de conexión) y `dispatch_failed` (excepción tras el claim). Por tanto el comando
`complete` debe **aceptar una causa** de un catálogo estable
(`turn_failed | runner_unavailable | dispatch_failed`), sin dividir la
transacción de T6. `agent_errored` se escribe **antes** del claim (no vía T6:
es una transición `queued→failed` directa en el claim o en un barrido por
Agent-errored, ver §5.3). Este es un requisito de implementación de la matriz.

### 5.3 Cómo se materializa `errored` → `failed`

El Loop detecta `errored` al evaluar la matriz **antes** del claim. Como la
Initiative sigue `queued`, hay dos formas de pasarla a `failed`:

- **Recomendada:** el claim unificado (§4.5) acepta un "motivo de fallo" y, si
  el Agent está `errored`, hace la transición `queued→failed` con
  `agent_errored` en la misma tx en que habría hecho el claim (sin reservar
  turno). Reusa `canTransition('queued','failed')`, que es legal
  (`packages/manager/src/agenda/state.ts:23`).
- Alternativa: un barrido dedicado en el `tick` que, consultando
  `supervisor.state`, marque `failed` las `queued` de Agents `errored`. Más
  lecturas; menos-local al despacho.

La forma concreta es implementación; el plan fija que la transición es
`queued→failed` legal vía la función pura, con `failure_reason='agent_errored'`,
sin turno reservado.

---

## 6. Interacción con el Supervisor

El Supervisor gobierra el ciclo de vida de los Agents (`supervisor.ts`); el
Loop **observa** y no lo controla.

### 6.1 `state(name)` hoy y la ventana spawn→ready

`supervisor.state(name)` devuelve `running|stopped|errored`
(`packages/manager/src/supervisor.ts:200-208`); `running` significa "el child no
ha emitido `exit`", **no** "el WS está listo". Durante la ventana spawn→puerto
abierto, `state` ya es `running` pero el WS aún no acepta conexiones.

**Decisión (mínimo viable, alineado con la matriz del coordinador):** el Loop
despacha si `state==='running'`. Si el WS falla en esa ventana, la Initiative
pasa a `failed` por `turn-error` (§5.2) y el Trigger la redispara en el
siguiente vencimiento. Coherente con ADR `0007` ("el trigger que originó la
iniciativa volver a disparar").

**Mejora futura (fuera de Fase 3 salvo que el coordinador la pida):**
`/tmp/fase3-sol.md` §6.2 propone que el Supervisor exponga una clasificación
`missing | stopped | starting | restarting | ready | errored` (un `isReady(name)`
que compruebe que el puerto acepta conexiones). Evitaría el `failed` espurio
en la ventana spawn→ready. No se adopta en Fase 3 porque la matriz del
coordinador fija `running`→despacha y la acción para `stopped`/`restarting` es
idéntica (ambas `queued`); se marca como mejora.

### 6.2 Agent `errored` con Initiatives acumuladas

El Loop **no** reintenta un Agent `errored`: lo marca `failed` (§5). Loguear a
WARN la primera vez que el Loop ve un Agent `errored` con Initiatives `queued`
(ayuda al operador a ver el bloqueo antes de que se conviertan en `failed`).

### 6.3 Reinicio del Agent con un turno del Loop en vuelo

`restart` mata el WS del turno (`supervisor.stop`, SIGTERM/SIGKILL).
`TurnExecution` ve `close` sin terminal → emite `turn-error` → T6 `failed`
(§4.6). La Initiative `failed` no se repite; el Trigger redispara. El
`TURN_IN_PROGRESS` que hoy protege stop/restart frente a turnos vivos
(`packages/manager/src/api-v1/routes.ts:437-440`) se aplica a **todo** turno vivo
(humano o Initiative) vía el registro compartido de `TurnExecution`: stop/restart
se rechazan si hay un turno en curso, sin distinguir el origen.

> **Marcado (pendiente 4, reserva sin terminal):** `TurnExecution` emite
> `turn-error` por close sin terminal → T6 marca `failed`. El pendiente 4 es
> sobre el *Manager* caído antes del terminal, no el Runner; aquí el Manager
> vive y puede cerrar su propia reserva. **Fase 3 no resuelve el pendiente 4**,
> lo roza.

---

## 7. Estrategia de pruebas

Principio rector: **ninguna prueba espera tiempo real**. Todo lo temporal es
inyectable.

### 7.1 Seams de test

| Dependencia | Producción | Test |
|---|---|---|
| Reloj | `Date.now` + `setTimeout` | `ManualClock` + scheduler que solo corre callbacks al `advance(ms)`; el test **no** duerme. |
| `TurnExecution` | WS real al Runner | fake con `startTurn` que devuelve `TurnHandle` diferidos; el test decide cuándo y con qué terminal resuelven. |
| `Supervisor` | `Supervisor` real | fake con `state(name)` configurable. |
| `AgendaRepository` | SQLite en disco | SQLite `:memory:` (patrón ya existente en `packages/manager/test/agenda-startup.test.ts:23-34`). |

No se expone un `tick()` público solo para tests: se prueba la interfaz real
`start/stop`, reemplazando el adaptador temporal.

### 7.2 Matriz mínima del Loop

| Caso | Preparación | Aserción |
|---|---|---|
| Tick básico | una `queued` due, reloj fijo | un claim, un `startTurn`, estado `running`; ningún segundo `startTurn` al avanzar varios `tick`. |
| No due | `available_at > now` | cero claims hasta cruzar la fecha. |
| Dial default 1 | A1 y B1 due; dos `completion` pendientes | solo una empieza; al resolverla empieza la otra. |
| Dial 2 | A1, A2, B1, C1 due | empiezan A1+B1; **nunca** A1+A2; resolver B1 habilita C1; resolver A1 habilita A2. |
| Exclusión por Agent con hueco global | dial 2, 1 `running` de A + 1 `queued` de A + 1 `queued` de B | despacha B; no despacha la segunda de A aunque el dial global tenga hueco. |
| Humano paralelo | turno humano de A + Initiative de A due | la Initiative puede empezar; el humano no reduce `capacidad`. |
| Agent `stopped` | fake `state='stopped'` | Initiative queda `queued`; no hay `startTurn`. |
| Agent arrancando | fake `state='stopped'` con backoff simulado | `queued`; al pasar a `running` empieza sin recrearla. |
| Agent `errored` | fake `state='errored'` | `failed` con `agent_errored`, sin `startTurn`. |
| Terminales | resolver fake con complete/error/aborted | T6 deja `succeeded/failed/cancelled` y libera slot exactamente una vez. |
| `close` sin terminal | fake `completion` por close | `failed` con `runner_unavailable`. |
| Timeout de despacho | fake sin `agent_start` antes de `dispatchTimeoutMs` | `failed` con `runner_unavailable`. |
| Excepción antes del claim | `startTurn` lanza | `queued`; siguiente `tick` reevalúa. |
| Excepción tras el claim | `startTurn` lanza tras claim | `failed` con `dispatch_failed`. |
| Shutdown | turno diferido + reloj manual | no hay nuevos claims; antes de `graceMs` no aborta; al vencer aborta; el store no cierra antes del drain. |
| Wakeup al liberar slot | resolver un `TurnHandle` | se programa un `tick` inmediato; no se esperan `tickIntervalMs`. |
| Scan no solapado | repo fake bloquea lectura y se avanza el reloj | solo una lectura activa. |

### 7.3 Schedules y apagón (sin tiempo real)

1. **Intervalo perdido:** seed `next_fire_at=08:00`, reloj a 12:00, un `tick`.
   Una Initiative; `next_fire_at > 12:00` (= `12:00 + intervalMs`); otro
   `tick` sin avanzar no crea otra.
2. **Varias ocurrencias perdidas:** intervalo 1h, apagón 10h. Crea **una**, no
   diez.
3. **Round-robin:** tres Agents con due; dial 1; el cursor rota el orden de
   despacho entre `tick`s.
4. **DST spring-forward** (cuando el pendiente 1 cierre la forma): schedule
   civil 02:30 en zona IANA con hueco → primer instante válido posterior;
   dispara una vez.
5. **DST fall-back:** 02:30 ambiguo → primera ocurrencia; no dispara en la
   segunda.
6. **Zona inválida:** `TRIGGER_NOT_DISPARABLE`; cero Initiative; Trigger sin
   avance (rollback).
7. **Atomicidad:** reutilizar la propiedad ya probada de que un fallo de
   `COMMIT` deja cero Initiative y `next_fire_at` intacto
   (`packages/manager/test/agenda-triggers.test.ts:163-190`).

### 7.4 Regresión del refactor

La extracción de `TurnExecution` debe añadir un test de que la ruta HTTP y
`TurnExecution` producen **los mismos eventos** para la misma secuencia WS, para
que la herencia del nuevo comportamiento (close→`turn-error`) sea visible y no
regresiva para clientes externos.

### 7.5 Lo que no se prueba en Fase 3

- El puente WS→SSE **real** (Runner vivo): lo cubre la ruta HTTP hoy; al
  extraerlo, `TurnExecution` hereda esa cobertura.
- DST/zona horaria con librería real: bloqueado por pendiente 1 (§3.3).

---

## 8. Contradicciones resueltas al consolidar

El coordinador pidió señalar contradicciones entre lo elegido de un diseño y lo
del otro. Estas se resolvieron al consolidar:

1. **Claim: two-step (GLM) vs. single-tx (SOL).** Se elige single-tx (§4.5).
   *Resolución:* el two-step deja reservas huérfanas si el CAS pierde, rozando
   el pendiente 4; el single-tx no crea ese estado. Sustituye la propuesta de
   `/tmp/fase3-glm.md` §4.5.
2. **Dial: durable `listRunning()` (GLM) vs. in-memory `inFlight` (SOL).** Se
   fusionan (§2.2): `listRunning()` es la fuente de verdad; el `Set` en memoria
   **solo** dispara el wakeup. No hay contradicción funcional; se combina lo
   robusto (disco) con lo rápido (wakeup).
3. **Shutdown: no esperar (GLM) vs. gracia acotada + abort (SOL).** Se adopta
   gracia acotada (§1.3) con `graceMs` configurable: `graceMs=0` equivale al
   "no esperar" de GLM. La acotación resuelve la objeción de GLM ("esperar al
   Runner puede colgar"); el `cancelled`-solo-con-`turn-aborted` resuelve la
   carrera que GLM identificaba para `failed`.
4. **Selección: FIFO global (GLM) vs. round-robin (SOL).** Se elige round-robin
   entre Agents + FIFO dentro de cada Agent (§2.3) para evitar starvation. GLM
   no lo prohibía; SOL lo argumentó.
5. **`failure_reason`: literal `turn_failed` (GLM, y el código actual
   `turns.ts:176-183`) vs. catálogo `turn_failed|runner_unavailable|dispatch_failed`
   (SOL).** Se adopta el catálogo (§5.2): exige que `complete` acepte la causa.
   Resuelve la contradicción con el código vigente extendiendo el comando, sin
   dividir la tx de T6.
6. **`close` sin terminal: cerrar mudo (ruta HTTP actual) vs. `turn-error`
   (SOL).** Se adopta `turn-error` (§4.6) y la ruta HTTP **hereda**. Cambio
   deliberado de la frontera del turno HTTP, justificado por la corrección del
   Loop y de los clientes externos.

La única decisión impuesta por el coordinador (`errored`→`failed`) no es una
contradicción entre los dos diseños elegidos, sino la resolución explícita de
una divergencia: se adopta la de SOL con las cuatro razones de §5.1.

---

## 9. Fases de implementación (en orden, cada una verificable)

Estilo Fase 2: cada fase acaba en algo verificable antes de pasar a la
siguiente.

### Fase 3.1 — Extraer `TurnExecution` (sin cambiar comportamiento)
Extraer el puente WS→eventos→terminal de `routes.ts:991-1066` a
`TurnExecution`. La ruta `POST /agents/:name/turns` se vuelve un adaptador que
llama `startTurn` y traduce eventos a SSE. `abort` pasa a `TurnExecution.abort`
(`routes.ts:1103-1134`).
**Verificable:** los tests de la ruta HTTP existentes pasan sin cambios
(regresión); nuevos tests directos de `TurnExecution` con WS fake reproducen la
misma secuencia de eventos que la ruta.

### Fase 3.2 — Cerrar el hueco del terminal en `TurnExecution`
Todo turno aceptado produce exactamente un terminal: `close` sin terminal →
`turn-error`; timeout de despacho (`dispatchTimeoutMs`) → `turn-error`;
excepción tras claim → `failed`. Extender `turns.complete` para aceptar una
causa del catálogo `turn_failed|runner_unavailable|dispatch_failed` sin dividir
la tx.
**Verificable:** tests de que ningún `startTurn` aceptado queda sin terminal;
tests de cada causa con su `failure_reason`.

### Fase 3.3 — `triggers.listDueSchedule(now)` + coalesce de intervalo
Añadir la lectura sobre el índice `schedule_triggers_due`
(`migrations.ts:24-25`). El coalesce de intervalo ya lo hace `fireTrigger`
(`triggers.ts:149-166`).
**Verificable:** tests de apagón (§7.3.1 y §7.3.2): una Initiative por Trigger
vencido; `next_fire_at` salta a `now + intervalMs`.

### Fase 3.4 — Claim unificado en `AgendaRepository`
Comando estrecho que hace T7 + T2 (`queued→running` con `turnId`) en una sola
`BEGIN IMMEDIATE`; devuelve la Initiative `running` o conflicto.
**Verificable:** tests de claim (feliz, carrera `INITIATIVE_STATE_CONFLICT`,
`TURN_ID_CONFLICT`); test de que **no** queda reserva huérfana al perder el CAS.

### Fase 3.5 — El `AgendaLoop`
`tick` (barridos T9/T10 → disparo de Triggers → despacho), dial durable +
exclusión por Agent + round-robin, matriz de estados del Agent (incluido
`errored`→`failed` con `agent_errored`), despacho vía `TurnExecution.startTurn`,
wakeup al liberar slot, shutdown con gracia. Composición en `runStartup`
después de `serve` y en `shutdown` antes de `stopAll`.
**Verificable:** la matriz de tests §7.2 con fakes (reloj, `TurnExecution`,
`Supervisor`) y SQLite `:memory:`.

### Fase 3.6 — Semántica DST de calendario
Implementar `ScheduleCalculator` en `triggers.ts` (gap→desplazar por la duración
del hueco, overlap→primera ocurrencia, zona inválida→`TRIGGER_NOT_DISPARABLE`),
manteniendo la frontera transaccional de T1.
**Verificable:** tests §7.3.4–§7.3.6 con la librería tzdb elegida.

### Fase 3.7 — Configuración y arranque definitivo
`PIHUB_LOOP_CONCURRENCY`, `PIHUB_LOOP_POLL_MS`, `graceMs` y `dispatchTimeoutMs`
leídos al arranque (adición a `PihubEnv`/`loadEnv`,
`packages/shared/src/env.ts:3-25,60-82`). Composición final en `startup.ts` y
`index.ts`.
**Verificable:** test de arranque afirma el Loop presente y arrancado tras
`serve`; test de shutdown afirma el orden `loop.stop → stopAll → store.close →
server.close` y que no hay nuevos claims tras `stop`.

---

## 10. Pendientes abiertos (NO se resuelven aquí) y fase que bloquean

| Pendiente | Qué es | Fase que bloquea / roza |
|---|---|---|
| **1** Forma versionada del schedule con tz/recurrencia/saltos (`docs/design-autonomia-agenda-sqlite.md:35`; `triggers.ts:12-23`) | Define el JSON de calendario. | **Cerrada en Fase 3.6**: unión `version: 1` (interval) / `version: 2` (`daily`/`weekly`, `timeZone` IANA, `at`). Librería elegida: `@js-temporal/polyfill@0.5.1` con `disambiguation: "compatible"`. |
| **4** Reserva de turno sin terminal (`docs/design-autonomia-agenda-sqlite.md:152`) | Qué `final_state` dar a una reserva cuyo proceso cayó antes del terminal. | **Rozado** por Fase 3.2/3.4. El claim unificado (3.4) evita crear reservas huérfanas, pero no resuelve el caso "Manager cae antes del terminal". |
| **5** `bound_model` deja de estar disponible (`docs/design-autonomia-agenda-sqlite.md:270-274`) | Fallback si el modelo fijado desaparece en `waiting_human`/`waiting_agent`. | **Rozado** por Fase 3.5: v1 no fija `bound_model` desde el Loop; pasa `undefined`. |
| **8** Contenedor append-only de auditoría (`docs/design-autonomia-agenda-sqlite.md:292`) | Dónde y cómo se escribe el evento de dominio. | **No bloquea Fase 3**; el catálogo de `failure_reason` (§5.2) lo alimenta. Bloquea fases 5/6. |
| **10** Orden lock memoria ↔ SQLite (`docs/design-autonomia-agenda-sqlite.md:256-264`) | Orden/compensación cuando una acción toca memoria del Agent y Agenda. | **Rozado** por Fase 3.5 (el despacho toca ambas). Fase 3 lo deja **no determinado**: el Loop no toma el lock de memoria alrededor de la tx; el lock vivirá en `TurnExecution`/Runner cuando se cierre. Exigía cerrarse antes de fases 2 y 5. |
| **11** Forma de `ask_correlation` (`docs/design-autonomia-agenda-sqlite.md:79`) | Handle durable de la correlación de `ask`. | **Fase 4**; el `correlationId` de despacho de `TurnExecution` (§4.7) es distinto. |

**Calibraciones no determinadas (necesitan datos/política operativa):**
`graceMs`, `dispatchTimeoutMs`, `tickIntervalMs` (propuesto 1000), los valores
concretos de `busy_timeout`/`synchronous`, y la librería tzdb concreta + forma
JSON versionada del calendario (pendiente 1).

---

## 11. Lo que este plan NO hace (límites de la tarea)

- No implementa: ni `AgendaLoop`, ni `TurnExecution`, ni
  `triggers.listDueSchedule`, ni el claim unificado, ni el refactor de
  `routes.ts`. Solo diseña sus fronteras y el orden.
- No diseña Ask mode ni Channels (Fase 4).
- No diseña el contrato HTTP de proyección (Fase 6). El cambio al cierre del
  turno HTTP (close→`turn-error`, §4.6) es parte del refactor de Fase 3, no del
  contrato de proyección.
- No resuelve los pendientes 1, 4, 5, 8, 10, 11: donde los roza, los marca con
  la fase que bloquean (§10).
- No fija `graceMs`, `dispatchTimeoutMs` ni la librería tzdb: son calibración.

---

## 12. Decisiones resumidas

| # | Punto | Decisión |
|---|---|---|
| D1 | Dónde vive el Loop | módulo Manager `agenda/loop.ts` |
| D2 | Cuándo arranca | **después** de `serve` (TurnExecution se crea antes de `createApp`) |
| D3 | Shutdown con `running` | gracia acotada + abort + *fallback* ADR `0007`; nunca `failed` en shutdown |
| D4 | Fuente del dial | `listRunning()` (disco) + `Set` en memoria solo para wakeup |
| D5 | Periodicidad | `setTimeout` auto-programado, `tickIntervalMs=1000` configurable |
| D6 | Selección | round-robin entre Agents + FIFO dentro de cada Agent |
| D7 | Disparos perdidos | una Initiative por Trigger (coalesce); siguiente vencimiento > `now` |
| D8 | Invocación del turno | `TurnExecution` compartido (ruta HTTP = adaptador) |
| D9 | Nombre del módulo | **`TurnExecution`** (no `TurnDispatcher`: no sobrecargar "despachar") |
| D10 | Origen | parámetro de `TurnExecution.startTurn`; schema HTTP sin cambiar; Runner no lo necesita en v1 |
| D11 | Claim | single-tx (T7+T2) en `AgendaRepository`; no two-step |
| D12 | Agent `stopped`/arrancando | Initiative `queued` (reevalúa) |
| D13 | Agent `errored` | Initiative **`failed`** con `agent_errored` (decisión coordinador) |
| D14 | `close` sin terminal | `turn-error` → `failed`; la ruta HTTP hereda |
| D15 | Runner no responde | timeout en `TurnExecution` → `failed` con `runner_unavailable` |
| D16 | `failure_reason` | catálogo `turn_failed|runner_unavailable|dispatch_failed|agent_errored` |
| D17 | `bound_model` desde el Loop | no fijar (default del Agent); pendiente 5 |
| D18 | Estado del Agent para despachar | `state==='running'` (mínimo viable); `isReady` futuro |
