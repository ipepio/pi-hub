# Especificación de la Interfaz Privada del Manager — `/api/v1`

> **Estado:** implementada en el source actual; el contrato base está verificado contra el Manager real
> **Compatibilidad publicada:** dashboard `AgentExecutionPlatform` del repo `goguest-ai-dashboard-new` y Runtime Release fijada por digest
> **Referencias:** ADR 0002, 0025, 0030; arquitectura §5 (invariantes de `AgentExecutionPlatform`)

## 1. Propósito

Esta interfaz privada permite que el **control plane** (dashboard) gestione Agents, sesiones y turnos en el **User Runtime** pihub sin exponer puertos de Runner, WebSockets ni detalles internos. El dashboard nunca llama al socket Docker ni al puerto del Runner directamente.

## 2. Alcance

| Dentro del alcance | Fuera del alcance |
|---|---|
| CRUD de Agents (crear, leer, actualizar, pausar/reactivar, eliminar) | Panel web de pihub (`/*`) |
| Sesiones por Channel (web, Telegram) | OAuth de usuarios humanos |
| Turnos de chat con streaming de eventos | |
| Ciclo de vida explícito (`start`/`stop`/`restart`) | |
| Variables de entorno del Agent (conjunto y operaciones por clave) | |
| Variables de entorno globales (solo claves y operaciones por clave) | |
| Paquetes/extensiones del Agent (conjunto y operaciones por item) | |
| Paquetes globales (operaciones por item) | |
| Commands y transcribe del Agent (extensión panel/operator) | |
| OAuth de providers (extensión panel/operator) | |
| Modelos disponibles (`GET /models`) | |
| Estado global del Manager (`GET /status`, sin topología de puertos) | |
| Health y readiness | |
| Service auth (creencial de servicio) | |

*(2026-08, Fase 4 Release A): las operaciones por clave de env, los paquetes
por item, commands, transcribe y OAuth se añaden de forma aditiva para cerrar
la paridad funcional con el panel. El dashboard mantiene sus rutas de conjunto
completo y su Bearer; las extensiones panel/operator usan la cookie de panel
con CSRF para no exponer la credencial de servicio. OAuth de providers no es
parte de la Interface de ejecución del dashboard aunque viva en `/api/v1`.*

## 3. Autenticación — Service Auth

### 3.1 Credencial

- **Nombre en pihub:** `API_TOKEN` (el dashboard lo configura como `PIHUB_SERVICE_TOKEN`).
- **Formato:** string alfanumérico de al menos 32 caracteres, generado de forma criptográficamente segura.
- **Rotación:** el dashboard puede enviar un `POST /api/v1/auth/rotate` con la credencial antigua y la nueva. El Manager valida la antigua, persiste la nueva y rechaza la antigua en la siguiente petición.
- **Regla:** la credencial **nunca** aparece en payloads de respuesta ni en logs.

### 3.2 Header de autorización

```
Authorization: Bearer <service-token>
```

### 3.3 Comportamiento

| Caso | Respuesta |
|---|---|
| Sin header `Authorization` | `401 Unauthorized` con `{"code": "MISSING_AUTH", "message": "Credencial de servicio requerida"}` |
| Token incorrecto | `401 Unauthorized` con `{"code": "INVALID_AUTH", "message": "Credencial inválida"}` |
| Token rotado (usando el valor antiguo) | `401 Unauthorized` con `{"code": "ROTATED_AUTH", "message": "Credencial rotada, usa la nueva"}` |
| Token válido | `200/201/204` según la operación |

### 3.4 Cookie de panel y CSRF

`POST /auth/session` sigue siendo el login del panel: emite `pihub_token` y
rota `pihub_csrf`, una cookie legible por JavaScript, y devuelve
`{ "ok": true, "csrfToken": "..." }`. El token de servicio nunca aparece en
la respuesta.

En `/api/v1`, una cookie `pihub_token` válida autoriza lecturas. Las
mutaciones (`POST`, `PUT`, `PATCH`, `DELETE`) exigen además
`X-CSRF-Token` igual a la cookie `pihub_csrf`; si llega `Origin`, debe coincidir
con el origen de la petición. Bearer válido sigue siendo autenticación de
servicio y no necesita CSRF. Los errores son `403 CSRF_REQUIRED` o
`403 CSRF_INVALID`.

## 4. Contrato HTTP

### 4.1 Error Envelope Estándar

Toda respuesta de error sigue esta estructura:

```json
{
  "code": "AGENT_NOT_FOUND",
  "message": "El agente 'x' no existe",
  "correlationId": "req-abc123"
}
```

Códigos de error definidos:

| Código | Significado |
|---|---|
| `AGENT_NOT_FOUND` | El agente especificado no existe |
| `AGENT_ALREADY_EXISTS` | Ya existe un agente con ese nombre |
| `SESSION_NOT_FOUND` | La sesión no existe o no está activa |
| `SESSION_EXPIRED` | La sesión expiró |
| `TURN_NOT_FOUND` | El turno no existe o ya terminó (p. ej. al intentar abortarlo) |
| `TURN_IN_PROGRESS` | Hay un turno en curso que la operación pedida tumbaría (reinicio/parada) |
| `MODEL_FORBIDDEN` | El modelo no está permitido para el dueño del agente |
| `RESOURCE_UNAVAILABLE` | El servicio está temporalmente no disponible |
| `VOICE_PROVIDER_ERROR` | El proveedor de voz devolvió un error (`502`) |
| `INTERNAL_ERROR` | Error interno del Manager (nunca se expone al caller) |
| `MISSING_AUTH` | Credencial de servicio ausente |
| `INVALID_AUTH` | Credencial de servicio inválida |
| `CSRF_REQUIRED` | Falta el token CSRF de una mutación de panel |
| `CSRF_INVALID` | El token CSRF u Origin no es válido |
| `ROTATED_AUTH` | Credencial de servicio rotada |

### 4.2 Health y Readiness

```
GET /api/v1/health
GET /api/v1/readiness
```

Health:
```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2026-07-14T12:00:00Z" }
```

Readiness:
```json
{ "status": "ok", "checks": [
  { "name": "data-dir", "status": "ok" },
  { "name": "db", "status": "ok" }
]}
```

### 4.3 Agents

```
POST   /api/v1/agents          — Crear agente
GET    /api/v1/agents          — Listar agentes
GET    /api/v1/agents/:name    — Leer agente
PATCH  /api/v1/agents/:name    — Actualizar agente
DELETE /api/v1/agents/:name    — Eliminar agente
```

#### POST /api/v1/agents

Request:
```json
{
  "name": "mi-agente",
  "model": "anthropic/claude-sonnet-4-20250514",
  "thinkingLevel": "low",
  "systemPrompt": "Eres un asistente útil.",
  "telegramToken": "123456:ABC",
  "ttsVoice": "alloy",
  "memory": { "sharedAccess": "read" },
  "packages": ["@goguest/knowledge-search"]
}
```

`model` es opcional. Si se omite, `createAgent` aplica
`PIHUB_DEFAULT_MODEL`; el dashboard control plane sigue enviándolo de forma
explícita.

Response `201`:
```json
{
  "name": "mi-agente",
  "status": "running",
  "model": "anthropic/claude-sonnet-4-20250514",
  "webAddress": "mi-agente.agents.miempresa.com"
}
```

#### GET /api/v1/agents/:name

*(2026-07-29, bug 4: la spec ya prometía esta ruta desde antes de esa fecha —
está en la tabla de arriba desde el principio — y nunca se implementó.)*

Response `200`:
```json
{
  "name": "mi-agente",
  "status": "running",
  "model": "anthropic/claude-sonnet-4-20250514",
  "telegram": false,
  "systemPrompt": "Eres un asistente útil.",
  "envKeys": ["OPENWEATHER_API_KEY"],
  "packages": ["@goguest/knowledge-search"]
}
```

`systemPrompt`, `envKeys` y `packages` viven **solo aquí** — nunca en
`GET /api/v1/agents` (el listado), que si los llevara volcaría todos los
prompts del Runtime en una sola respuesta. `envKeys` son solo las claves
(nunca los valores: ver §4.3b).

#### PATCH /api/v1/agents/:name

Request:
```json
{
  "model": "anthropic/claude-haiku-3-20250320",
  "systemPrompt": null,
  "telegramToken": "123456:ABC",
  "enabled": false
}
```

Todos los campos son opcionales: uno omitido conserva el valor actual; `null`
en `telegramToken`, `ttsVoice` o `memory` los limpia (vuelven al default de
plataforma). El token de Telegram nunca aparece en la respuesta.

**Cuándo reinicia el Runner** *(2026-07-29, bug 1: antes esto solo miraba si
cambiaba `telegramToken` — cambiar el Model o editar la Persona se persistía
y el Runner en marcha nunca se enteraba)*: el Manager compara una **huella**
de todo lo que el Runner lee al arrancar — `model`, `thinkingLevel`,
`telegramToken`, `ttsVoice`, `memory`, `systemPrompt`, el env del Agent
(§4.3b) y sus paquetes (§4.3c) — antes y después del PATCH. Si la huella no
cambió (p. ej. el dashboard reconcilia mandando el mismo estado), **no
reinicia**, aunque el campo viniera en el body. Si cambió y el Agent estaba
`running`, el Runner se para y se vuelve a arrancar antes de responder. Si
estaba parado y sigue habilitado, el PATCH solo persiste — **nunca arranca
por sorpresa** — y el siguiente arranque explícito (§4.3d) usa el valor
nuevo. `{"enabled": false}` para el proceso de verdad *(bug 2: antes solo lo
marcaba en el config y el proceso seguía vivo)*; `{"enabled": true}` en un
Agent deshabilitado lo arranca.

Si haría falta reiniciar o parar y el Agent tiene un turno vivo (una
petición `POST .../turns` con su WebSocket aún abierto), el PATCH se
rechaza **antes de persistir nada** con `409 TURN_IN_PROGRESS` — reiniciar
tumbaría ese turno. El caller puede reintentar cuando termine, o abortarlo
primero (§4.5).

Response `200`:
```json
{
  "name": "mi-agente",
  "status": "stopped",
  "model": "anthropic/claude-haiku-3-20250320",
  "telegram": false
}
```

### 4.3b Variables de entorno del Agent

```
GET /api/v1/agents/:name/env  — Leer las claves (nunca los valores)
PUT /api/v1/agents/:name/env  — Reemplazar el conjunto COMPLETO
```

`GET` responde `{"keys": ["OPENWEATHER_API_KEY", "OTRA_VAR"]}` — nunca los
valores, son secretos. `PUT` recibe `{"env": {"CLAVE": "valor", ...}}` y
**reemplaza todo el store del Agent**, no añade/quita variables sueltas: lo
que no venga en el body deja de existir. Rechaza con `400 BAD_REQUEST` una
clave con formato inválido o protegida (`API_TOKEN`, prefijos `PIHUB_*` /
`PI_CODING_AGENT_*`) — y si la rechaza, **no persiste nada**, ni siquiera las
claves válidas del mismo payload. El reemplazo de conjunto global queda fuera de `/api/v1`: filtraría
configuración entre Agents hermanos. El panel usa las operaciones atómicas
`/api/v1/env` descritas abajo.

Para el panel existen además operaciones atómicas que no exponen valores:

```
PUT    /api/v1/agents/:name/env/:key  — body {"value": "..."}
DELETE /api/v1/agents/:name/env/:key
GET    /api/v1/env                    — solo el store global, solo claves
PUT    /api/v1/env/:key               — body {"value": "..."}
DELETE /api/v1/env/:key
```

Todas responden únicamente `{"keys": [...]}`. Usan el mismo `setEnv` y
`unsetEnv` del store existente. Las rutas por Agent aplican la misma huella y
guard `TURN_IN_PROGRESS` que el PUT completo; las globales quedan separadas
del Agent y recargan los Runners activos de forma diferida.

Reinicia el Runner con la misma huella y el mismo guard `TURN_IN_PROGRESS`
que el PATCH (§4.3), y solo si el Agent estaba `running` y el conjunto
realmente cambió.

### 4.3c Paquetes del Agent

```
GET /api/v1/agents/:name/packages  — Leer el conjunto instalado
PUT /api/v1/agents/:name/packages  — Reemplazar el conjunto COMPLETO
```

`PUT` recibe `{"packages": ["@goguest/knowledge-search", ...]}`: el conjunto
COMPLETO deseado, no altas/bajas sueltas. El Manager calcula la diferencia
con lo instalado y converge llamando a `pi install`/`pi remove` real por
cada paquete que sobra o falta. Responde `202` (la convergencia puede tardar:
instala paquetes de verdad). Mismo guard `TURN_IN_PROGRESS` que el PATCH si
hay diferencia y el Agent está `running`.

El panel usa operaciones atómicas por item:

```
POST   /api/v1/agents/:name/packages  — body {"source": "..."}
DELETE /api/v1/agents/:name/packages  — body {"source": "..."}
GET    /api/v1/packages              — lista global
POST   /api/v1/packages              — body {"source": "..."}
DELETE /api/v1/packages              — body {"source": "..."}
```

POST y DELETE reutilizan `piInstall`/`piRemove`, traducen stderr a
`BAD_REQUEST`, no devuelven paths y responden `202` mientras se agenda el
reload. El store global no se mezcla con el del Agent.

### 4.3d Ciclo de vida explícito

```
POST /api/v1/agents/:name/start    — Arrancar
POST /api/v1/agents/:name/stop     — Parar
POST /api/v1/agents/:name/restart  — Reiniciar
```

Operación imperativa, distinta del estado declarativo del PATCH. `start` y
`stop` fijan `enabled` en sync con la acción (`true`/`false`), para que un
reconcile posterior no la deshaga sin querer. `stop` y `restart` respetan el
mismo guard `TURN_IN_PROGRESS` que el PATCH. Responde `200` con el mismo
cuerpo que `GET /agents/:name` (sin `systemPrompt`/`envKeys`/`packages`).

### 4.4 Sesiones

```
POST   /api/v1/agents/:name/sessions  — Crear sesión
GET    /api/v1/agents/:name/sessions  — Listar sesiones
DELETE /api/v1/agents/:name/sessions/:key  — Cerrar sesión
```

#### POST /api/v1/agents/:name/sessions

Request:
```json
{
  "channel": "web",
  "sessionKey": "abc-def-123"
}
```

Response `201`:
```json
{
  "key": "abc-def-123",
  "channel": "web",
  "agent": "mi-agente",
  "createdAt": "2026-07-14T12:00:00Z"
}
```

`sessionKey` es la identidad estable de la Channel Session. El Manager la
selecciona al abrir el puente hacia el Runner y el Runner mantiene un
`AgentSession` y un directorio de transcript independientes por clave. Repetir
la misma clave reanuda esa sesión; dos claves distintas nunca comparten
contexto, aunque pertenezcan al mismo Agent.

### 4.5 Turnos

```
POST   /api/v1/agents/:name/turns             — Ejecutar turno
GET    /api/v1/agents/:name/turns/:id         — Leer estado del turno
POST   /api/v1/agents/:name/turns/:id/abort   — Abortar un turno en curso
```

#### POST /api/v1/agents/:name/turns

Request:
```json
{
  "sessionKey": "abc-def-123",
  "turnId": "turn-001",
  "idempotencyKey": "idem-001",
  "correlationId": "req-xyz789",
  "message": "¿Qué sabes sobre X?"
}
```

`abortSignal` en el body y el header `X-Abort: true` son un **alias
deprecado, sin efecto** *(bug 3: nunca se leyeron; el schema los sigue
aceptando por compatibilidad, pero no hacen nada)*. Pedían abortar en la
MISMA llamada que crea el turno, y no hay forma coherente de abortar algo
que aún no existe. Para cancelar un turno en curso, usa la ruta dedicada de
abajo con el `turnId` que el caller ya conoce por ser suyo.

Response `200` (streaming SSE):
```
event: turn-start
data: {"turnId": "turn-001", "agent": "mi-agente"}

event: chunk
data: {"turnId": "turn-001", "delta": "Hola"}

event: chunk
data: {"turnId": "turn-001", "delta": ", soy tu"}

event: turn-complete
data: {"turnId": "turn-001", "totalTokens": 42}
```

O bien:
```
event: turn-error
data: {"turnId": "turn-001", "code": "RESOURCE_UNAVAILABLE", "message": "Service unavailable"}
```

#### GET /api/v1/agents/:name/turns/:id

Response `200`:
```json
{
  "turnId": "turn-001",
  "status": "completed",
  "result": { "content": "Hola, soy tu asistente." },
  "completedAt": "2026-07-14T12:00:05Z"
}
```

Response `202` (in-progress):
```json
{
  "turnId": "turn-001",
  "status": "running"
}
```

#### POST /api/v1/agents/:name/turns/:id/abort

Manda `{"type": "abort"}` por el WebSocket del turno hacia el Runner (que ya
lo acepta). Response `202`, sin cuerpo. `404 TURN_NOT_FOUND` si el turno no
existe o ya terminó — el registro de turnos vivos es en memoria por
instancia del Manager, no persistido (mismo tradeoff que `turnosVistos`,
la idempotencia de §5).

### 4.6 Subida de ficheros

```
POST /api/v1/agents/:name/uploads — Dejar un fichero en el workspace del Agent
```

Request: `multipart/form-data` con un campo `file`.

Response `200`:
```json
{
  "path": "uploads/1234-informe.csv",
  "name": "informe.csv",
  "size": 1234,
  "type": "text/csv"
}
```

`path` siempre es relativo al workspace del Agent. El Manager reenvía el
multipart al Runner y devuelve solo este cuerpo; no expone el puerto ni el path
interno del Runner. El nombre se sanea y el límite de 50 MB se aplica en el
Runner.

Errores específicos:

| Caso | Respuesta |
|---|---|
| Agent inexistente | `404` con `AGENT_NOT_FOUND`, antes de leer el body |
| Fichero ausente o inválido | `400` con `BAD_REQUEST` |
| Fichero mayor de 50 MB | `413` con `PAYLOAD_TOO_LARGE` |
| Runner parado o inaccesible | `503` con `RESOURCE_UNAVAILABLE` |

### 4.6a Commands y transcribe (panel/operator)

Estas rutas son extensiones humanas del Manager; no forman parte de la
Interface de ejecución del dashboard:

```
GET  /api/v1/agents/:name/commands
POST /api/v1/agents/:name/transcribe  — multipart/form-data, campo file
```

`commands` devuelve `{ "skills": [...], "prompts": [...] }`. Un Runner
parado, inaccesible o con una respuesta inválida se traduce a
`503 RESOURCE_UNAVAILABLE`; nunca se devuelve el error crudo ni el puerto.

`transcribe` reenvía el multipart al Runner. Conserva `501` con
`{"error":"STT no configurado"}` cuando falta STT, traduce audio demasiado
grande a `413 PAYLOAD_TOO_LARGE` y los fallos del proveedor a
`502 VOICE_PROVIDER_ERROR`.

### 4.7 Modelos disponibles

```
GET /api/v1/models — Catálogo de modelos (solo lectura)
```

Response `200`:
```json
{
  "models": [
    { "provider": "anthropic", "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "configured": true },
    { "provider": "openai", "id": "gpt-5", "name": "GPT-5", "configured": false }
  ]
}
```

`configured` es `true` si el Manager tiene credenciales (API key u OAuth)
para ese modelo. La Interface del dashboard no gestiona providers; el panel
operator puede usar las rutas OAuth de §4.9.

### 4.8 Estado global

```
GET /api/v1/status — Estado del Manager
```

Response `200`:
```json
{ "version": "0.1.0", "pi": "0.80.3", "agents": 3, "panel": true }
```

`panel` refleja el eje de control (`PIHUB_PANEL_ENABLED`): `true` en modo
gobernador, `false` en gobernado. **Nunca** lleva el rango de puertos de los
Runners ni ningún otro dato de topología interna — §7 lo prohíbe
explícitamente.

### 4.9 OAuth de providers (panel/operator)

Estas rutas usan el `OAuthService` único del Manager y conservan su máquina de
estados. Son una extensión para el panel/operator, no una capacidad que deba
consumir el dashboard control plane:

```
GET  /api/v1/auth/providers
POST /api/v1/auth/login/:provider
GET  /api/v1/auth/flows/:id
POST /api/v1/auth/flows/:id/input
POST /api/v1/auth/logout/:provider
```

Se autentican por Bearer o por la cookie de panel con CSRF en mutaciones. Las
rutas legacy `/api/auth/*` permanecen durante esta release para no romper el
panel actual; se retirarán en la sub-fase de migración del cliente.

## 5. Campos obligatorios en cada comando

| Campo | Tipo | Descripción |
|---|---|---|
| `turnId` | string | Identificador único del turno, generado por el caller |
| `sessionKey` | string | Clave de sesión del channel, generado por el caller |
| `idempotencyKey` | string | Clave de idempotencia para repeticiones seguras |
| `correlationId` | string | ID de correlación para trazabilidad en logs |

## 6. Invariantes

1. **Ningún caller conoce tokens, pid, puertos, paths o WebSockets de Runner.** El Manager es el único punto de entrada.
2. **`turnId`, `sessionKey`, `idempotencyKey` y `correlationId` son obligatorios** en cada comando de turno.
3. **La cancelación cruza toda la cadena** mediante `POST /agents/:name/turns/:id/abort` (§4.5), que manda `{"type":"abort"}` al Runner por su WebSocket. *(2026-07-29: `abortSignal`/`X-Abort` en la creación del turno nunca se implementaron y quedan deprecados — no se puede abortar algo que aún no existe.)*
4. **Cada stream termina con un evento final o error terminal tipado** (`turn-complete` o `turn-error`). Nunca queda colgando.
5. **Los errores externos se traducen a un vocabulario estable.** El caller nunca ve stack traces, paths, puertos ni tokens.
6. **El adapter pihub real y el fake de tests satisfacen la misma Interface.**

## 7. Prohibiciones explícitas

- No exponer puertos de Runner en respuestas. *(2026-07-27: el ejemplo de
  §4.3 llevaba `"ports": { "runner": 4100 }`, contradiciendo esta regla.
  Se quitó del ejemplo, no de aquí: el dashboard nunca habla con el Runner
  —el Manager es el único punto de entrada, H01.05— así que ese puerto no
  le sirve de nada y solo filtra topología interna.)*
- No exponer paths internos del filesystem.
- No exponer WebSockets al caller del dashboard.
- No exponer valores de `PIHUB_*` o `PI_CODING_AGENT_*` en respuestas.
- No exponer tokens de servicio en logs ni en respuestas de error.

## 8. Vocabulario de errores extendido

| Código | HTTP | Significado |
|---|---|---|
| `AGENT_NOT_FOUND` | 404 | El agente especificado no existe |
| `AGENT_ALREADY_EXISTS` | 409 | Ya existe un agente con ese nombre |
| `SESSION_NOT_FOUND` | 404 | La sesión no existe o no está activa |
| `SESSION_EXPIRED` | 410 | La sesión expiró |
| `TURN_NOT_FOUND` | 404 | El turno no existe o ya terminó |
| `TURN_IN_PROGRESS` | 409 | Hay un turno en curso que la operación pedida tumbaría |
| `MODEL_FORBIDDEN` | 403 | El modelo no está permitido para el dueño del agente |
| `RESOURCE_UNAVAILABLE` | 503 | El servicio está temporalmente no disponible |
| `VOICE_PROVIDER_ERROR` | 502 | Fallo del proveedor de voz |
| `INTERNAL_ERROR` | 500 | Error interno del Manager |
| `MISSING_AUTH` | 401 | Credencial de servicio ausente |
| `INVALID_AUTH` | 401 | Credencial de servicio inválida |
| `CSRF_REQUIRED` | 403 | Falta CSRF en una mutación de panel |
| `CSRF_INVALID` | 403 | CSRF u Origin inválido |
| `ROTATED_AUTH` | 401 | Credencial de servicio rotada |
| `BAD_REQUEST` | 400 | Payload no válido |
| `PAYLOAD_TOO_LARGE` | 413 | El fichero supera el límite del Runner. Código propio, y no `BAD_REQUEST`, porque el caller necesita distinguir "pasa del límite" de "la petición es inválida" para decírselo al usuario — y el mensaje no es contrato, el catálogo sí |
| `CONFLICT` | 409 | Conflicto de estado |
| `GONE` | 410 | Recurso eliminado permanentemente |
