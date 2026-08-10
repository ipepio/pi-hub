# Estado de pihub

> Última verificación: **2026-08-10** · versión **v0.9.1** · release publicada
> desde HEAD `2309dc94708429680d085d42801b3d2f4f8c6441` con digest
> `ghcr.io/ipepio/pi-hub@sha256:892322db268ee54978fc824723650f2fb4d0aa73880b3b6ffcd9f00b15eb0151`.

## Verificado

| Capacidad | Estado |
|---|---|
| Manager HTTP (Hono), Supervisor y panel web | Funciona |
| Runner por Agent, memoria, Telegram, STT/TTS, paquetes y CLI | Funciona |
| API privada `/api/v1` | Funciona |
| Runtime Providers Module (catálogo, OAuth, custom y managed projection) | Funciona en la imagen publicada `v0.8.0-rc.1`; OAuth real verificado en Runtime desechable |
| Runtime Provider Connections de Extensions | Funciona detrás del Runner; Manager solo observa estado redactado |
| Panel migrado a `/api/v1` | Funciona: cookie + CSRF, sin token Bearer en browser |
| Chat del panel por HTTP/SSE | Funciona: Manager → WS interno del Runner |
| Eventos `basic` y `verbose`, incluida cancelación | Funciona |
| CRUD, ciclo de vida, env, paquetes, Skills por contenido, uploads, transcribe y OAuth v1 | Funciona |
| Instalación Docker y servicio systemd | Funciona |

```text
npm run verify     # typecheck + build limpios, 657 tests passed, 0 failed
# imagen publicada v0.9.1: ghcr.io/ipepio/pi-hub@sha256:892322db268ee54978fc824723650f2fb4d0aa73880b3b6ffcd9f00b15eb0151
```

Antes de publicarse, la imagen candidata también se verificó contra Manager y
Runners reales: una proyección managed configuró un Model, dos Agents observaron
un Provider de Extension sin que el Manager lo expusiera, el logout recargó
credenciales sin secreto en la respuesta, un logout durante un turno devolvió
una recarga diferida y un restart conservó el Provider del Runner.

El 2026-08-05 se publicó como `v0.8.0-rc.1` con digest
`sha256:703cf0fef3ff54cefaa8abd4f527f5739b91fa1af3e48452d3cf8dcf9201c2b5`.
El dashboard fijó esa imagen con `providerProjection: managed_http` y el drill M4
de upgrade de flota pasó.

El 2026-08-10 se publicó la release **v0.9.1** (tag `v0.9.1`, HEAD
`2309dc94708429680d085d42801b3d2f4f8c6441`) como
`ghcr.io/ipepio/pi-hub@sha256:892322db268ee54978fc824723650f2fb4d0aa73880b3b6ffcd9f00b15eb0151`
con P3 (autonomía `waiting_human` end-to-end) cerrado.

`npm run test:contract-red --workspace packages/manager` sigue siendo una
verificación separada contra un Manager real; no forma parte de `npm test`.

## Modos de Runtime

| Modo | Configuración | Administración | Panel |
|---|---|---|---|
| **Gobernador** | `PIHUB_PANEL_ENABLED=true` | Operador local | Montado |
| **Gobernado** | `PIHUB_PANEL_ENABLED=false` | Dashboard/control plane externo | No montado |

Ambos usan el mismo Manager y `/api/v1`; solo cambia quién posee la superficie
humana. El modo se selecciona con el instalador (`--governor`/`--governed`) o
editando `PIHUB_PANEL_ENABLED` y reiniciando el Manager.

## Frontera HTTP

`/api/v1` es la interfaz vigente para el dashboard y el panel:

- Bearer es la autenticación de servicio. El panel usa cookie same-origin y
  CSRF en mutaciones; un Bearer inválido nunca cae como fallback a una cookie.
- El Manager es el puente: abre el WebSocket interno hacia el Runner y expone
  turnos como SSE.
- El perfil `basic` entrega ciclo de vida y respuesta. `verbose`, usado por el
  panel, añade thinking y herramientas saneadas.
- `turnId`, `sessionKey`, `idempotencyKey` y `correlationId` son obligatorios
  para un turno. La idempotencia y turnos vivos son por instancia de Manager.
- Ninguna respuesta v1 contiene tokens, valores de env, PID, puertos de Runner,
  paths internos ni el texto crudo de un Runner. Las Skills por contenido usan
  el `skillId` UUID que aporta el dashboard; el source local de pi no sale por
  `/skills`, `/packages` ni detalle de Agent.
- Las rutas legacy `/api/*` permanecen para compatibilidad con el CLI actual,
  pero el panel ya no las llama y no son el destino de nuevas integraciones.

La referencia completa, incluidos métodos, payloads, SSE y errores, está en
[`manager-api-v1.md`](manager-api-v1.md).

## Runtime e instalación

- **Docker:** imagen Ubuntu 24.04 con Node 22, pi `0.80.3`, `uv`/`uvx` y
  volumen `/data`. El Provisioner del dashboard es quien añade aislamiento
  fuerte a sus User Runtimes.
- **Servicio systemd:** `scripts/install.sh` instala código en `/opt/pihub`,
  datos en `/var/lib/pihub` y configuración en `/etc/pihub/pihub.env`. En root
  el Agent administra la máquina; `--user <nombre>` reduce privilegios pero no
  convierte el servicio en un sandbox.
- **Supervisor:** reinicia un Runner que cae hasta cinco veces en 60 segundos
  con backoff; después lo marca `errored`.

## Lo que no cambia ni está terminado

### P1 terminada (v0.9.0)

Agenda durable con proyección coherente, comandos de Trigger/Initiative,
autoridad por modo (owner vs control_plane). El motor de autonomía existe
como código — Loop, Agenda, Initiative, Trigger — y se proyecta en el snapshot
público de `/api/v1/agents/:name/autonomy`. Ocho commits nuevos desde la
candidate v0.8.0-rc.1.

### P2 terminada (v0.9.0)

Contrato HTTP `/api/v1` de autonomía con auth dual (Bearer de servicio y cookie
de panel con CSRF), presenters por allowlist que redactan campos internos, y
panel con pestaña de Autonomía. Las rutas de Trigger e Initiative se prueban
en `contract-red.test.ts` contra un Manager real.

### P3 terminada (v0.9.1)

`waiting_human` end-to-end: la tool `ask_human` pausa una Initiative en
`mode:"ask"` validando cotas e IDs (P3.2); la espera es un terminal durable que
sobrevive al reinicio del Manager, con expiración **por fila**
(`human_expires_at`) y CAS de respuesta que impone el request id y su plazo.
La pregunta se entrega al canal primario de Telegram (P3.4) con
`notificationStatus` en el snapshot; las respuestas entran por el panel o por
la ruta interna `POST /internal/runner/telegram-reply`, y el runner retoma la
misma sesión tras reiniciar (P3.6). El consumo de la respuesta ocurre en la
misma transacción que reclama el turno: la entrega es **at-least-once**, una
respuesta a mitad de carrera no se pierde en silencio.

### P4 pendiente

Admisión y draining reales. Las rutas existen y devuelven `503` a propósito.

### Otras deudas

- El `docker-compose.yml` standalone aún publica los puertos de Runner. El
  panel no los usa, pero cerrarlos es hardening pendiente.
- La limitación de `$VAR` en `models.json` para un Runner aislado sigue abierta.
- El contrato publicado no ofrece replay durable de SSE ni idempotencia tras un
  reinicio del Manager.

Checkpoint candidate: [`verification/providers-v0.8.0-candidate.md`](verification/providers-v0.8.0-candidate.md).

Cada punto explica causa, impacto y desbloqueo en [`PENDIENTE.md`](PENDIENTE.md).

## Dónde encontrar cada cosa

| Necesidad | Documento |
|---|---|
| Instalar, operar y entender los modos | [`../README.md`](../README.md) |
| Contribuir y probar | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Métodos y contrato HTTP | [`manager-api-v1.md`](manager-api-v1.md) |
| Resultado de la migración del panel | [`design-fase-4-panel-api-v1.md`](design-fase-4-panel-api-v1.md) |
| Límites, deuda y roadmap | [`PENDIENTE.md`](PENDIENTE.md) |
| Vocabulario | [`../CONTEXT.md`](../CONTEXT.md) |
| Diseño de autonomía pendiente | [`adr/`](adr/) |
