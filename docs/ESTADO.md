# Estado de pihub

> Última verificación: **2026-07-27**, versión **v0.2.0**. Comprobado ejecutando.

## Qué funciona

| Capacidad | Estado |
|---|---|
| Manager REST (Hono) + panel web | Funciona |
| Runner por agente con streaming | Funciona |
| Memoria persistente (`memory_save`/`memory_read`, Shared Memory) | Funciona |
| Telegram, voz (STT/TTS), CLI, OAuth | Funciona |
| **Interfaz privada `/api/v1`** | Funciona — **contract-red 10/10** |
| **Turno real por SSE** | Funciona end-to-end |

`npm test` → **62/62**. `npm run test:contract-red` → **10/10** (requiere el Manager
arrancado).

## Los dos escenarios

pihub sirve **dos modos con el mismo código**, y nunca coexisten:

| Modo | Cómo | Superficie de configuración |
|---|---|---|
| **Gobernado por el dashboard** | `PIHUB_PANEL_ENABLED=false` | Solo `/api/v1` — el panel no se monta |
| **Standalone** | por defecto | El panel web, sin dashboard |

Por eso no hay problema de doble fuente de verdad: la configuración se toca desde un
sitio o desde el otro, nunca desde los dos a la vez.

**Ningún cambio puede romper el modo standalone.** Las rutas `/api/*` y el panel siguen
funcionando igual que antes de que existiera `/api/v1`.

## `/api/v1` — la frontera con el dashboard

El contrato completo está en [`manager-api-v1.md`](manager-api-v1.md). Lo esencial:

- **Service auth** con vocabulario estable: `MISSING_AUTH` (no mandaste credencial) es
  distinto de `INVALID_AUTH` (la mandaste y no vale). No acepta cookie: el panel y el
  servicio son credenciales distintas.
- **Error envelope** `{ code, message, correlationId }` con catálogo cerrado.
  `INTERNAL_ERROR` nunca lleva el detalle real al caller.
- **Turnos** con `turnId`, `idempotencyKey` y `correlationId` obligatorios. Repetir una
  `idempotencyKey` devuelve el turno original **sin re-ejecutar**.
- **No se filtra nada interno**: ni paths (`/data`), ni puertos de Runner (4100-4199),
  ni el token de servicio.

### El turno es un puente WebSocket → SSE

El Runner **no tiene endpoint HTTP de chat**: solo acepta prompts por WebSocket (`/ws`).
Y la spec §7 prohíbe exponer WebSockets al dashboard. Así que el Manager abre el WS
contra su Runner y traduce cada mensaje:

```
agent_start  → turn-start
text_delta   → chunk
agent_end    → turn-complete
error        → turn-error   (código estable, nunca el texto crudo del Runner)
```

`thinking_delta` y las tools **no se reenvían**: no están en el vocabulario del
dashboard, y mapearlas a `chunk` mezclaría razonamiento con respuesta. Un tipo
desconocido se ignora en vez de cortar el turno.

## Imagen publicada

```
ghcr.io/ipepio/pi-hub@sha256:e16344e38a547e5e713461370b531545db1e864e161c019015868985622ddd0c
```

Pública (verificado con `docker logout` + `docker pull` anónimo). Se publica sola al
empujar un tag `v*`:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

El digest sale en el último paso del job y es lo que el dashboard debe fijar.

## Cómo levantarlo

```bash
docker compose up -d --build     # Manager en :4000
npm test                         # suite completa
npm run test:contract-red --workspace packages/manager   # contra el Manager arrancado
```

## Dónde está cada cosa

| Necesitas | Mira |
|---|---|
| Por qué el sistema es como es | [`docs/adr/`](adr/) — 8 decisiones |
| El contrato con el dashboard | [`docs/manager-api-v1.md`](manager-api-v1.md) |
| Qué queda por hacer y por qué | [`docs/PENDIENTE.md`](PENDIENTE.md) |
| Lenguaje del dominio | [`CONTEXT.md`](../CONTEXT.md) |
