# H10 — Que la imagen admita MCPs y skills de verdad

## Goal

Que un Agent dentro del contenedor pueda **instalar y ejecutar** MCPs y skills,
sin debilitar el aislamiento.

## El problema, medido

"Se pueden instalar skills y MCPs" es una promesa central del modo gobernado, y
hoy solo se cumple a medias: la instalación funciona, la **ejecución** no.

Comprobado dentro de un User Runtime real (`v0.5.0`):

```
npm    sí     pip   NO      HOME=/home/ubuntu
npx    sí     uv    NO      escribible: NO
               uvx   NO
```

Y el fallo real al ejecutar un MCP típico:

```
$ npx -y @modelcontextprotocol/server-everything
npm error enoent … /home/ubuntu/.npm/_logs
```

`npx` necesita caché en `$HOME/.npm`, y con `ReadonlyRootfs` ese directorio no
admite escritura. El paquete se descarga en el workspace —`piInstall` escribe en
`/data`, que sí es escribible— pero **ejecutarlo falla**, así que el error aparece
al usar el MCP, no al instalarlo.

Con la caché redirigida al volumen funciona a la primera:

```
$ npm_config_cache=/data/.npm npx -y cowsay "funciona"
 __________
< funciona >
```

**Conclusión: el contenedor no necesita menos aislamiento. Necesita que las
herramientas escriban donde sí pueden.**

## Criterios de aceptación

1. Un Agent ejecuta `npx -y <paquete>` sin variables extra y funciona.
2. Un Agent ejecuta un MCP en Python vía `uvx` y funciona.
3. `ReadonlyRootfs`, `CapDrop: ALL` y el usuario no-root **siguen intactos**. Si
   el arreglo pasa por relajar alguno, es el arreglo equivocado.
4. La caché sobrevive al reinicio del contenedor: instalar un MCP no debe
   volver a descargar todo en cada arranque.
5. El modo standalone (`docker compose up`) sigue funcionando igual.

## Análisis

### La causa: `HOME` apunta a un sitio de solo lectura

El `Dockerfile` no define `HOME`. Docker lo deriva del `User`, y como el
contenedor corre con `1000:1000` —que en `ubuntu:24.04` es el usuario `ubuntu`—
queda `HOME=/home/ubuntu`, dentro del filesystem de solo lectura.

Un usuario que no puede escribir en su propio `HOME` está roto de base: no es
solo `npm`, es `git config`, `ssh`, y cualquier herramienta que guarde estado.

**El arreglo es apuntar `HOME` a un directorio dentro de `/data`**, que es el
volumen persistente y escribible.

### Por qué `HOME` y no `npm_config_cache`

Esto es lo que hace fallar el intento obvio, así que léelo antes de elegir.

Quien ejecuta los MCPs es el **Runner**, y desde `H01.06` el Runner **no hereda
el entorno del Manager**: solo recibe una lista blanca
(`packages/shared/src/envstore.ts:24`) más los EnvStores.

Esa lista incluye `HOME`, `XDG_CACHE_HOME` y `XDG_DATA_HOME`. **No incluye
`npm_config_cache`.** Así que poner esa variable en el `Dockerfile` no serviría de
nada: el Manager la tendría y el Runner no.

Usa `HOME`, que ya está en la allowlist y arregla de paso todo lo demás.

### Qué añadir al `Dockerfile`

**`uv`** (que trae `uvx`). Es la forma estándar de ejecutar MCP servers en
Python, y sin ella queda fuera medio catálogo. Es un binario estático, se instala
sin `pip`.

**No añadas** `pnpm`, `yarn`, `bun` ni `deno`: los MCPs se distribuyen por `npx` o
`uvx`, no por gestores alternativos. Menos superficie es mejor en una imagen que
ejecuta código de terceros.

Valora también `wget` y herramientas de red (`ping`, `dig`) — están en
[`PENDIENTE.md`](../PENDIENTE.md) §4 como decisión aparte. **No las metas en esta
task** salvo que al probar los MCPs descubras que hacen falta; si es así, dilo.

### La decisión que hay dentro

`HOME` dentro de `/data` significa que la caché de paquetes **vive en el volumen
persistente**, que es lo que se respalda con snapshots (D09.04) y lo que se migra
entre Runtime Releases.

Es lo correcto —así un MCP no se re-descarga en cada arranque, que es el criterio
4— pero tiene un coste: los snapshots engordan. La alternativa, `tmpfs`, sería
efímera y obligaría a descargar en cada arranque.

Se elige el volumen. **Déjalo escrito** donde se configure, para que quien vea
crecer un volumen sepa por qué.

## Tests

- `npx -y cowsay hola` dentro del contenedor, **sin variables extra**, devuelve 0
  y su salida. Es el Red: hoy falla con `enoent`.
- `uvx --help` responde.
- Un MCP real de Node arranca — `@modelcontextprotocol/server-everything` sirve.
- El contenedor sigue teniendo `ReadonlyRootfs: true`, `CapDrop: [ALL]` y
  `User: 1000:1000` después del cambio.
- `/usr` sigue sin admitir escritura.

## Trampa

Cambiar `HOME` afecta a más cosas que `npm`: `git`, `ssh` y cualquier herramienta
con estado en el home. Eso es bueno —todas estaban rotas— pero **pruébalo**: que
el arranque del Manager y del Runner sigan funcionando, no solo `npx`.

Y el directorio nuevo tiene que existir y pertenecer a `1000:1000` **antes** de
que arranque nada. El Provisioner ya hace `chown` del volumen
(`prepareVolumeOwnership` en el adapter Docker del dashboard), pero en standalone
el volumen lo crea Docker: comprueba los dos casos.
