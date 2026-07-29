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

## 2. Hardening del runtime (H01.05, H01.07)

Un Agent corre y responde, pero **el aislamiento no es el de producción**.

### H01.05 — El Manager como único punto de entrada

**Falta:** que los puertos del Runner (4100-4199) estén cerrados hacia fuera y su UI no
sea alcanzable directamente.

**Estado real:** `/api/v1` ya no filtra esos puertos en ninguna respuesta (verificado),
pero eso es distinto de que estén cerrados a nivel de red.

**Qué se rompe si sigue así:** alguien con acceso a la red del contenedor puede hablar
con un Runner saltándose al Manager, y con él toda la autorización.

### H01.07 — Imagen non-root, capabilities eliminadas, filesystem read-only

**Falta:** endurecer el `Dockerfile`. Hoy la imagen corre como root.

**Qué se rompe si sigue así:** el dashboard **no puede declarar verdes sus threat tests
de egress**, porque no controla esta imagen.

---

## 3. H01.06 rompe los `models.json` que usan `$VAR`

**Regresión real, encontrada el 2026-07-29 en una instalación de verdad.**

`models.json` admite referenciar la credencial por variable de entorno, que es la
forma de no escribir un secreto en un fichero:

```json
"providers": { "NaN": { "baseUrl": "…", "apiKey": "$NAN_API_KEY" } }
```

El Manager tiene esa variable; **el Runner ya no**. Antes de H01.06 la heredaba
con el resto del entorno. Ahora la allowlist la corta, `auth.json` está vacío, y
el turno muere con `INTERNAL_ERROR / "Runner error"` — sin nada en `runner.log`
que explique por qué.

**Qué se rompe si sigue así:** cualquier instalación autoalojada que configure
sus providers con `$VAR` —que es la práctica recomendada— deja de responder al
actualizar a v0.4.0 o superior, con un error genérico y sin pista.

**El arreglo no es deshacer H01.06.** Cortar la herencia es correcto: el Runner no
debe ver `API_TOKEN` ni los secretos de otros Agents. Lo que falta es que el
Manager **derive de `models.json` qué variables hacen falta** y añada solo esas a
la allowlist, o que resuelva los `$VAR` antes de arrancar el Runner.

Así el Runner recibe exactamente las credenciales que su configuración
referencia, y nada más — que es lo que H01.06 quería decir.

**Mientras tanto**, el rodeo es mover esas variables al EnvStore global, que sí
llega al Runner. El `CHANGELOG` debería decirlo con ese nivel de concreción: no
"el entorno ya no se hereda", sino "si tu `models.json` usa `$VAR`, muévela al
EnvStore o el agente dejará de responder".

---

## 4. La imagen no trae herramientas de red ni `wget`

**Estado:** un Agent tiene `bash`, `python3`, `node`, `curl`, `git`, `grep`, `sed`,
`awk`, `find` y `tar`. No tiene `ping`, `dig`, `netcat` ni `wget`.

**Por qué importa:** no puede instalarlos. La imagen corre con `ReadonlyRootfs` y
como usuario `1000:1000`, así que un `apt-get install` falla —comprobado— y eso
es deliberado: un Agent que ejecuta comandos no debe poder modificarse a sí mismo.

Lo que ocurre hoy es que el Agent intenta instalarlo, falla y **se lo explica al
usuario**, que es correcto pero desconcertante: parece una limitación accidental
cuando es una decisión.

**Qué lo desbloquea:** decidir qué herramientas merecen estar y añadirlas al
`Dockerfile`. Es una línea, queda auditable y no debilita nada.

La pregunta previa es si hacen falta: con la Network Policy activa —bloquea
`10/8`, `172.16/12`, `192.168/16` y el rango de metadata— casi todo lo que un
`ping` probaría está bloqueado de todos modos, así que la herramienta diría "no
hay ruta" sin explicar por qué. Si se añaden, conviene que el Agent sepa **que
existe una política de red**, no solo que el comando falla.

## 5. pihub solo se instala con Docker

**Estado:** `docker compose up --build -d` es la única vía. No hay unidad de
`systemd` ni instalador nativo.

**Por qué importa para el proyecto:** pihub es un runtime que quiere correr 24/7
en el servidor de quien lo instala. Exigir Docker deja fuera a quien tiene un VPS
Ubuntu y no quiere una capa de contenedores, que es una parte grande del público
de un proyecto autoalojado.

**La trampa que hay que evitar:** un instalable nativo **no es el mismo producto
con otro empaquetado**. Hoy el aislamiento lo da Docker —`ReadonlyRootfs`,
`CapDrop: ALL`, usuario no-root, límites de memoria y CPU, Network Policy por
`iptables`— y nada de eso existe por defecto en un servicio de systemd.

Un Agent con `bash` corriendo como el usuario del servicio alcanza **todo lo que
ese usuario alcance**: el código de pihub, los ficheros de los demás Agents y
`auth.json` con las credenciales. Si corre como root, la máquina entera.

**Qué lo desbloquea:** decidir cuál de estos es el producto, porque son tres:

1. **Nativo con hardening equivalente.** systemd tiene las primitivas —
   `ProtectSystem=strict`, `NoNewPrivileges`, `CapabilityBoundingSet`,
   `MemoryMax`, `PrivateTmp`, `IPAddressDeny`— así que las mismas garantías son
   alcanzables sin contenedor. Es trabajo, pero mantiene la promesa.
2. **Nativo sin aislamiento, como decisión declarada.** "Tu Agent tiene acceso a
   la máquina" puede ser una característica, no un defecto — pero entonces hay
   que decirlo en la primera pantalla, no descubrirlo.
3. **Instalador que gestiona Docker por debajo.** Da 24/7 sin renunciar a nada;
   el usuario no escribe `docker compose`, pero Docker sigue ahí.

Lo que **no** puede pasar es que las dos vías digan lo mismo y solo una lo cumpla.

---

## 6. Deuda menor, identificada

| Qué | Por qué se dejó | Impacto |
|---|---|---|
| El `LABEL` del `Dockerfile` apunta a `earendil-works/goguest_agent_pi` | Es un repo que ya no es este | Ninguno: las labels del workflow ganan y la imagen publicada lleva el `source` correcto |
| El workflow publica un tag `latest` | `metadata-action` lo añade por defecto | Inocuo, el dashboard fija por digest — pero contradice la intención declarada |
| No hay `.dockerignore` | Nunca se necesitó | El contexto de build carga `.git` de más; solo velocidad |
| `totalTokens` va a 0 en `turn-complete` | El Runner no reporta consumo | Un número inventado sería peor para calcular coste aguas arriba |
| La rotación de credencial no rota de verdad | Rotar exige reiniciar el Manager con el valor nuevo en el entorno | La ruta valida y responde `RESOURCE_UNAVAILABLE` con el motivo; aceptar el cambio en memoria daría una falsa sensación de haber rotado |
| `contract-red` fuera de `npm test` | Necesita un Manager arrancado | Tiene su propio script; correrlo antes de cerrar cualquier cambio en `/api/v1` |

### Un error del Provider debe terminar el turno como `turn-error`

**Falta:** que un turno que muere por un error del Provider emita `turn-error` con su
código, en vez de `turn-complete` sin contenido.

**Por qué no está hecho:** requiere una task H con su release y digest compatibles; esta
anotación deja fuera el cambio de código.

**Caso real verificado en T12:** el Provider respondió `HTTP 402` con el mensaje claro
`You've reached the monthly token limit for deepseek-v4-flash. The counter resets on the
1st.` (`type: monthly_cap_reached`). El dashboard tenía credencial válida y otros Models
(`gemma4`, `mimo-v2.5` y `qwen3.6`) respondían correctamente; el límite es mensual y por
Model, no falta de saldo general.

Pero ese error no deja rastro en la cadena: los logs del contenedor no lo mencionan, el
`runner.log` persistido queda vacío y el Manager emite `agent_end` sin texto. El dashboard
solo recibe “el runtime terminó el turno sin devolver contenido”. El Runner también debe
registrar el error del Provider, además de propagarlo como `turn-error`.

**Qué se rompe si sigue así:** el dashboard no puede distinguir entre “el modelo no tenía
nada que decir” y “la llamada al Provider falló”, y el smoke tampoco puede diagnosticar
la causa. Mientras el error se pierda en origen, ningún diagnóstico basado en logs puede
funcionar: reordenar el clasificador del smoke no arregla este caso porque el `402` nunca
se escribe.

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
