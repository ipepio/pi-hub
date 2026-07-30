# Changelog

Todas las Notables Changes (semver) se documentan aquí. El formato se basa en
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
