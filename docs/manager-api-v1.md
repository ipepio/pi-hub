# Referencia de la API privada del Manager — `/api/v1`

> **Versión:** pihub `v0.8.0`
>
> **Estado:** implementada y consumida por el panel y por el dashboard.
>
> **Frontera:** HTTP y SSE; no hay código compartido con un control plane.

## 1. Propósito y límites

`/api/v1` administra Agents dentro de un Runtime pihub. El Manager es el único
punto de entrada: traduce la configuración persistente y los turnos hacia los
Runners internos. Un caller no recibe ni necesita puertos, PID, paths,
WebSockets, valores de env ni tokens de Telegram.

La API tiene dos clases de consumidor:

| Consumidor | Auth | Uso |
|---|---|---|
| Dashboard/control plane | `Authorization: Bearer <API_TOKEN>` | Runtime gobernado, CRUD, reconcile y turnos `basic` |
| Panel pihub | Cookie same-origin + CSRF | Runtime gobernador, UI, recursos y turnos `verbose` |

Las rutas `/api/*` antiguas siguen existiendo solo para compatibilidad del CLI
actual. No forman parte de este contrato ni deben usarse por una integración
nueva.

## 2. Autenticación

### Bearer de servicio

Todas las rutas v1 exigen Bearer válido para un caller de servicio:

```http
Authorization: Bearer <API_TOKEN>
```

| Caso | HTTP | Código |
|---|---:|---|
| No hay Bearer ni cookie de panel válida | 401 | `MISSING_AUTH` |
| Bearer presente e inválido | 401 | `INVALID_AUTH` |
| Bearer válido | según método | — |

Un Bearer inválido **no** cae como fallback a una cookie válida.

### Sesión del panel

`POST /auth/session` no pertenece al prefijo v1: recibe el `API_TOKEN`, emite
la cookie HttpOnly `pihub_token`, rota `pihub_csrf` y devuelve:

```json
{ "ok": true, "csrfToken": "..." }
```

Una cookie válida autoriza lecturas v1. Para `POST`, `PUT`, `PATCH` y `DELETE`,
el panel añade `X-CSRF-Token` con el valor de la cookie `pihub_csrf`. Si la
petición tiene `Origin`, debe ser el mismo origen del Manager.

| Caso de panel | HTTP | Código |
|---|---:|---|
| Cookie válida, lectura | 200 | — |
| Mutación sin CSRF | 403 | `CSRF_REQUIRED` |
| CSRF u Origin incorrecto | 403 | `CSRF_INVALID` |

El token de servicio no sale en el JavaScript ni en respuestas del panel.

### Envelope de error

Los errores versionados usan:

```json
{
  "code": "AGENT_NOT_FOUND",
  "message": "Agent not found",
  "correlationId": "uuid"
}
```

`correlationId` toma `X-Correlation-Id` si llega; de lo contrario lo genera el
Manager. El catálogo y status HTTP son:

| Código | HTTP | Significado |
|---|---:|---|
| `BAD_REQUEST` | 400 | Payload o parámetro inválido |
| `PAYLOAD_TOO_LARGE` | 413 | Audio o fichero excede el límite del Runner |
| `MISSING_AUTH`, `INVALID_AUTH`, `ROTATED_AUTH` | 401 | Problema de autenticación |
| `MODEL_FORBIDDEN`, `CSRF_REQUIRED`, `CSRF_INVALID` | 403 | Operación no permitida o protección CSRF |
| `AGENT_NOT_FOUND`, `SESSION_NOT_FOUND`, `TURN_NOT_FOUND`, `INITIATIVE_NOT_FOUND`, `TRIGGER_NOT_FOUND` | 404 | Recurso inexistente/no activo |
| `SESSION_EXPIRED` | 410 | Sesión expirada |
| `AGENT_ALREADY_EXISTS`, `TURN_IN_PROGRESS`, `INITIATIVE_STATE_CONFLICT`, `IDEMPOTENCY_CONFLICT` | 409 | Conflicto de estado |
| `VOICE_PROVIDER_ERROR` | 502 | Fallo del Provider de voz |
| `RESOURCE_UNAVAILABLE` | 503 | Manager/Runner temporalmente no disponible, o admisión no disponible (P4) |
| `INTERNAL_ERROR` | 500 | Fallo interno; el mensaje se sanea |

Las extensiones OAuth conservan algunos cuerpos históricos `{ "error": "..." }`
en sus propios errores de flujo; no exponen detalles de Runner.

## 3. Salud y estado

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/health` | Liveness del Manager |
| `GET` | `/readiness` | Comprueba acceso al directorio de datos |
| `GET` | `/status` | Versión, pi, número de Agents y si el panel está montado |
| `GET` | `/models` | Catálogo de Models y disponibilidad de credenciales; fallo de lectura: `503 RESOURCE_UNAVAILABLE` |
| `GET` | `/providers` | Catálogo observado de Runtime Provider Connections; fallo de lectura: `503 RESOURCE_UNAVAILABLE` |
| `PUT` | `/managed/providers` | Reemplaza la proyección managed (solo Bearer de servicio) |
| `PUT` | `/providers/custom/:providerId` | Define/actualiza un Provider custom |
| `DELETE` | `/providers/custom/:providerId` | Revoca y elimina un Provider custom |

Ejemplos:

```json
{ "status": "ok", "version": "0.8.0", "timestamp": "..." }
```

```json
{
  "status": "ok",
  "checks": [{ "name": "data-dir", "status": "ok" }]
}
```

```json
{ "version": "0.8.0", "pi": "0.80.3", "agents": 2, "panel": true }
```

`/status` no incluye el rango de puertos de Runner ni topología interna.

### Providers y Runtime Provider Connections

`GET /providers` devuelve únicamente estado observado y redactado:

```json
{
  "providers": [{
    "id": "provider-id",
    "name": "Provider",
    "origin": "built_in | models_json | managed | extension",
    "authMethods": ["api_key"],
    "status": "connected | missing_credentials | error",
    "models": [{ "provider": "provider-id", "id": "model", "name": "Model", "configured": true }],
    "capabilities": []
  }]
}
```

Una **Runtime Provider Connection** es la conexión efectiva de un Provider
para este User Runtime; no crea un Model global ni evita las políticas del
Dashboard. `managed` es propiedad del estado deseado enviado por el dashboard;
`built_in`, `models_json` y `extension` pertenecen al Runtime standalone.

El contrato de lectura de `/models` y `/providers` es binario: `200` significa
que el catálogo se leyó correctamente, y una lista vacía significa siempre que
el catálogo está vacío de verdad, nunca un fallo. Un `503 RESOURCE_UNAVAILABLE`
significa que no se pudo leer el catálogo; el envelope es el estándar
`{ code, message, correlationId }`, y el detalle real del fallo va al log del
Manager, nunca al caller.

`PUT /managed/providers` recibe el reemplazo completo:

```json
{ "providers": [{
  "id": "dashboard-provider",
  "baseUrl": "https://api.example/v1",
  "models": [{ "id": "chat", "name": "Chat" }],
  "apiKey": "solo-en-la-mutación"
}]}
```

Esta ruta exige Bearer de servicio aunque el resto de `/api/v1` admita lecturas
con cookie del panel. Solo sustituye entradas `managed`, conserva Providers
standalone y credenciales OAuth, escribe de forma atómica y devuelve el estado
observado sin `apiKey`, paths ni errores crudos. La operación es idempotente.

Los endpoints `custom` separan definición y credencial: la API key solo se
acepta en la mutación y se guarda mediante `AuthStorage`; nunca se mezcla con
`models.json`, se serializa en una respuesta ni se escribe en logs.

## 4. Agents y ciclo de vida

### Métodos

| Método | Ruta | Resultado |
|---|---|---|
| `GET` | `/agents` | Lista proyecciones seguras de Agents |
| `POST` | `/agents` | Crea y arranca un Agent |
| `GET` | `/agents/:name` | Detalle seguro, persona, claves env y paquetes |
| `PATCH` | `/agents/:name` | Actualiza configuración declarativa |
| `DELETE` | `/agents/:name` | Para y elimina Agent y datos |
| `POST` | `/agents/:name/start` | Habilita y arranca |
| `POST` | `/agents/:name/stop` | Deshabilita y para |
| `POST` | `/agents/:name/restart` | Reinicia sin cambiar `enabled` |

Crear:

```json
{
  "name": "mi-agent",
  "model": "provider/model",
  "thinkingLevel": "low",
  "systemPrompt": "Eres útil.",
  "telegramToken": "...",
  "ttsVoice": "alloy",
  "memory": { "sharedAccess": "read" },
  "packages": ["npm:@scope/package"]
}
```

`name` usa `[a-z0-9][a-z0-9-]*`, máximo 64 caracteres. `model` es opcional y
usa `PIHUB_DEFAULT_MODEL` si falta. Las respuestas de listado y ciclo de vida
incluyen `name`, `model`, `state`, `status`, `enabled` y `telegram` (booleano),
pero nunca el token Telegram, el PID o el puerto.

El detalle añade `systemPrompt`, `envKeys` y `packages`; esos campos no van en
el listado para no volcar prompts ni configuración de todos los Agents.

Actualizar acepta campos opcionales:

```json
{
  "model": "provider/otro-model",
  "thinkingLevel": "high",
  "systemPrompt": "Nueva persona.",
  "telegramToken": null,
  "ttsVoice": null,
  "memory": null,
  "enabled": false
}
```

`null` limpia `telegramToken`, `ttsVoice` o el override de `memory`. El Manager
compara la huella efectiva (modelo, thinking, persona, Telegram, voz, memoria,
env y paquetes). Un Runner en ejecución se reinicia solo cuando esa huella
cambia. Un Agent parado no se inicia por un PATCH salvo que `enabled:true` lo
pida. Si una actualización, parada o reinicio cortaría un turno vivo, responde
`409 TURN_IN_PROGRESS` antes de persistir cambios.

`DELETE` responde `204` sin cuerpo.

## 5. Variables de entorno

Las lecturas devuelven solo claves. Nunca devuelven valores. `API_TOKEN`,
`PIHUB_*` y `PI_CODING_AGENT_*` son claves protegidas.

| Método | Ruta | Body | Semántica |
|---|---|---|---|
| `GET` | `/agents/:name/env` | — | Claves del Agent |
| `PUT` | `/agents/:name/env` | `{ "env": { "KEY": "value" } }` | Reemplaza todo el store del Agent |
| `PUT` | `/agents/:name/env/:key` | `{ "value": "..." }` | Fija una clave del Agent |
| `DELETE` | `/agents/:name/env/:key` | — | Elimina una clave del Agent |
| `GET` | `/env` | — | Claves del store global |
| `PUT` | `/env/:key` | `{ "value": "..." }` | Fija una clave global |
| `DELETE` | `/env/:key` | — | Elimina una clave global |

Todas las respuestas son `{ "keys": ["..."] }`. El reemplazo completo de un
Agent es apropiado para un control plane que conoce el conjunto de secretos;
las operaciones por clave son las usadas por el panel para no sobrescribir
valores que no puede leer.

Un cambio real de env de Agent reinicia ese Runner si estaba en marcha. Un
cambio global agenda el reinicio de los Runners activos sin bloquear la
respuesta. Las mutaciones que afectarían a un Agent con turno vivo responden
`TURN_IN_PROGRESS`.

## 6. Paquetes y extensiones

| Método | Ruta | Body | Semántica |
|---|---|---|---|
| `GET` | `/agents/:name/packages` | — | Lista paquetes de un Agent |
| `PUT` | `/agents/:name/packages` | `{ "packages": ["source"] }` | Converge el conjunto completo |
| `POST` | `/agents/:name/packages` | `{ "source": "..." }` | Instala un paquete de Agent |
| `DELETE` | `/agents/:name/packages` | `{ "source": "..." }` | Elimina un paquete de Agent |
| `GET` | `/packages` | — | Lista paquetes globales |
| `POST` | `/packages` | `{ "source": "..." }` | Instala uno global |
| `DELETE` | `/packages` | `{ "source": "..." }` | Elimina uno global |

Las mutaciones responden `202` con `{ "packages": [...] }`. Un `PUT` sin
diferencia también responde `202`, pero no ejecuta pi ni reinicia. La
instalación/eliminación de un Agent con turno vivo se rechaza con
`TURN_IN_PROGRESS`; los cambios globales recargan Runners activos en diferido.

## 7. Skills desde contenido

Estas rutas son distintas de `/packages`: sirven para una **Skill** que el
dashboard ya almacena y asigna explícitamente. El dashboard aporta siempre su
`skillId` UUID; pihub no crea una segunda identidad ni devuelve el path local
que pi guarda en `settings.json`.

| Método | Ruta | Body | Semántica |
|---|---|---|---|
| `GET` | `/agents/:name/skills` | — | Lista `skillId` instalados solo para el Agent |
| `POST` | `/agents/:name/skills` | contenido | Instala/actualiza una Skill local al Agent |
| `DELETE` | `/agents/:name/skills/:skillId` | — | Quita la referencia pi y el contenido local |
| `GET` | `/skills` | — | Lista `skillId` instalados para todo el Runtime |
| `POST` | `/skills` | contenido | Instala/actualiza una Skill global |
| `DELETE` | `/skills/:skillId` | — | Quita la referencia pi y el contenido global |

La respuesta de todas las rutas es `202 { "skills": ["<skillId>"] }` en
mutaciones y `200` con la misma forma en lecturas. No incluye `source`,
`settings.json` ni ningún path de `/data`. Las Skills de contenido tampoco
aparecen por `/packages` ni en el campo `packages` de un Agent: esa superficie
solo enumera fuentes URL/npm/git que el caller puede manejar sin conocer la
topología del Runtime.

### Contenido JSON

```json
{
  "skillId": "0d1c80cf-7889-4ab6-9a5c-8d5b32b3b530",
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\nname: revisar\ndescription: Revisa cambios.\n---\n\n# Revisar\n"
    },
    { "path": "references/checklist.md", "content": "# Checklist\n" }
  ]
}
```

`path` es relativo a la raíz de la Skill; `SKILL.md` debe existir exactamente
en esa raíz. Se rechazan paths absolutos, `..`, backslashes, NUL y duplicados.
Cada fichero admite hasta 5 MiB y el total hasta 20 MiB.

### ZIP multipart

Para contenido binario o varios ficheros, `POST` acepta `multipart/form-data`
con los campos `skillId` y `archive` (un ZIP). El ZIP tiene los mismos límites
descomprimidos: pihub comprueba el tamaño declarado de cada entry y el total
**antes** de descomprimir; rechaza symlinks, traversal, paths duplicados y ZIP
corruptos. Los ficheros se escriben como ficheros regulares no ejecutables.

pihub materializa el contenido de modo persistente, separado por scope, como un
package local convencional de pi: `skills/<skillId>/SKILL.md`. La razón es que
pi `0.80.3` registra `pi install ./ruta` por referencia y no copia la ruta.
Una actualización con el mismo `skillId` reemplaza el árbol persistente sin
duplicar settings ni volver a ejecutar `pi install`; el reinicio hace que el
Runner cargue el contenido nuevo. `DELETE` ejecuta `pi remove` sobre la ruta
interna antes de borrar ese árbol.

Una mutación local se rechaza con `TURN_IN_PROGRESS` si ese Agent tiene un turno
vivo. Una mutación global se rechaza si cualquier Agent tiene un turno vivo,
porque la recarga alcanza a todos los Runners. Si no lo hay, los Runners que
corresponden se recargan en diferido.

Un ZIP puede llevar assets o documentación auxiliar, pero pi no ejecuta
`npm install` para un source local: no interpretes incluir `package.json` como
instalación automática de dependencias.

## 8. Sesiones y turnos SSE

### Sesión declarada

```text
POST /agents/:name/sessions
```

Body:

```json
{ "channel": "web", "sessionKey": "clave-estable" }
```

Responde `201` con `{ key, channel, agent, createdAt }`. El panel no necesita
llamar a esta ruta: genera y rota `sessionKey` localmente. La identidad real de
contexto la aplica el Runner cuando el Manager abre el puente de turno.

### Crear turno

```text
POST /agents/:name/turns?eventProfile=basic|verbose
```

Body obligatorio:

```json
{
  "sessionKey": "clave-estable",
  "turnId": "turn-001",
  "idempotencyKey": "idem-001",
  "correlationId": "req-001",
  "message": "Hola"
}
```

`eventProfile` omiso equivale a `basic`; cualquier otro valor da
`BAD_REQUEST`. El Manager conserva la primera asociación de cada
`idempotencyKey` por instancia: un reintento devuelve JSON
`{ "turnId": "...", "duplicate": true }` y no vuelve a ejecutar el prompt.

Una ejecución nueva devuelve `text/event-stream`:

```text
event: turn-start
data: {"turnId":"turn-001"}

event: chunk
data: {"turnId":"turn-001","delta":"Hola"}

event: turn-complete
data: {"turnId":"turn-001","totalTokens":0}
```

Eventos presentes en ambos perfiles:

| Evento | Payload |
|---|---|
| `turn-start` | `{ turnId }` |
| `chunk` | `{ turnId, delta }` |
| `turn-complete` | `{ turnId, totalTokens: 0 }` |
| `turn-aborted` | `{ turnId }` |
| `turn-error` | `{ turnId, code, message }` |

`totalTokens` es `0` porque el Runner no reporta consumo; no es una medición.
El perfil `verbose` agrega:

| Evento | Payload |
|---|---|
| `thinking-delta` | `{ turnId, delta }` |
| `tool-start` | `{ turnId, toolName }` |
| `tool-end` | `{ turnId, toolName, isError }` |

El Manager sanea el nombre de una tool y nunca retransmite el texto crudo de
un error del Runner. Si el Runner se cierra inesperadamente sin evento final,
el stream puede finalizar sin terminal; el panel lo muestra como stream perdido
y ofrece reintentar explícitamente. No hay replay durable de SSE.

### Cancelar turno

```text
POST /agents/:name/turns/:turnId/abort
```

Responde `202` sin cuerpo y marca el turno como cancelado antes de enviar el
comando interno. El siguiente final o cierre del WebSocket se traduce a
`turn-aborted`. Si no hay turno vivo, responde `404 TURN_NOT_FOUND`.

`abortSignal` del body se acepta solo por compatibilidad y no cancela nada. No
hay `GET /turns/:id`: los turnos son efímeros por instancia.

## 9. Uploads, transcribe y commands

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/agents/:name/uploads` | Multipart `file` al workspace del Agent |
| `POST` | `/agents/:name/transcribe` | Multipart `file` hacia el Provider STT del Runner |
| `GET` | `/agents/:name/commands` | Skills y prompt templates del Agent |

`uploads` responde:

```json
{
  "path": "uploads/uuid-informe.csv",
  "name": "informe.csv",
  "size": 1234,
  "type": "text/csv"
}
```

`path` es siempre relativo al workspace. El límite actual de upload lo aplica
el Runner (50 MB); un exceso se traduce a `413 PAYLOAD_TOO_LARGE`.

`transcribe` devuelve `{ "text": "..." }`. Sin STT configurado devuelve
`501 { "error": "STT no configurado" }`; audio demasiado grande es
`PAYLOAD_TOO_LARGE` y fallo de Provider es `VOICE_PROVIDER_ERROR`.

`commands` devuelve `{ "skills": [...], "prompts": [...] }`. Un Runner
parado, inaccesible o con respuesta inválida devuelve `RESOURCE_UNAVAILABLE`.

## 10. OAuth de Providers

Estas rutas son extensiones del panel/operador, no parte de la interfaz de
ejecución del dashboard:

```text
GET  /auth/providers
POST /auth/login/:provider
GET  /auth/flows/:id
POST /auth/flows/:id/input
POST /auth/logout/:provider
```

Están habilitadas por `PIHUB_OAUTH_PROVIDERS`. Usan la misma auth dual de v1:
Bearer para servicio o cookie + CSRF para panel.

## 11. Rotación de token

```text
POST /auth/rotate
```

Body: `{ "oldToken": "...", "newToken": "mínimo-32-caracteres" }`.

La ruta valida el formato y el token actual, pero **no rota en memoria**:
responde `503 RESOURCE_UNAVAILABLE` porque una rotación efectiva exige cambiar
el entorno persistente y reiniciar el Manager. No trates un `200` inexistente
como confirmación de rotación.

## 11.5. Autonomía de Agents (Loop, Agenda, Initiative, Trigger)

Añadido en P2 y cerrado con P3 (ask_human, waiting_human, entrega por Telegram).
Rutas para leer y mutar el estado de autonomía de un Agent.

**Auth por modo:**

| Modo | Principal | Lectura Autonomía | Mutación Autonomía | Autoridad efectiva |
|---|---:|---:|---|
| Gobernador | Bearer válido (`service`) | permitido | permitido, sin CSRF | `owner` |
| Gobernador | cookie válida (`panel`) | permitido | solo con CSRF + same-origin | `owner` |
| Gobernado | Bearer válido (`service`) | permitido | permitido, sin CSRF | `control_plane` |
| Gobernado | cookie o antigua (`panel`) | `401 INVALID_AUTH` | `401 INVALID_AUTH` | nunca llega a Control |
| Ambos | Bearer inválido + cookie | `401 INVALID_AUTH` | `401 INVALID_AUTH` | nunca llega a Control |

Todos los timestamps son epoch **milliseconds** enteros o `null`. No se mezcla
ISO 8601 con epoch dentro del mismo recurso.

### Snapshot público

```text
GET /api/v1/agents/:name/autonomy
```

`200` — snapshot completo del Agent:

```json
{
  "asOf": 1712345678000,
  "initiatives": [...],
  "agenda": [{"position": 1, "initiative": {...}}],
  "inbox": [...],
  "triggers": [...],
  "historyTruncated": false
}
```

**PublicInitiative:**

```json
{
  "id": "uuid",
  "origin": "trigger|callback|human",
  "triggerId": "uuid|null",
  "status": "queued|running|waiting_human|waiting_agent|succeeded|failed|expired|cancelled",
  "mode": "solo|ask",
  "intent": "string",
  "summary": "string|null",
  "question": "string|null",
  "notificationStatus": "delivered|not_delivered|null",
  "availableAt": 1712345678000,
  "createdAt": 1712345678000,
  "stateChangedAt": 1712345678000,
  "startedAt": 1712345678000|null,
  "finishedAt": 1712345678000|null,
  "expiresAt": 1712345678000|null,
  "failureReason": "turn_failed|null|unknown"
}
```

`failureReason` solo contiene literales del catálogo (`turn_failed`,
`runner_unavailable`, `dispatch_failed`, `agent_errored`,
`chain_deadline_exceeded`, `startup_recovery`) o `"unknown"` para cualquier
otro valor interno. `result` **no se publica**.

**Modo `ask` y espera humana (P3).** Una Initiative en `mode:"ask"` puede
pausarse pidiendo input humano con la tool `ask_human` del Agent: pasa a
`waiting_human`, la pregunta queda en `question`, el contexto en `summary` y la
cota de respuesta en `expiresAt` (epoch ms). Esa Initiative entra en `inbox`
del snapshot. La espera es durable (sobrevive al reinicio del Manager) y se
retoma reencolando a `queued` cuando el humano responde por el panel o por el
canal primario de Telegram.

`notificationStatus` solo se puebla en `waiting_human`:

- `null` — no hay espera humana (cualquier otro estado o sin request).
- `not_delivered` — espera activa sin entrega confirmada (reserva de envío
  pendiente, canal primario no configurado o envío fallido).
- `delivered` — el canal primario de Telegram confirmó un `message_id` real
  para la tarjeta de la espera actual.

Sin `PIHUB_TELEGRAM_PRIMARY_CHAT_ID` no hay llamadas a Telegram en absoluto
(fail-closed): la entrega es best-effort y el panel es el inbox canónico; el
botón de responder sigue disponible aunque la notificación no llegara. Nunca
salen `human_request_id`, chat/message IDs, tokens ni textos de error.

**PublicTrigger:**

```json
{
  "id": "uuid",
  "kind": "daily|weekly|interval",
  "definition": {"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"},
  "intent": "string",
  "mode": "solo|ask",
  "suggestedSkill": "string|null",
  "createdBy": "owner|control_plane|agent",
  "authority": "owner|control_plane",
  "proposalState": "proposed|approved|null",
  "enabled": true,
  "nextFireAt": 1712345678000|null,
  "lastFiredAt": 1712345678000|null,
  "createdAt": 1712345678000,
  "updatedAt": 1712345678000
}
```

`definition` es siempre una de las tres formas exactas:

```json
{"version":1,"kind":"interval","intervalMs":60000}
{"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"}
{"version":2,"kind":"weekly","timeZone":"Europe/Madrid","at":"09:00","days":["mon","wed","fri"]}
```

### Crear Trigger

```text
POST /api/v1/agents/:name/triggers
Idempotency-Key: <obligatorio, header>
```

Body estricto (Zod `.strict()`, claves extra rechazadas):

```json
{
  "definition": {"version":2,"kind":"daily","timeZone":"Europe/Madrid","at":"09:00"},
  "intent": "revisar cada mañana",
  "mode": "solo",
  "suggestedSkill": null
}
```

| Estado | HTTP | Body |
|---|---|---|
| Creación nueva | `201` | `{trigger, replayed:false}` |
| Idempotencia (misma key, mismo comando) | `200` | `{trigger, replayed:true}` |
| Key reutilizada con comando distinto | `409` | `IDEMPOTENCY_CONFLICT` |

### Revocar Trigger

```text
POST /api/v1/agents/:name/triggers/:id/revoke
```

Sin body contractual. Repetir sobre un trigger ya revocado mantiene `200`.

| Estado | HTTP | Body |
|---|---|---|
| Revocado | `200` | `{trigger}` con `enabled:false` |
| Inexistente o de otro Agent | `404` | `TRIGGER_NOT_FOUND` |

### Cancelar Initiative

```text
POST /api/v1/agents/:name/initiatives/:id/cancel
```

Sin body contractual.

| Estado | HTTP | Body |
|---|---|---|
| Initiative queued/terminal | `200` | `{status:"cancelled", initiative}` |
| Initiative running | `202` | `{status:"cancellation_requested", initiative}` |
| Inexistente o de otro Agent | `404` | `INITIATIVE_NOT_FOUND` |
| Conflicto de estado (CAS) | `409` | `INITIATIVE_STATE_CONFLICT` |

### Responder a Initiative

```text
POST /api/v1/agents/:name/initiatives/:id/respond
Idempotency-Key: <obligatorio, header>
```

Body:

```json
{
  "answer": "sí, procede",
  "expectedHumanRequestId": "uuid|null"
}
```

`answer` usa exactamente `1..4000` caracteres (cota `MAX_HUMAN_ANSWER_LENGTH`
del dominio). `expectedHumanRequestId` es **opcional** (P3.2): si se envía, la
respuesta solo aplica a la espera humana con ese request id (CAS) y una
respuesta a una tarjeta/espera anterior ya no contesta una Ask nueva; ausente
o `null` conserva el comportamiento previo. El panel lo envía con el request
que muestra. Responder a una espera ya expirada responde
`409 INITIATIVE_STATE_CONFLICT` aunque el barrido de expiración no haya
corrido todavía.

| Estado | HTTP | Body |
|---|---|---|
| Respuesta nueva | `200` | `{initiative, replayed:false}` |
| Idempotencia | `200` | `{initiative, replayed:true}` |
| Inexistente o de otro Agent | `404` | `INITIATIVE_NOT_FOUND` |
| Conflicto de estado | `409` | `INITIATIVE_STATE_CONFLICT` |
| Key con comando distinto | `409` | `IDEMPOTENCY_CONFLICT` |

### Callback interno del Runner (fuera del contrato)

El Manager monta `POST /internal/runner/telegram-reply`, la vía **interna** por
la que un Runner devuelve las respuestas escritas en el chat primario de
Telegram. No es parte de `/api/v1` ni una API de integración: se autentica con
un token efímero por spawn (`x-pihub-runner-callback-token`), no acepta
Bearer/cookie/CSRF y ningún caller externo debe usarla. La correlación es
interna (chat/message de la tarjeta → `human_request_id` →
`expectedHumanRequestId` del CAS de respond); el contrato público solo expone
el resultado observado vía `notificationStatus`.

### Admisión (shell contractual, P4)

```text
GET  /api/v1/runtime/admission
PUT  /api/v1/runtime/admission
```

**En P2 ambas responden `503 RESOURCE_UNAVAILABLE`** porque el port de
admisón está ausente. El contrato está congelado (misma ruta, misma auth
por modo, mismo presenter), pero P4 aporta el adapter real y cambia estas
a `200` sin modificar ruta, auth, schema, presenter ni envelope.

PUT body:

```json
{"state": "open|draining"}
```

Contrato futuro (`PublicAdmissionState`):

```json
{
  "state": "open|draining",
  "idle": false,
  "activeTurns": 0,
  "runningInitiatives": 0,
  "changedAt": 1712345678000
}
```

No incluye IDs de Agent, turnos ni sesiones.

### Errores específicos de Autonomía

| Código | HTTP | Origen |
|---|---:|---|
| `INITIATIVE_NOT_FOUND` | 404 | Initiative inexistente o de otro Agent |
| `TRIGGER_NOT_FOUND` | 404 | Trigger inexistente o de otro Agent |
| `INITIATIVE_STATE_CONFLICT` | 409 | CAS/estado ya cambiado |
| `IDEMPOTENCY_CONFLICT` | 409 | misma key, comando distinto |

El resto de errores del dominio:

| Origen | HTTP | Código |
|---|---:|---|
| `TRIGGER_NOT_DISPARABLE`, payload/header inválido | 400 | `BAD_REQUEST` |
| `STORAGE_BUSY`, `STORAGE_UNAVAILABLE` o admission ausente | 503 | `RESOURCE_UNAVAILABLE` |
| `TRIGGER_AUTHORITY_CONFLICT`, invariantes, corrupción, schema | 500 | `INTERNAL_ERROR` (saneado) |
| Error no `DomainError` | 500 | `INTERNAL_ERROR` (log + correlationId) |

## 12. Invariantes

1. El Manager es el único puente hacia un Runner.
2. Los secretos no salen en respuestas, URLs ni errores.
3. Las operaciones que reiniciarían/pararían un Runner no interrumpen turnos
   vivos: responden `TURN_IN_PROGRESS`.
4. El panel usa cookie+CSRF; un dashboard usa Bearer.
5. La idempotencia, las sesiones de Runner y SSE son estado efímero del
   Manager/Runner, no una cola durable.
6. `/api/v1` no debe ganar capacidades nuevas sin documentación y pruebas de
   contrato contra un Manager real.
