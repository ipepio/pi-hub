# Fase 4 — panel sobre `/api/v1`: resultado

> **Estado:** implementada en `v0.6.0` (`fde0ecd`, 2026-07-30).  
> **Ámbito:** pihub. El dashboard no se modifica en esta entrega.

## Decisión aplicada

El panel dejó de hablar directamente con los Runners. Ahora consume el mismo
contrato `/api/v1` que el dashboard:

```text
Browser del panel
  cookie pihub_token + X-CSRF-Token
              │
              ▼
Manager /api/v1  ◄── Bearer ── dashboard/control plane
              │
              ▼
WebSocket interno del Runner
```

No se añadió un WebSocket público alternativo. El Runner mantiene su WebSocket
como protocolo interno; el Manager lo traduce a HTTP/SSE.

## Lo que se entregó

### Auth dual sin exponer `API_TOKEN`

- `POST /auth/session` emite `pihub_token` HttpOnly, rota `pihub_csrf` y
  devuelve el token CSRF al panel.
- Bearer sigue siendo la credencial para el dashboard y no exige CSRF.
- La cookie del panel autoriza lecturas v1 same-origin; las mutaciones exigen
  `X-CSRF-Token` y, si existe `Origin`, coincidencia de origen.
- Un Bearer inválido no cae como fallback a la cookie.
- Los errores son `MISSING_AUTH`, `INVALID_AUTH`, `CSRF_REQUIRED` y
  `CSRF_INVALID` en el envelope versionado.

### Paridad de la superficie del panel

El router v1 ahora contiene las capacidades que el panel necesita:

- CRUD y ciclo de vida de Agents.
- `GET /agents/:name`, commands, modelos y estado del Manager.
- Env de Agent y global por clave, sin devolver valores.
- Paquetes de Agent y globales por item, además de los reemplazos completos
  para un control plane.
- Upload multipart, transcribe y OAuth de Providers como extensiones de
  panel/operator.
- `model` opcional al crear un Agent, usando `PIHUB_DEFAULT_MODEL`.

Las rutas y cuerpos exactos viven en [`manager-api-v1.md`](manager-api-v1.md).

### Chat por SSE

El panel genera `sessionKey`, `turnId`, `idempotencyKey` y `correlationId`, y
hace un `POST /api/v1/agents/:name/turns?eventProfile=verbose` por prompt.

- `basic` conserva el vocabulario del dashboard.
- `verbose` agrega `thinking-delta`, `tool-start` y `tool-end` para la UI del
  panel.
- `POST .../abort` marca el turno y el terminal público pasa a
  `turn-aborted`.
- El parser de panel recompone eventos aunque los chunks de red corten líneas.
- El render de Markdown sigue agrupado por `requestAnimationFrame` para no
  volver a introducir render O(n²).

`/new` rota una `sessionKey` local. No depende de una sesión HTTP persistida.

## Artefactos de implementación

| Pieza | Responsabilidad |
|---|---|
| `packages/manager/public/panel-api.js` | HTTP v1, cookies, CSRF, envelopes y multipart |
| `packages/manager/public/panel-turns.js` | IDs de turno, fetch SSE y parser por chunks |
| `packages/manager/public/panel.js` | Render y operaciones de producto, sin rutas legacy ni WS de Runner |
| `packages/manager/src/api-v1/auth.ts` | Clasificación Bearer/cookie/CSRF |
| `packages/manager/src/api-v1/routes.ts` | Contrato, bridge al Runner y políticas de ciclo de vida |
| `packages/manager/src/api-v1/turns.ts` | Traducción Runner WS → SSE público |

## Compatibilidad y límites que se conservan

- `/api/*` no se eliminó todavía porque el CLI actual lo usa. El panel no hace
  llamadas a esa superficie.
- El `docker-compose.yml` standalone aún publica el rango de Runner; eliminarlo
  es hardening separado y no se resuelve solo migrando el panel.
- La idempotencia y los turnos vivos están en memoria. Reiniciar el Manager
  pierde ambas referencias; no existe replay SSE ni `Last-Event-ID`.
- Un cierre inesperado del Runner sin terminal puede cerrar SSE sin evento
  final. El panel lo indica como stream perdido y no reintenta automáticamente.
- El dashboard conserva el perfil `basic`; `verbose` es una extensión del
  panel y no obliga a cambiar su interfaz.

## Verificación ejecutada

La entrega está cubierta por pruebas de auth dual, rutas v1, operaciones de
recursos, traducción de eventos, abort, parser SSE y cliente de panel. La
verificación operativa adicional es:

```bash
npm test
npm run typecheck
npm run test:contract-red --workspace packages/manager
```

`contract-red` requiere un Manager real porque los fakes no detectan errores de
frontera HTTP, SSE o Runner.
