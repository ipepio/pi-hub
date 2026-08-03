# Estado de pihub

> Última verificación: **2026-08-03** · versión **v0.7.0** · release candidate
> de Providers construido desde `21a25e3` y validado localmente. El digest
> publicado `v0.7.0` sigue siendo el baseline sin Providers.

## Verificado

| Capacidad | Estado |
|---|---|
| Manager HTTP (Hono), Supervisor y panel web | Funciona |
| Runner por Agent, memoria, Telegram, STT/TTS, paquetes y CLI | Funciona |
| API privada `/api/v1` | Funciona |
| Runtime Providers Module (catálogo, OAuth, custom y managed projection) | Funciona en la rama `feature/providers-module`; no forma parte todavía del digest publicado v0.7.0 |
| Runtime Provider Connections de Extensions | Funciona detrás del Runner; Manager solo observa estado redactado |
| Panel migrado a `/api/v1` | Funciona: cookie + CSRF, sin token Bearer en browser |
| Chat del panel por HTTP/SSE | Funciona: Manager → WS interno del Runner |
| Eventos `basic` y `verbose`, incluida cancelación | Funciona |
| CRUD, ciclo de vida, env, paquetes, Skills por contenido, uploads, transcribe y OAuth v1 | Funciona |
| Instalación Docker y servicio systemd | Funciona |

```text
npm run typecheck  # limpio
npm test           # 219 tests passed
# imagen local pihub:providers-candidate: sha256:1d359796d0d3dfaff8c746ad996192e1cc07971ccb313231d30cc7e5146d4e34
```

La imagen candidata también se verificó contra Manager y Runners reales: una
proyección managed configuró un Model, dos Agents observaron un Provider de
Extension sin que el Manager lo expusiera, el logout recargó credenciales sin
secreto en la respuesta y un restart conservó el Provider del Runner.

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

- El motor de autonomía (Loop, Agenda, Initiative y Trigger) sigue siendo
  diseño aceptado, no código.
- El `docker-compose.yml` standalone aún publica los puertos de Runner. El
  panel no los usa, pero cerrarlos es hardening pendiente.
- La limitación de `$VAR` en `models.json` para un Runner aislado sigue abierta.
- El contrato publicado no ofrece replay durable de SSE ni idempotencia tras un
  reinicio del Manager.
- La imagen publicada `v0.7.0` sigue siendo legacy para Providers. La rama
  `feature/providers-module` añade `/providers`, `/managed/providers` y custom
  Providers; requiere una release candidata separada antes de actualizar el
  digest del dashboard.

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
