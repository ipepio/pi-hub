# Contribuir a pihub

pihub es un monorepo TypeScript que ejecuta Agents persistentes sobre pi. Antes
de modificar una interfaz visible, lee [`CONTEXT.md`](CONTEXT.md), la referencia
[`docs/manager-api-v1.md`](docs/manager-api-v1.md) y los ADRs aplicables.

## Requisitos

- Node.js **22 o superior**.
- npm (el lockfile es `package-lock.json`).
- pi CLI `@earendil-works/pi-coding-agent@0.80.3` para ejecutar un Runtime real.
- Docker, opcional pero necesario para verificar la imagen/Manager real.

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
```

La suite usa `node --test --experimental-strip-types`. El build compila primero
`@pihub/shared`: no sustituyas el script raíz por un `--workspaces` plano, ya
que npm no garantiza el orden de dependencias y el Manager necesita los tipos
generados por `shared`.

## Estructura

```text
packages/
  shared/            tipos, env, almacenamiento, memoria, auth y helpers pi
  manager/           Manager HTTP, API /api/v1, Supervisor y panel web
  runner/            proceso por Agent, WS interno, Telegram, STT/TTS
  cli/               cliente administrativo de compatibilidad
  memory-extension/  extensión pi de memoria persistente
scripts/
  install.sh          instalación systemd para Debian/Ubuntu
  uninstall.sh        retirada conservadora o con --purge
docs/
  manager-api-v1.md   contrato vigente Manager ↔ dashboard/panel
  ESTADO.md           capacidades verificadas
  PENDIENTE.md        límites y deuda explícita
  adr/                diseño aceptado del Loop de autonomía pendiente
```

## Ejecutar localmente

```bash
# Requiere pi en PATH y un directorio de datos escribible.
PIHUB_DATA_DIR=./data API_TOKEN=dev npm start
```

El Manager escucha en `:4000` por defecto. En modo gobernador
(`PIHUB_PANEL_ENABLED=true`) sirve el panel; el panel llama a `/api/v1` con una
cookie same-origin y CSRF. En modo gobernado (`false`) no se sirve el panel y
un control plane usa Bearer contra `/api/v1`.

Para iterar sin Docker, compila los paquetes que cambies en otra terminal:

```bash
npx tsc -p packages/shared/tsconfig.json --watch
npx tsc -p packages/manager/tsconfig.json --watch
```

## Pruebas y contrato externo

```bash
npm test
npm run typecheck

# Requiere un Manager real arrancado y API_TOKEN disponible.
npm run test:contract-red --workspace packages/manager
```

Los unit tests no sustituyen `contract-red`: la frontera con el dashboard es
HTTP y SSE contra un Manager real. Si cambias `/api/v1`, auth, streaming,
multipart, ciclo de vida o serialización, actualiza la spec y ejecuta ambos.

## Reglas de diseño

1. **Manager como frontera.** El panel y el dashboard nunca conocen puerto,
   PID, path ni WebSocket de un Runner. El Manager es el único puente hacia el
   Runner.
2. **`/api/v1` primero.** Toda capacidad nueva de control se diseña y prueba
   en la interfaz versionada. `/api/*` es compatibilidad para el CLI actual,
   no una superficie donde añadir producto nuevo.
3. **Auth explícita.** Bearer es para servicios. La cookie de panel solo sirve
   same-origin y cada mutación exige CSRF. No expongas `API_TOKEN` al browser,
   URL, logs ni mensajes de error.
4. **Errores cerrados.** Los callers reciben el envelope versionado y un código
   del catálogo; no reciben texto crudo de Runner, stacks, puertos ni paths.
5. **Estado declarativo e imperativo.** `PATCH` converge configuración y solo
   reinicia cuando cambia la huella efectiva. `start`/`stop`/`restart` son
   comandos explícitos. Nunca cortes un turno vivo: usa `TURN_IN_PROGRESS`.
6. **Secretos por env store.** El Runner no hereda el entorno completo del
   Manager. Los valores no se exponen en lecturas; las claves protegidas no se
   pueden escribir.
7. **Compatibilidad de Runtime.** No cambies la versión de pi ni su interfaz
   sin declarar la compatibilidad de imagen y dashboard.

## Cambios y commits

- Crea una rama descriptiva.
- Sigue Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:` o
  `chore:`.
- Mantén TypeScript estricto: no uses `any`; estrecha `unknown`.
- Todo bug lleva un test que demuestra el comportamiento. Toda capacidad nueva
  se prueba por su interfaz pública, no accediendo a internals.
- Actualiza `README.md`, `.env.example`, `docs/manager-api-v1.md`,
  `docs/ESTADO.md`, `docs/PENDIENTE.md` o ADRs cuando cambie lo que un operador,
  dashboard o Agent observa.

Antes de proponer un cambio:

```bash
npm run build
npm run typecheck
npm test
```

Para cambios de composición, Docker o `/api/v1`, añade además el Manager real
con `npm run test:contract-red --workspace packages/manager`.

## Instalación de producción

El instalador nativo solo soporta Debian/Ubuntu con systemd:

```bash
sudo ./scripts/install.sh --governor
sudo ./scripts/install.sh --governed
sudo ./scripts/install.sh --user pihub
```

No supongas que el servicio native tiene la postura de seguridad del Runtime
Docker gestionado. En root, el Agent administra la máquina. En `--user`, pierde
privilegios de sistema, pero sigue teniendo red y `HOME`. Lee el README y
`packaging/pihub.service` antes de endurecer systemd: cada directiva de
aislamiento cambia las capacidades del producto.
