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
| Turnos de chat con streaming de eventos | Variables de entorno arbitrarias |
| Health y readiness | Paquetes/extensiones (`pi install/remove`) |
| Service auth (creencial de servicio) | Modelos disponibles (`/api/models`) |

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
| `TURN_IN_PROGRESS` | Ya hay un turno en curso para esta sesión |
| `MODEL_FORBIDDEN` | El modelo no está permitido para el dueño del agente |
| `RESOURCE_UNAVAILABLE` | El servicio está temporalmente no disponible |
| `INTERNAL_ERROR` | Error interno del Manager (nunca se expone al caller) |
| `MISSING_AUTH` | Credencial de servicio ausente |
| `INVALID_AUTH` | Credencial de servicio inválida |
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

Response `201`:
```json
{
  "name": "mi-agente",
  "status": "running",
  "model": "anthropic/claude-sonnet-4-20250514",
  "webAddress": "mi-agente.agents.miempresa.com"
}
```

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

`telegramToken` es opcional: si se omite, conserva el valor actual; un string lo
reemplaza y `null` quita el bot. El token nunca aparece en la respuesta. Si el
Agent estaba `running`, cambiar o quitar el token detiene y vuelve a arrancar su
Runner antes de responder, porque el Runner crea el long-polling de Telegram al
arrancar y no puede cambiar de credencial en caliente. Reenviar el mismo valor,
incluso al reconciliar otros campos, no reinicia el Runner. Si el Agent estaba
parado, solo se persiste el cambio y el siguiente arranque usará el nuevo valor.

Response `200`:
```json
{
  "name": "mi-agente",
  "status": "stopped",
  "model": "anthropic/claude-haiku-3-20250320",
  "telegram": false
}
```

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
POST   /api/v1/agents/:name/turns     — Ejecutar turno
GET    /api/v1/agents/:name/turns/:id — Leer estado del turno
```

#### POST /api/v1/agents/:name/turns

Request:
```json
{
  "sessionKey": "abc-def-123",
  "turnId": "turn-001",
  "idempotencyKey": "idem-001",
  "correlationId": "req-xyz789",
  "message": "¿Qué sabes sobre X?",
  "abortSignal": false
}
```

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
| Fichero ausente, inválido o mayor de 50 MB | `400` con `BAD_REQUEST` |
| Runner parado o inaccesible | `503` con `RESOURCE_UNAVAILABLE` |

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
3. **La cancelación cruza toda la cadena** mediante `AbortSignal` (campo booleano en request o header `X-Abort: true`).
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
| `TURN_IN_PROGRESS` | 409 | Ya hay un turno en curso para esta sesión |
| `MODEL_FORBIDDEN` | 403 | El modelo no está permitido para el dueño del agente |
| `RESOURCE_UNAVAILABLE` | 503 | El servicio está temporalmente no disponible |
| `INTERNAL_ERROR` | 500 | Error interno del Manager |
| `MISSING_AUTH` | 401 | Credencial de servicio ausente |
| `INVALID_AUTH` | 401 | Credencial de servicio inválida |
| `ROTATED_AUTH` | 401 | Credencial de servicio rotada |
| `BAD_REQUEST` | 400 | Payload no válido |
| `CONFLICT` | 409 | Conflicto de estado |
| `GONE` | 410 | Recurso eliminado permanentemente |
