<div align="center">

# pihub

**Runtime autoalojado para Agents persistentes, construido sobre [pi](https://pi.dev).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥22](https://img.shields.io/badge/Node.js-≥22-brightgreen.svg)](https://nodejs.org/)
[![pi 0.80.3](https://img.shields.io/badge/pi-0.80.3-black.svg)](https://pi.dev)

</div>

---

## Qué es y cómo funciona

pihub ejecuta varios **Agents** persistentes en un mismo Runtime. Cada Agent tiene
su propia persona, modelo, workspace, paquetes, variables de entorno, memoria,
Channel web y, opcionalmente, Telegram y voz.

El **Manager** es el único punto de control público del Runtime. Persiste la
configuración, supervisa los procesos Runner y expone el panel y la API privada
versionada. Un **Runner** es el proceso que ejecuta un Agent concreto con pi.
Los Runners hablan WebSocket solo internamente con el Manager; ningún consumidor
externo necesita conocer sus PID, puertos, paths o protocolo.

```text
Panel web ─┐
           ├── HTTP /api/v1 ──> Manager ── WebSocket interno ──> Runner de cada Agent ──> pi
Dashboard ─┘                         │
                                      └── /data persistente
```

El panel usa el mismo `/api/v1` que el dashboard. El chat del panel es un
puente HTTP/SSE hacia el WebSocket interno del Runner: el navegador no abre
WebSockets a un Runner ni conoce su puerto.

> Los handlers legacy `/api/*` siguen montados temporalmente por compatibilidad
> con el CLI actual. Toda integración nueva, incluido un dashboard externo,
> debe usar exclusivamente `/api/v1`.

## Dos modos de control

El mismo Runtime soporta exactamente uno de estos modos:

| Modo | `PIHUB_PANEL_ENABLED` | Quién configura el Runtime | Superficie recomendada |
|---|---:|---|---|
| **Gobernador** | `true` | El operador desde el panel local | Panel + `/api/v1` |
| **Gobernado** | `false` | Un control plane externo | `/api/v1` con Bearer |

- **Gobernador** es el valor por defecto: monta el panel en el puerto del
  Manager. El panel se autentica con cookie same-origin y CSRF; nunca recibe
  el token Bearer como JavaScript.
- **Gobernado** no monta el panel. Está pensado para un dashboard externo que
  administra el Runtime mediante `Authorization: Bearer <API_TOKEN>`.
- Cambiar el modo no migra ni borra Agents: edita `PIHUB_PANEL_ENABLED` y
  reinicia el Manager.

El contrato, sus métodos, los cuerpos y sus invariantes están en
[`docs/manager-api-v1.md`](docs/manager-api-v1.md).

## Instalación rápida con Docker

Docker es el camino recomendado para pruebas y para un User Runtime gestionado
por un dashboard.

```bash
git clone git@github.com:ipepio/pi-hub.git
cd pi-hub
cp .env.example .env
# Edita como mínimo API_TOKEN y las credenciales de tus Providers.
docker compose up -d --build
```

> Si el clon se llama `goguest_agent_pi`, usa ese directorio en lugar de
> `pi-hub`; el nombre local no forma parte del Runtime.

El Manager queda en `http://localhost:4000` por defecto. En modo gobernador,
abre esa URL e introduce `API_TOKEN`.

```bash
# Estado del Manager mediante la API privada
curl http://localhost:4000/api/v1/status \
  -H "Authorization: Bearer $API_TOKEN"

# Logs y apagado
docker compose logs -f pihub
docker compose down                 # conserva el volumen pihub-data
docker compose down -v              # borra también Agents, memoria y credenciales
```

### Seguridad del contenedor

La imagen por sí sola proporciona las herramientas de Runtime; el aislamiento
fuerte del User Runtime gestionado lo aplica el Provisioner del control plane:
usuario no root, filesystem de solo lectura, capabilities eliminadas, límites
de recursos y política de red. El `docker-compose.yml` standalone sigue
publicando `4100-4199`; es una deuda de hardening documentada en
[`docs/PENDIENTE.md`](docs/PENDIENTE.md), aunque el panel ya no use esos
puertos.

## Instalación nativa como servicio systemd

`install.sh` es para **Debian/Ubuntu con systemd**. Requiere `sudo`, instala
Node 22 y `uv`, copia el código y crea el servicio:

```bash
sudo ./scripts/install.sh
```

En una terminal interactiva pregunta el modo de control. También puede fijarse
explícitamente:

```bash
sudo ./scripts/install.sh --governor
sudo ./scripts/install.sh --governed
sudo ./scripts/install.sh --no-start
```

Por defecto el servicio corre como `root`. Eso es intencional para un Agent que
administra su propio servidor, pero implica que puede instalar software,
modificar el sistema, abrir red y usar SSH. Para ejecutar con un usuario de
servicio sin privilegios de sistema:

```bash
sudo ./scripts/install.sh --user pihub
```

| Propiedad | Docker gestionado | Servicio root | Servicio `--user` |
|---|---|---|---|
| Arranca con la máquina | `restart: unless-stopped` | sí | sí |
| Administra el sistema anfitrión | no | sí | no |
| Puede abrir conexiones/usar SSH | según política del Runtime | sí | sí |
| Aislamiento entre Agents | lo impone el Provisioner | no | no |

El instalador es idempotente: una reinstalación actualiza código y unidad, pero
conserva datos, `API_TOKEN` y modo ya elegidos. Sus rutas son:

| Recurso | Ruta |
|---|---|
| Código | `/opt/pihub` |
| Datos persistentes | `/var/lib/pihub` |
| Configuración y token | `/etc/pihub/pihub.env` |
| Unidad | `/etc/systemd/system/pihub.service` |

```bash
systemctl status pihub
journalctl -u pihub -f
sudo systemctl restart pihub
sudo ./scripts/uninstall.sh          # conserva datos y configuración
sudo ./scripts/uninstall.sh --purge  # borra también datos y configuración
```

## Primer Agent

En modo gobernador puede crearse desde **Nuevo Agent** en el panel. Para una
integración o script usa `/api/v1`:

```bash
curl -X POST http://localhost:4000/api/v1/agents \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "linus",
    "model": "anthropic/claude-sonnet-5",
    "systemPrompt": "Eres un desarrollador senior.",
    "memory": { "sharedAccess": "read" }
  }'
```

`model` es opcional: si se omite se usa `PIHUB_DEFAULT_MODEL`. El nombre debe
cumplir `[a-z0-9][a-z0-9-]*` y tener como máximo 64 caracteres.

```bash
# Consultar y controlar el ciclo de vida
curl http://localhost:4000/api/v1/agents/linus \
  -H "Authorization: Bearer $API_TOKEN"

curl -X POST http://localhost:4000/api/v1/agents/linus/restart \
  -H "Authorization: Bearer $API_TOKEN"
```

## Runtime y ciclo de vida

El Manager arranca los Agents habilitados al iniciar. Si un Runner termina de
forma inesperada, el Supervisor reintenta con backoff exponencial hasta cinco
reinicios dentro de una ventana de 60 segundos; después lo deja en `errored`.
`start`, `stop` y `restart` son métodos imperativos del Manager.

Un `PATCH` declarativo compara una huella de todo lo que el Runner lee al
arrancar: modelo, thinking, persona, Telegram, voz, Shared Memory, env y
paquetes. Solo reinicia si la huella cambia. Un Agent parado no se arranca por
sorpresa al actualizar configuración; pasar `enabled` a `true` o llamar
`start` sí lo inicia.

El Manager rechaza con `409 TURN_IN_PROGRESS` una operación que pararía o
reiniciaría un Runner con un turno vivo. Cancela primero el turno o espera a
que termine.

### Turnos y sesiones

Cada turno es una petición `POST /api/v1/agents/:name/turns` que devuelve SSE.
El caller aporta `sessionKey`, `turnId`, `idempotencyKey` y `correlationId`.
Una misma `sessionKey` conserva el contexto; una distinta empieza una sesión
independiente. Repetir una `idempotencyKey` no ejecuta el prompt otra vez.

Eventos básicos: `turn-start`, `chunk`, `turn-complete`, `turn-aborted` y
`turn-error`. El perfil `?eventProfile=verbose`, que usa el panel, añade
`thinking-delta`, `tool-start` y `tool-end`. La cancelación se solicita con:

```text
POST /api/v1/agents/:name/turns/:turnId/abort
```

La idempotencia y el registro de turnos vivos viven en memoria del Manager.
Tras reiniciar el Manager no hay replay SSE ni recuerdo de esas claves; un
caller debe tratar el corte como un reintento explícito, no como una
reconexión transparente.

## Recursos, memoria y canales

### Memoria

`PIHUB_MEMORY_ENABLED=true` activa Agent Memory privada. Shared Memory es
opcional por Agent y tiene tres niveles:

| `sharedAccess` | Puede leer Shared Memory | Puede escribir/borrar Shared Memory |
|---|---:|---:|
| `none` (default) | no | no |
| `read` | sí | no |
| `read-write` | sí | sí |

El override `memory.sharedAccess` del Agent gana sobre
`PIHUB_SHARED_MEMORY_DEFAULT`. Con memoria desactivada el acceso efectivo es
siempre `none`.

### Variables y paquetes

Los valores de env nunca se devuelven: las APIs solo listan claves. `API_TOKEN`,
`PIHUB_*` y `PI_CODING_AGENT_*` son claves protegidas. Hay operaciones por
clave para el panel y reemplazo completo de env/paquetes del Agent para un
control plane que conoce el estado deseado completo.

Los paquetes pueden instalarse en ámbito global o de Agent. La imagen incluye
`node`, `npx`, `uv` y `uvx` para MCPs; no instala gestores alternativos ni
herramientas de red adicionales. Consulta las limitaciones vigentes en
[`docs/PENDIENTE.md`](docs/PENDIENTE.md).

### Modelos, OAuth, Telegram y voz

- Copia `models.example.json` a `models.json` para Providers custom. Ese
  archivo no se versiona porque puede describir secretos.
- Añade las API keys referenciadas por `models.json` al entorno o al Env Store
  correspondiente. En la rama `feature/providers-module`, `RuntimeProviders`
  resuelve `$VAR` desde el Env Store sin heredar el entorno completo del Manager.
- `GET /api/v1/providers` publica el catálogo observado y redactado. El panel
  standalone puede gestionar custom Providers; el control plane usa
  `PUT /api/v1/managed/providers`, que conserva OAuth y Providers standalone.
  Estas rutas pertenecen a una release posterior y no están en el digest
  publicado v0.7.0.
- `PIHUB_OAUTH_PROVIDERS=anthropic,openai-codex` habilita OAuth en el panel y en
  `/api/v1/auth/*`. El Module valida estos IDs contra AuthStorage y publica un
  warning tipado para configuraciones desconocidas; `openai` no es un ID OAuth válido.
- Providers registrados por Extensions se cargan únicamente dentro del Runner.
  Se observan como `origin: extension`, no se convierten automáticamente en
  Models seleccionables desde el dashboard y nunca se cargan en el Manager.
- `PIHUB_TELEGRAM_ALLOWED_USERS` limita los IDs de Telegram; vacío permite
  cualquiera, por lo que no es apropiado para una instalación expuesta.
- Configura `PIHUB_SPEECH_URL`, `PIHUB_STT_MODEL` y opcionalmente
  `PIHUB_TTS_MODEL`/`PIHUB_TTS_VOICE` para voz OpenAI-compatible.

## CLI

El binario `pihub` se instala en `PATH` por la imagen y por el instalador
nativo. El CLI actual usa las rutas legacy de compatibilidad; requiere
`PIHUB_URL` (por defecto `http://127.0.0.1:4000`) y `API_TOKEN`.

```bash
pihub status
pihub agent list
pihub agent create linus --model anthropic/claude-sonnet-5 --system 'Eres útil.'
pihub agent update linus --shared-memory read-write
pihub agent restart linus
pihub models
pihub env set OPENAI_API_KEY=... --agent linus
pihub install npm:@scope/package --agent linus
pihub login anthropic
```

Ejecuta `pihub` sin argumentos para ver todos los métodos y flags.

## Configuración

`.env.example` es la lista completa. Las variables principales son:

| Variable | Default | Efecto |
|---|---|---|
| `API_TOKEN` | vacío | Autenticación de API y panel; nunca lo dejes vacío fuera de desarrollo |
| `PIHUB_DATA_DIR` | `/data` | Volumen persistente del Runtime |
| `PIHUB_MANAGER_PORT` | `4000` | Puerto HTTP del Manager |
| `PIHUB_AGENT_PORT_RANGE` | `4100-4199` | Puertos internos asignables a Runners |
| `PIHUB_PANEL_ENABLED` | `true` | Modo gobernador (`true`) o gobernado (`false`) |
| `PIHUB_DEFAULT_MODEL` | vacío | Modelo de Agents sin `model` explícito |
| `PIHUB_MEMORY_ENABLED` | `true` | Activa memoria persistente |
| `PIHUB_SHARED_MEMORY_DEFAULT` | `none` | Permiso Shared Memory sin override de Agent |
| `PIHUB_GLOBAL_PACKAGES` | vacío | Paquetes globales iniciales separados por coma |
| `PIHUB_AGENTS_FILE` | vacío | Manifiesto declarativo idempotente de Agents |
| `PIHUB_OAUTH_PROVIDERS` | vacío | Providers OAuth habilitados |
| `PIHUB_SPEECH_URL` | vacío | Servidor OpenAI-compatible de STT/TTS |
| `PIHUB_UPLOADS_RETENTION_HOURS` | `24` | Retención de uploads del workspace |

## Desarrollo y verificación

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test

# Contra un Manager real en ejecución
npm run test:contract-red --workspace packages/manager
```

Node debe ser 22 o posterior; pi está fijado a `0.80.3`. Consulta
[`CONTRIBUTING.md`](CONTRIBUTING.md) para desarrollo local, pruebas y reglas de
cambio.

## Documentación

- [`docs/ESTADO.md`](docs/ESTADO.md): capacidades comprobadas y modos de operación.
- [`docs/manager-api-v1.md`](docs/manager-api-v1.md): referencia completa de `/api/v1`.
- [`docs/design-fase-4-panel-api-v1.md`](docs/design-fase-4-panel-api-v1.md): resultado de la migración del panel a v1/SSE.
- [`docs/PENDIENTE.md`](docs/PENDIENTE.md): límites y trabajo pendiente, con su motivo.
- [`docs/adr/`](docs/adr/): decisiones del Loop de autonomía pendiente.
- [`CONTEXT.md`](CONTEXT.md): vocabulario del dominio.

## Licencia

[MIT License](LICENSE).
