# Changelog

Todas las Notables Changes (semver) se documentan aquí. El formato se basa en
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.9.1] — 2026-08-10

### Added

- **Autonomía visible por API y panel** (`1615683`, `068d2cc`, `58416c0`,
  `7bface2`, `85baffb`): la Agenda se lee como un único snapshot coherente por
  Agent; los Triggers pueden crearse (solo schedules `version: 2` en hora
  civil) y revocarse conservando su histórico; una Initiative puede cancelarse
  sin mentir sobre su estado; y una respuesta humana la vuelve a poner a
  trabajar conservando la sesión. El consumo de la respuesta ocurre en la misma
  transacción que reclama el turno: la entrega es at-least-once, una respuesta
  a mitad de carrera no se pierde en silencio.
- **API de autonomía sobre `/api/v1`** (`8c8a179`, `30b1617`): primeros
  endpoints que exponen la Agenda de un Agent y permiten cancelar o responder
  una Initiative desde fuera; una lectura sirve un snapshot de una sola
  proyección y cancelar algo en running responde 202, porque el terminal lo
  escribe quien cierra el turno. La admisión de runtime queda con rutas, schema
  y envelope congelados pero sin comportamiento (503) hasta que exista su
  adaptador.
- **Panel de autonomía** (`7d8e991`, `67e2a89`): el panel habla los mismos
  endpoints `/api/v1` con wrappers finos, y una pestaña Autonomy muestra cola,
  vuelo, histórico, Triggers y preguntas pendientes, con acciones de crear
  schedule, revocar, cancelar y responder. Las idempotency keys viajan como
  header y las aporta el llamador, nunca el cliente.
- **Presentador y documentación de la autonomía** (`b566749`, `8640df3`): los
  shapes públicos se construyen campo a campo desde una allowlist y los
  resultados de ejecución no se publican; la API queda documentada con rutas,
  DTOs, catálogo de errores y autenticación por modo de despliegue, incluyendo
  lo que aún no es real (la admisión responde 503).
- **Protocolo ask_human** (`cd9b924`, `63a7c57`): un turno sabe si viene de una
  Initiative y solo esas sesiones reciben la herramienta reservada `ask_human`;
  un manager que habla el protocolo rehúsa despachar trabajo autónomo a un
  runner que no puede pausar, y la pregunta y su resumen viajan hasta el fin de
  la ejecución de la herramienta.
- **Pausa por input humano (P3.2)** (`c62dc08`, `25c90af`, `ba250bd`,
  `876fffd`, `f01a465`): `pauseRunningForHuman` valida cotas, IDs y overflow
  antes de abrir la transacción; `human_expires_at` pasa a ser por fila y el
  Loop entrega `now` al barrido; el repositorio de human requests se cierra
  hacia delante; el CAS de respuesta impone el id de la petición y su plazo; y
  los tests prueban el rollback a medias con un disparador `BEFORE UPDATE`.
- **`waiting_human` como terminal durable (P3.3)** (`df75a14`, `b2aafad`):
  `human_input_required` se convierte en el terminal que sobrevive al reinicio
  y una Initiative en espera libera el slot del Loop sin un terminal público.
- **Entrega al canal primario de Telegram (P3.4)** (`c1d57d2`, `6ca4dbd`,
  `48c0c1c`, `9edfd5b`): se parsea y valida
  `PIHUB_TELEGRAM_PRIMARY_CHAT_ID`; el manager entrega la pregunta al chat
  primario; la proyección expone el estado de la notificación sin filtrar
  coordenadas de entrega; y el envío es fire-and-forget tras la pausa.
- **Respuestas de Telegram por ruta interna (P3.5)** (`5be15f5`, `a01326e`,
  `54d826d`): cada spawn recibe un token de callback con ámbito de Agent, el
  manager acepta las respuestas del runner por una ruta scoped interna y el
  runner deja de perder los updates pendientes.
- **Reanudación tras reinicio (P3.6)** (`f4890ff`, `7d2fdc8`): el runner
  retoma la última sesión de un hub con clave tras reiniciar y se prueba que
  una petición en `waiting_human` sobrevive al reinicio con la misma sesión.
- **Viaje P3 documentado y probado (P3.7)** (`877e7ce`, `ee5d76a`): el journey
  de trigger a terminal con variantes panel y Telegram queda cubierto por
  tests, y se documenta `ask_human`, el canal primario y la ruta interna de
  respuesta.
- **Agenda migrada a schema 2 (SQLite)** (`4839671`): nuevas columnas para
  idempotency, la pregunta humana y su plazo, correlación de entrega de
  Telegram y admisión de runtime, casi todas dormidas; las filas existentes
  sobreviven y la migración commitea DDL y `user_version` en una transacción.
- **La versión reportada es la real** (`16c5bc0`): `/health` y `/status` dejan
  de arrastrar la constante 0.8.0 y reportan la versión del paquete.

### Changed

- **Compatibilidad `/api/v1`: sigue v1** (`8640df3`): la superficie de
  autonomía es aditiva sobre la versión vigente y el contrato de éxito no
  cambia; los viajes governed y self-governed quedan cubiertos por contrato y
  una mutación hecha con una credencial es visible con la otra.
- **Allowlist de Telegram propagada al runner** (`6e92659`): la variable se
  recortaba con el prefijo `PIHUB_*` y siempre llegaba vacía (="permitir a
  cualquiera"); ahora se pasa explícitamente al runner y el arranque avisa si
  no hay allowlist configurada.

### Fixed

- **Las preguntas humanas expiraban al siguiente tick** (`359f708`): el
  barrido usaba `now` como corte y `state_changed_at` siempre está en el
  pasado; el corte pasa a ser `human_expires_at` por fila y
  `waitingHumanExpiryMs` se conserva.
- **Una cookie vieja seguía abriendo un runtime que cambió de manos**
  (`4280119`): la ruta de sesión del panel solo se monta si el panel existe,
  un runtime governed responde 404 e emite sin cookie, y una cookie de panel
  se rechaza en todo `/api/v1` en vez de ruta por ruta.

## [0.9.0] — 2026-08-06

### Added

- **Almacén durable de la Agenda** (`b128828`): la Agenda de cada Agent ahora vive en
  SQLite vía `node:sqlite`, sin dependencias nativas, conservando también el estado
  terminal de los turnos. Antes el estado vivía solo en memoria y un reinicio lo
  perdía.
- **Capa de dominio y recuperación al arranque** (`1a82bba`): los ocho estados de
  Initiative con transiciones validadas, y recuperación de lo que quedó a medias tras
  una caída. Un fallo de recuperación aborta el arranque en vez de servir con estado
  inconsistente.
- **El Loop** (`cb11ec8`): pihub barre, dispara Triggers vencidos y despacha turnos
  por sí mismo. Antes cada turno necesitaba que alguien llamara por HTTP. Dial de
  concurrencia configurable, round-robin entre Agents, y apagado que no marca como
  fallidos los turnos simplemente interrumpidos. Configurable por
  `PIHUB_LOOP_CONCURRENCY`, `PIHUB_LOOP_POLL_MS`, `PIHUB_LOOP_GRACE_MS`,
  `PIHUB_LOOP_POST_ABORT_MARGIN_MS` y `PIHUB_TURN_DISPATCH_TIMEOUT_MS`.
- **Schedules por hora civil** (`52c94e1`): `version: 2` con `daily`/`weekly`, zona
  IANA obligatoria y hora `HH:mm`. "Cada día laborable a las 09:00" antes era
  inexpresable. Los schedules `version: 1` por intervalo siguen funcionando sin
  migración de datos.

### Changed

- **Catálogo de modelos y providers**: `GET /api/v1/models` y `GET /api/v1/providers`
  devuelven 503 con el envelope estándar y código `RESOURCE_UNAVAILABLE` cuando falla
  la lectura del catálogo, en lugar de 200 con lista vacía. El contrato de éxito no
  cambia: un catálogo leído correctamente sigue devolviendo 200 y una lista vacía
  sigue significando catálogo vacío.

## [0.8.0-rc.1] — 2026-08-05

### Added

- **Providers Module**: catálogo first-class de Runtime Provider Connections,
  Providers managed y custom, OAuth y registro de Providers de Extensions.
- `PUT /api/v1/managed/providers` como proyección replace idempotente protegida
  por service token, con escrituras atómicas y recarga diferida de Runners.

### Compatibility

- `/api/v1/models`, OAuth, Agents y turnos conservan su contrato anterior de éxito.
  El camino de error de `GET /api/v1/models` y `GET /api/v1/providers` cambia: pasa de
  200 con lista vacía a 503 `RESOURCE_UNAVAILABLE`.
- La imagen se publicó como `v0.8.0-rc.1` con digest
  `sha256:703cf0fef3ff54cefaa8abd4f527f5739b91fa1af3e48452d3cf8dcf9201c2b5`.
  El dashboard la fijó con `providerProjection: managed_http` y el drill M4 de
  upgrade de flota pasó.

## [0.7.0] — 2026-08-03

### Added

- **Skills por contenido en `/api/v1`**: listado e instalación global o por Agent,
  contenido JSON y ZIP, validación de paths y límites, persistencia atómica,
  reemplazo idempotente, eliminación y protección `TURN_IN_PROGRESS`.
- Las respuestas de Skills exponen únicamente sus IDs; no filtran paths internos,
  configuraciones de pi, secretos ni errores crudos del Runner.

### Compatibility

- Se conservan sin cambios incompatibles `/api/v1/models`, OAuth, Agents, turnos,
  `/packages` y las rutas legacy `/api/*` (contrato de éxito; el camino de error de
  `GET /api/v1/models` pasa de 200 con lista vacía a 503 `RESOURCE_UNAVAILABLE`).
- OAuth de suscripción usa IDs explícitos de AuthStorage: `anthropic` y
  `openai-codex`; `openai` no es un ID OAuth válido.

## [0.6.0] — 2026-07-30

### Added

- **Panel sobre `/api/v1`**: el panel usa la API versionada con cookie
  same-origin y CSRF; ya no abre WebSockets hacia Runners ni conoce sus
  puertos. El chat usa HTTP/SSE y solicita el perfil `verbose` para mostrar
  thinking y tools saneadas.
- **Paridad v1 para el panel**: operaciones atómicas de env y paquetes de
  Agent/global, commands, transcribe, OAuth, `GET /agents/:name`, modelo
  opcional al crear, lifecycle con guard de turno vivo y abort con terminal
  `turn-aborted`.
- **Instalación como servicio**: `sudo ./scripts/install.sh` instala pihub como
  unidad de systemd en Debian/Ubuntu — arranca con la máquina, se reinicia si
  cae, y deja el código en `/opt/pihub`, los datos en `/var/lib/pihub` y la
  configuración en `/etc/pihub/pihub.env` (con un `API_TOKEN` generado). Es
  idempotente: reinstalar actualiza el código sin tocar datos ni token.
  `./scripts/uninstall.sh` lo retira conservando los agentes, o con `--purge`
  borra también sus datos.

  **Los agentes instalados así son dueños de la máquina**: administran el
  sistema, instalan paquetes y abren conexiones. Es la contrapartida deliberada
  del contenedor, donde no pueden salir de su caja. `--user <nombre>` instala con
  un usuario dedicado sin privilegios de sistema.

- **MCPs ejecutables en el contenedor**: `uv`/`uvx` en la imagen y `$HOME` dentro
  del volumen persistente. Antes `npx`/`uvx` morían con `ENOENT` porque `$HOME`
  caía en el filesystem de solo lectura, así que un MCP se instalaba pero no se
  podía ejecutar. El aislamiento no cambia.

### Changed

- **Contrato de control**: `/api/v1` es la superficie vigente para panel y
  dashboard. Las rutas `/api/*` se conservan de forma temporal para el CLI
  actual; no son el destino de integraciones nuevas.
- **Aislamiento del Runner**: los Runners arrancados por el Manager ya no heredan
  el entorno completo del contenedor. Solo reciben variables de sistema necesarias,
  los Env Stores global y del Agent (con precedencia Agent > global) y las variables
  internas de pihub. Para pasar una variable propia hay que fijarla explícitamente
  en el store; el modo standalone y sus Env Stores no cambian.

## [0.1.0] — 2025-07-16

### Added

- **Manager central**: API REST (Hono) con autenticación por token, panel web
  desactivable, y supervisor de procesos con auto-restart.
- **Runner por agente**: proceso Node.js individual con chat WebSocket con
  streaming token-a-token, comandos de chat (`/model`, `/new`, `/status`,
  `/stop`, `/help`), y soporte para skills y prompt templates.
- **Agentes independientes**: cada uno con su propio system prompt (`SYSTEM.md`),
  modelo, memoria y paquetes. Creación/edición/borrado por API, CLI o panel.
- **Memoria persistente**:
  - Agent Memory privada por agente (`memory_save` / `memory_read` /
    `memory_delete`).
  - Shared Memory configurable por agente con niveles `none` | `read` |
    `read-write`.
  - Índice automático `MEMORY.md` regenerado en cada escritura.
  - Bloqueo con file-lock para concurrencia segura.
- **Modelos custom** (`models.json`): soporte para proveedores no estándar con
  interpolación de `${VAR}` en API keys.
- **Telegram**: bot con comandos (`/new`, `/status`, `/model`, `/stop`) y
  lenguaje natural. Control de usuarios permitidos.
- **Voz (STT/TTS)**: transcripción de audio (whisper) y síntesis (kokoro) vía
  servidores OpenAI-compatible. Micrófono en chat web, notas de voz en Telegram.
- **Archivos desde chat**: botón `+` para adjuntar archivos (texto inline,
  binarios a `workspace/uploads/` con retención configurable).
- **Provisión declarativa**: manifiesto JSON (`PIHUB_AGENTS_FILE`) idempotente
  que crea/actualiza agentes al arrancar, con interpolación de variables.
- **CLI `pihub`**: cliente completo de la API — `agent create/update/list/rm`,
  `install/remove` paquetes, `env set/unset/list`, `models`, `login/logout`.
- **OAuth**: flujo de autorización para suscripciones (Claude Pro/Max, ChatGPT)
  con tokens auto-refresh.
- **Variables de entorno**: gestión por agente y global, con protección de
  keys del sistema (`API_TOKEN`, `PIHUB_*`, `PI_CODING_AGENT_*`).
- **Paquetes**: instalación de extensiones, skills, prompts y templates en
  ámbitos global y por agente, vía npm/git/local.
- **Docker**: Dockerfile (Ubuntu 24.04 + Node 22) y docker-compose.yml con
  volumen persistente `/data`.
- **Documentación**: README completo, CONTRIBUTING.md, ADRs (8), design brief,
  especificaciones de features, CHANGELOG.
- **Tests**: suite de tests para env, memoria, prompt, agentes, provisión,
  supervisor, markdown y agent-channel.

### Architecture Decisions

- ADR-0001: Loop central en el manager
- ADR-0002: Interacción asíncrona con callbacks
- ADR-0003: Sesión aislada por iniciativa
- ADR-0004: Dispatcher loop único
- ADR-0005: Auto-enqueue solo vía trigger
- ADR-0006: Canal de iniciativa interno
- ADR-0007: Iniciativas en running fallan al arrancar
- ADR-0008: Callback lleva resultado y continuación
