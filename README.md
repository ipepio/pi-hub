<div align="center">

# pihub

**Plataforma multi-agente autoalojada construida sobre [pi](https://pi.dev)**

Levanta y orquesta N agentes de IA, cada uno con su propia persona, modelo,
recursos y memoria — todo en un contenedor Docker.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥22](https://img.shields.io/badge/Node.js-≥22-brightgreen.svg)](https://nodejs.org/)
[![pi](https://img.shields.io/badge/Built%20on-pi-black.svg)](https://pi.dev)

</div>

---

## Qué es pihub

pihub es una plataforma web autoalojada para levantar y orquestar múltiples
agentes de IA. Cada agente tiene:

- **Su propia persona** — system prompt en `SYSTEM.md`
- **Su propio modelo** — cualquier proveedor soportado por pi, incluyendo
  `models.json` custom (Ollama, vLLM, proxies…)
- **Sus propios recursos** — extensiones, skills, prompts y templates (paquetes
  pi por agente + ámbito global compartido)
- **Memoria persistente** — markdown que el propio agente gestiona con
  `memory_save` / `memory_read` / `memory_delete` (privada por agente, con
  Shared Memory configurable)
- **Chat web con streaming** — en su propio puerto, móvil-first
- **Bot de Telegram** opcional — comandos + lenguaje natural
- **Voz (STT/TTS)** — transcripción y síntesis via servidores OpenAI-compatible

Un **manager** central (API REST + panel web + CLI `pihub`) orquesta todo.

## Arranque rápido

```bash
# Clonar y configurar
git clone git@github.com:ipepio/pi-hub.git
cd goguest_agent_pi
cp .env.example .env          # edita API_TOKEN y tus API keys

# Levantar con Docker
docker compose up --build -d
```

- **Panel del manager**: `http://localhost:4000` (introduce tu `API_TOKEN`)
- **Cada agente**: `http://localhost:<puerto>` (4100-4199)

### Crear tu primer agente

Desde el panel (botón **＋ Nuevo agente**), o por CLI:

```bash
docker exec -e API_TOKEN=$TOKEN pihub pihub agent create linus \
  --model anthropic/claude-sonnet-5 \
  --system "Eres Linus Torvalds, dev senior con 10 años de experiencia."
```

O por API REST:

```bash
curl -X POST http://localhost:4000/api/agents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"linus","model":"anthropic/claude-sonnet-5","systemPrompt":"Eres Linus Torvalds..."}'
```

## Características principales

### Agentes independientes

Cada agente corre como su propio proceso Node.js, con su propio system prompt,
modelo, memoria y paquetes. Pueden tener distintos niveles de thinking, voz
personalizada, y bot de Telegram independiente.

### Memoria persistente

Con `PIHUB_MEMORY_ENABLED=true` (default), cada agente tiene **memoria privada**
y puede acceder opcionalmente a la **Shared Memory** del runtime:

| Nivel de acceso | Comportamiento |
|---|---|
| `none` (default) | Solo memoria privada; el agente no sabe que existe la Shared Memory |
| `read` | Puede leer la Shared Memory, pero no modificarla |
| `read-write` | Lectura y escritura completas en Shared Memory |

### Modelos custom (`models.json`)

Para añadir proveedores custom, crea `models.json` a partir del ejemplo:

```bash
cp models.example.json models.json
# Edita models.json con tus proveedores y modelos
```

Define la API key del proveedor en `.env` usando la misma variable que
referenciaste en `models.json` (ej. `MI_PROVEEDOR_API_KEY=sk-...`).

`models.json` está en `.gitignore` — nunca se commitea porque puede contener
datos sensibles. `models.example.json` es la plantilla segura que sí se
comparte.

### Chat con comandos

Escribe `/` en el chat para ver los comandos disponibles:

| Comando | Efecto |
|---|---|
| `/model <prov/id>` | Cambia el modelo en vivo (sin reiniciar, sin persistir) |
| `/models` | Lista los modelos disponibles |
| `/new` | Sesión nueva |
| `/status` | Estado del agente |
| `/stop` | Aborta la respuesta en curso |
| `/help` | Lista los comandos |
| `/skill:<nombre>` | Ejecuta una skill instalada |
| `/<nombre>` | Ejecuta un prompt template |

### Telegram

1. Crea un bot con [@BotFather](https://t.me/BotFather) y copia el token.
2. Asígnalo al agente: `pihub agent update linus --telegram <token>`
3. Configura usuarios permitidos en `PIHUB_TELEGRAM_ALLOWED_USERS`.

### Voz (STT/TTS)

Configura un servidor de audio OpenAI-compatible (ej.
[speaches](https://speaches.ai), LocalAI):

```env
PIHUB_SPEECH_URL=http://speech:8000
PIHUB_STT_MODEL=Systran/faster-whisper-small
PIHUB_TTS_MODEL=kokoro
PIHUB_TTS_VOICE=af_heart
```

### OAuth (Claude Pro/Max, ChatGPT)

```env
PIHUB_OAUTH_PROVIDERS=anthropic,openai
```

Desde el panel o CLI: `pihub login anthropic`. Los tokens se auto-refrescan.

### Provisión declarativa

Define agentes en un manifiesto JSON y apúntalo en `.env`:

```env
PIHUB_AGENTS_FILE=/data/provision/agents.json
```

Ver `agents.example.json` para el formato. Es idempotente: crea, actualiza lo
que difiera, instala paquetes pendientes. Nunca borra agentes ni resetea campos
ausentes.

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `API_TOKEN` | _(requerido)_ | Token de autenticación para API, panel y UIs |
| `PIHUB_MANAGER_PORT` | `4000` | Puerto del manager |
| `PIHUB_AGENT_PORT_RANGE` | `4100-4199` | Rango de puertos para runners |
| `PIHUB_PANEL_ENABLED` | `true` | Mostrar panel web del manager |
| `PIHUB_GLOBAL_PACKAGES` | _(vacío)_ | Paquetes globales iniciales (comma-separados) |
| `PIHUB_DEFAULT_MODEL` | `anthropic/claude-sonnet-5` | Modelo por defecto |
| `PIHUB_OVERWRITE_MODELS` | `false` | Sobrescribir models.json en cada arranque |
| `PIHUB_MEMORY_ENABLED` | `true` | Activar memoria persistente |
| `PIHUB_SHARED_MEMORY_DEFAULT` | `none` | Acceso a Shared Memory por defecto |
| `PIHUB_PLATFORM_PROMPT_ENABLED` | `true` | Inyectar conciencia de plataforma |
| `PIHUB_OAUTH_PROVIDERS` | _(vacío)_ | Proveedores OAuth (comma-separados) |
| `PIHUB_TELEGRAM_ALLOWED_USERS` | _(vacío)_ | IDs de usuario Telegram permitidos |
| `PIHUB_AGENTS_FILE` | _(vacío)_ | Ruta al manifiesto de provisión |
| `PIHUB_SPEECH_URL` | _(vacío)_ | Servidor de audio OpenAI-compatible |
| `PIHUB_STT_MODEL` | _(vacío)_ | Modelo de transcripción (STT) |
| `PIHUB_TTS_MODEL` | _(vacío)_ | Modelo de síntesis (TTS) |
| `PIHUB_TTS_VOICE` | _(vacío)_ | Voz TTS por defecto |
| `PIHUB_UPLOADS_RETENTION_HOURS` | `24` | Horas que se conservan archivos subidos |

Ver `.env.example` para la lista completa con documentación inline.

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                      pihub (Docker)                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                   Manager (:4000)                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │  │
│  │  │ API REST │ │  Panel   │ │Supervisor│           │  │
│  │  │  Hono    │ │ Web HTML │ │ (procs)  │           │  │
│  │  └──────────┘ └──────────┘ └────┬─────┘           │  │
│  └─────────────────────────────────┼──────────────────┘  │
│                                    │ spawn/kill           │
│  ┌──────────────┐  ┌──────────────┼──────────────┐      │
│  │ Runner A     │  │ Runner B     │   Runner N    │      │
│  │ :4100        │  │ :4101        │   :41XX       │      │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  ┌──────────┐ │      │
│  │ │ Chat WS  │ │  │ │ Chat WS  │ │  │ Chat WS  │ │      │
│  │ │ Telegram │ │  │ │ Telegram │ │  │ Telegram │ │      │
│  │ │ STT/TTS  │ │  │ │ STT/TTS  │ │  │ STT/TTS  │ │      │
│  │ └──────────┘ │  │ └──────────┘ │  └──────────┘ │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                          │
│  /data                                                   │
│  ├── global/          (settings, models, auth, memory)   │
│  └── agents/<name>/   (config, SYSTEM.md, memory, etc.)  │
└──────────────────────────────────────────────────────────┘
```

### Paquetes del monorepo

| Paquete | Descripción |
|---|---|
| `@pihub/shared` | Tipos, env, auth, memoria, prompt — biblioteca compartida |
| `@pihub/manager` | API REST + supervisor de runners + panel web |
| `@pihub/runner` | Proceso por agente: chat WS, Telegram, STT/TTS |
| `@pihub/cli` | CLI `pihub` — cliente de la API del manager |
| `@pihub/memory-extension` | Extensión pi de memoria persistente (raw TS, sin compilar) |

## API REST (resumen)

Todas bajo `Authorization: Bearer $API_TOKEN`:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/status` | Salud, versión, nº de agentes |
| GET | `/api/models` | Modelos disponibles |
| GET/POST | `/api/agents` | Listar / crear agentes |
| GET/PATCH/DELETE | `/api/agents/:name` | Detalle / editar / borrar |
| POST | `/api/agents/:name/start\|stop\|restart` | Ciclo de vida |
| GET/POST/DELETE | `/api/packages` | Paquetes (global/agente) |
| GET | `/api/auth/providers` | Estado OAuth |
| POST | `/api/auth/login/:provider` | Flujo de login |

Cada runner expone además: `GET /api/status`, `GET /api/models`,
`GET /api/commands`, `POST /api/transcribe`, `POST /api/upload`,
WebSocket de chat en `/ws`.

Ver el código fuente de
[`packages/manager/src/api.ts`](packages/manager/src/api.ts) y
[`packages/runner/src/server.ts`](packages/runner/src/server.ts) para la
definición completa.

## Desarrollo

```bash
# Requisitos: Node ≥ 22, pi CLI global
npm install --ignore-scripts
npm run build
npm run typecheck
npm test
```

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para guía completa de desarrollo.

## Documentación del proyecto

- **[`CONTEXT.md`](CONTEXT.md)** — Vocabulario de dominio y definiciones clave
- **[`docs/adr/`](docs/adr/)** — Architecture Decision Records
- **[`docs/design-brief.md`](docs/design-brief.md)** — Brief de diseño UI
- **[`docs/specs/`](docs/specs/)** — Especificaciones de features
- **[`feature.md`](feature.md)** — Feature: memoria privada y compartida
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Cómo contribuir

## Layout del volumen `/data`

```
/data
├── global/
│   ├── settings.json    # Paquetes globales
│   ├── models.json      # Modelos custom (gitignored, crear desde models.example.json)
│   ├── auth.json        # Credenciales (API keys y OAuth)
│   ├── memory/          # Shared Memory del runtime
│   └── extensions/ skills/ prompts/
└── agents/<nombre>/
    ├── agent.json       # Config: puerto, modelo, telegram, memoria
    ├── SYSTEM.md        # Persona del agente
    ├── memory/          # Agent Memory privada
    ├── sessions/        # Sesiones pi
    └── workspace/       # CWD del agente (+ .pi/ con paquetes)
```

## Roadmap

- [x] Manager central con API REST y panel web
- [x] Runner por agente con chat streaming (WebSocket)
- [x] Memoria persistente (privada + Shared Memory configurable)
- [x] Provisión declarativa de agentes
- [x] Bot de Telegram con comandos
- [x] STT/TTS (voz)
- [x] OAuth para suscripciones (Claude Pro/Max, ChatGPT)
- [x] CLI `pihub` completa
- [ ] Loop de orquestación con iniciativas y triggers
- [ ] Canales de interacción asíncrona (agentes piden input humano)
- [ ] Dashboard de orquestación (timeline de iniciativas)

## Licencia

[MIT License](LICENSE) — úsalo libremente en proyectos personales y comerciales.

## Agradecimientos

Construida sobre [pi](https://pi.dev) — el harness de agentes minimalista.
