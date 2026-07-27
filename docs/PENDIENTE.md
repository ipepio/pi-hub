# Qué queda en pihub, y por qué

> Cada entrada dice **qué falta**, **por qué no está hecho** y **qué se rompe si sigue
> así**. Si algo está pendiente por una razón que ya no es cierta, bórralo de aquí.

---

## 1. El motor de autonomía — solo existe como diseño

**Lo más grande que queda en todo el proyecto.**

Los 8 ADRs de `docs/adr/` describen un sistema completo: Loop central en el Manager,
interacción asíncrona con callback, sesión aislada por iniciativa, dispatcher único,
auto-enqueue solo vía trigger, canal interno de iniciativas, iniciativas `running` que
fallan al arrancar, y callback que lleva resultado + continuación.

**Nada de eso tiene implementación.** No existen `loop.ts`, `initiative.ts`, `agenda.ts`
ni `trigger.ts`.

**Qué bloquea:** el E2E de autonomía del dashboard (Trigger → Initiative →
`waiting_human` → resuelto). El dashboard ya tiene sus proyecciones construidas contra un
fake, esperando la fuente real.

**Por qué importa el orden:** los ADRs están aceptados y son coherentes entre sí, así que
el diseño no hay que rehacerlo. Es trabajo de implementación, no de decisión.

---

## 2. Hardening del runtime (H01.05, H01.06, H01.07)

Un Agent corre y responde, pero **el aislamiento no es el de producción**.

### H01.05 — El Manager como único punto de entrada

**Falta:** que los puertos del Runner (4100-4199) estén cerrados hacia fuera y su UI no
sea alcanzable directamente.

**Estado real:** `/api/v1` ya no filtra esos puertos en ninguna respuesta (verificado),
pero eso es distinto de que estén cerrados a nivel de red.

**Qué se rompe si sigue así:** alguien con acceso a la red del contenedor puede hablar
con un Runner saltándose al Manager, y con él toda la autorización.

### H01.06 — Env del Runner por allowlist

**Falta:** que el Runner reciba solo las variables que necesita, en vez de heredar el
entorno del Manager.

**Qué se rompe si sigue así:** un Channel Secret (p. ej. el token de Telegram de otro
Agent) podría estar visible en el proceso del Runner. El dashboard cifra esos secretos y
no los expone, pero **no puede verificar** que el Runner tampoco los recibe.

### H01.07 — Imagen non-root, capabilities eliminadas, filesystem read-only

**Falta:** endurecer el `Dockerfile`. Hoy la imagen corre como root.

**Qué se rompe si sigue así:** el dashboard **no puede declarar verdes sus threat tests
de egress**, porque no controla esta imagen.

---

## 3. Deuda menor, identificada

| Qué | Por qué se dejó | Impacto |
|---|---|---|
| El `LABEL` del `Dockerfile` apunta a `earendil-works/goguest_agent_pi` | Es un repo que ya no es este | Ninguno: las labels del workflow ganan y la imagen publicada lleva el `source` correcto |
| El workflow publica un tag `latest` | `metadata-action` lo añade por defecto | Inocuo, el dashboard fija por digest — pero contradice la intención declarada |
| No hay `.dockerignore` | Nunca se necesitó | El contexto de build carga `.git` de más; solo velocidad |
| `totalTokens` va a 0 en `turn-complete` | El Runner no reporta consumo | Un número inventado sería peor para calcular coste aguas arriba |
| La rotación de credencial no rota de verdad | Rotar exige reiniciar el Manager con el valor nuevo en el entorno | La ruta valida y responde `RESOURCE_UNAVAILABLE` con el motivo; aceptar el cambio en memoria daría una falsa sensación de haber rotado |
| `contract-red` fuera de `npm test` | Necesita un Manager arrancado | Tiene su propio script; correrlo antes de cerrar cualquier cambio en `/api/v1` |

---

## Decisiones que conviene no deshacer sin leer

### El error del panel conserva el campo `error`

El 401 del guard de `/api/*` lleva **a la vez** el envelope nuevo (`code`, `message`,
`correlationId`) y el `error` de siempre. `panel.js` solo mira `res.status` para el
login, **pero sí lee `body.error`** en subida de ficheros, instalación de paquetes y env:
sin el campo mostraría `undefined`. Es aditivo, nunca sustitutivo.

### El build construye `shared` primero, explícitamente

`npm run build --workspaces` respeta el orden **alfabético** (cli, manager, …, shared),
no el de dependencias. Como `@pihub/shared` apunta sus tipos a `dist/index.d.ts`, el
manager compilaba antes de que esos `.d.ts` existieran: 15 errores `TS2307`.

En local no se veía porque `packages/*/dist` ya estaba de builds anteriores. **Docker
siempre parte limpio, así que la imagen nunca se había podido construir.** Si alguien
"simplifica" ese script, el build de la imagen vuelve a romperse.

### `/api/v1` se monta ANTES del guard del panel

El `app.use("/api/*")` del panel casa también con `/api/v1/*`. Si el router se montara
después, una petición sin credencial a `/api/v1` devolvería el envelope viejo y los
contract tests fallarían.

### El ejemplo de la spec §4.3 ya no muestra `ports.runner`

Contradecía su propia §7. Se resolvió a favor de la prohibición: el dashboard nunca habla
con el Runner, así que ese puerto no le sirve de nada y solo filtra topología interna.
