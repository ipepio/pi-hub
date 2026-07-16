# Contribuir a pihub

Gracias por tu interés en contribuir a pihub. Este documento describe cómo
desarrollar, probar y enviar cambios al proyecto.

## Requisitos previos

- **Node.js ≥ 22** (`node -v` debe mostrar v22+)
- **pi CLI** global: `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`
- **Git**
- (Opcional) **Docker** para probar el contenedor completo

## Estructura del monorepo

```
goguest_agent_pi/
├── packages/
│   ├── shared/          # Tipos, env, auth, memoria, prompt — biblioteca compartida
│   ├── manager/         # API REST + supervisor de runners + panel web
│   ├── runner/          # Proceso por agente: chat WS, Telegram, STT/TTS
│   ├── cli/             # CLI `pihub` (cliente fino de la API del manager)
│   └── memory-extension/# Extensión pi de memoria persistente (se copia raw al volumen)
├── docs/
│   ├── adr/             # Decisiones de arquitectura (Architecture Decision Records)
│   ├── design-brief.md  # Brief de diseño UI
│   └── specs/           # Especificaciones de features
├── agents.example.json  # Manifiesto de provisión declarativa
├── models.example.json  # Plantilla de modelos custom
├── .env.example         # Variables de entorno documentadas
├── Dockerfile
└── docker-compose.yml
```

## Desarrollo local (sin Docker)

```bash
# Instalar dependencias
npm install --ignore-scripts

# Compilar todos los paquetes
npm run build

# Typecheck completo
npm run typecheck

# Ejecutar tests
npm test

# Arrancar el manager (requiere `pi` en el PATH)
PIHUB_DATA_DIR=./data API_TOKEN=dev npm start
```

El manager arranca en `:4000` por defecto. Los runners se asignan puertos
4100-4199.

### Modo desarrollo con auto-rebuild

Para desarrollo iterativo, compila en modo watch un paquete a la vez:

```bash
# Terminal 1: shared (se compila primero, otros dependen de él)
cd packages/shared && npx tsc -p tsconfig.json --watch

# Terminal 2: manager
cd packages/manager && npx tsc -p tsconfig.json --watch
```

## Tests

Los tests usan el runner nativo de Node (`node --test`) con
`--experimental-strip-types` para ejecutar TypeScript directamente.

```bash
# Todos los tests
npm test

# Tests de un paquete
node --test --experimental-strip-types packages/shared/test/*.test.js
node --test --experimental-strip-types packages/manager/test/*.test.js
```

## Reglas de contribución

1. **Rama de trabajo**: crear una rama descriptiva (`feat/memory-access-levels`,
   `fix/telegram-reconnect`, etc.).

2. **Commits**: seguir [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` nueva funcionalidad
   - `fix:` corrección de bug
   - `docs:` cambios en documentación
   - `refactor:` reestructuración sin cambio de comportamiento
   - `test:` añadir o modificar tests
   - `chore:` tareas de mantenimiento

3. **Tipado**: el proyecto es estrictamente tipado (`strict: true`). No usar
   `any`; preferir tipos propios o `unknown` + narrowing.

4. **No romper la API pública**: si un cambio modifica tipos de `@pihub/shared`,
   actualizar todos los paquetes consumidores en el mismo commit/PR.

5. **Tests**: toda funcionalidad nueva debe incluir tests. Los bugs deben incluir
   un test que falle antes del fix y pase después.

6. **Documentación**: actualizar README, `.env.example` o ADRs si el cambio
   afecta a la interfaz visible (API, CLI, env vars, tipos).

## Arquitectura — Decisiones clave

El proyecto documenta sus decisiones de arquitectura en
[`docs/adr/`](docs/adr/). Lee los ADRs existentes antes de proponer cambios
arquitectónicos significativos. Si tu PR introduce una nueva decisión, crea un
ADR siguiendo el formato establecido.

## Proceso de Pull Request

1. Asegurar que `npm run typecheck` y `npm test` pasan.
2. Abrir PR contra `main` con descripción clara del cambio.
3. Referenciar issues si existen (`Fixes #123`).
4. El PR será revisado; puede requerir cambios menores.

## Licencia

Al contribuir, aceptas que tus contribuciones se licencien bajo la
[MIT License](LICENSE) del proyecto.
