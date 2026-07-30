# Referencia de la API privada del Manager — `/api/v1`

> **Versión:** pihub `v0.6.0`
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
| `AGENT_NOT_FOUND`, `SESSION_NOT_FOUND`, `TURN_NOT_FOUND` | 404 | Recurso inexistente/no activo |
| `SESSION_EXPIRED` | 410 | Sesión expirada |
| `AGENT_ALREADY_EXISTS`, `TURN_IN_PROGRESS` | 409 | Conflicto de estado |
| `VOICE_PROVIDER_ERROR` | 502 | Fallo del Provider de voz |
| `RESOURCE_UNAVAILABLE` | 503 | Manager/Runner temporalmente no disponible |
| `INTERNAL_ERROR` | 500 | Fallo interno; el mensaje se sanea |

Las extensiones OAuth conservan algunos cuerpos históricos `{ "error": "..." }`
en sus propios errores de flujo; no exponen detalles de Runner.

## 3. Salud y estado

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/health` | Liveness del Manager |
| `GET` | `/readiness` | Comprueba acceso al directorio de datos |
| `GET` | `/status` | Versión, pi, número de Agents y si el panel está montado |
| `GET` | `/models` | Catálogo de Models y disponibilidad de credenciales |

Ejemplos:

```json
{ "status": "ok", "version": "0.6.0", "timestamp": "..." }
```

```json
{
  "status": "ok",
  "checks": [{ "name": "data-dir", "status": "ok" }]
}
```

```json
{ "version": "0.6.0", "pi": "0.80.3", "agents": 2, "panel": true }
```

`/status` no incluye el rango de puertos de Runner ni topología interna.

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

## 7. Sesiones y turnos SSE

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

## 8. Uploads, transcribe y commands

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

## 9. OAuth de Providers

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

## 10. Rotación de token

```text
POST /auth/rotate
```

Body: `{ "oldToken": "...", "newToken": "mínimo-32-caracteres" }`.

La ruta valida el formato y el token actual, pero **no rota en memoria**:
responde `503 RESOURCE_UNAVAILABLE` porque una rotación efectiva exige cambiar
el entorno persistente y reiniciar el Manager. No trates un `200` inexistente
como confirmación de rotación.

## 11. Invariantes

1. El Manager es el único puente hacia un Runner.
2. Los secretos no salen en respuestas, URLs ni errores.
3. Las operaciones que reiniciarían/pararían un Runner no interrumpen turnos
   vivos: responden `TURN_IN_PROGRESS`.
4. El panel usa cookie+CSRF; un dashboard usa Bearer.
5. La idempotencia, las sesiones de Runner y SSE son estado efímero del
   Manager/Runner, no una cola durable.
6. `/api/v1` no debe ganar capacidades nuevas sin documentación y pruebas de
   contrato contra un Manager real.
