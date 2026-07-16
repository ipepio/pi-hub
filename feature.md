# Feature: memoria privada y memoria compartida configurable por Agent

## Estado

Propuesta lista para implementar.

## Problema

pihub ofrece actualmente, cuando `PIHUB_MEMORY_ENABLED=true`, dos ámbitos a todos los Agents:

- `agent`: memoria privada en `/data/agents/<name>/memory`;
- `global`: memoria compartida en `/data/global/memory`.

Todos los Agents reciben ambos índices en su system prompt y pueden leer, escribir y borrar en ambos ámbitos mediante `memory_save`, `memory_read` y `memory_delete`.

Esto hace que la memoria compartida sea implícita. Un Agent puede guardar información en `global` y exponerla accidentalmente a todos los demás Agents del mismo User Runtime. La configuración actual solo permite habilitar o deshabilitar toda la memoria; no permite decidir qué Agents acceden a la memoria compartida ni con qué permisos.

## Decisión

La memoria privada del Agent es el comportamiento por defecto. La memoria compartida es una capacidad explícita y configurable por Agent.

Cada Agent tiene:

- **Agent Memory**: privada, disponible únicamente para ese Agent;
- **Shared Memory**: perteneciente al User Runtime y compartible explícitamente con Agents seleccionados.

La Shared Memory admite tres niveles de acceso:

| Valor | Comportamiento |
|---|---|
| `none` | El Agent no ve el índice compartido ni puede leer, escribir o borrar Shared Memory |
| `read` | El Agent ve y lee Shared Memory, pero no puede modificarla |
| `read-write` | El Agent puede leer, guardar y borrar Shared Memory |

No existe modo `shared-only`: mientras la memoria esté habilitada, cada Agent conserva siempre su Agent Memory.

## Configuración

### Variables del User Runtime

```env
# Activa la capacidad de memoria completa. Default: true.
PIHUB_MEMORY_ENABLED=true

# Acceso compartido por defecto para Agents que no declaren override.
# Valores: none | read | read-write. Default seguro: none.
PIHUB_SHARED_MEMORY_DEFAULT=none
```

### Configuración persistida del Agent

`/data/agents/<name>/agent.json`:

```json
{
  "name": "integraciones",
  "memory": {
    "sharedAccess": "none"
  }
}
```

Tipo propuesto:

```ts
export type SharedMemoryAccess = "none" | "read" | "read-write";

export interface AgentMemoryConfig {
  sharedAccess?: SharedMemoryAccess;
}

export interface AgentConfig {
  // campos existentes
  memory?: AgentMemoryConfig;
}
```

Si `memory.sharedAccess` no está definido, se utiliza `PIHUB_SHARED_MEMORY_DEFAULT`.

### Superficies de configuración

La opción debe estar disponible de forma consistente en:

- `POST /api/agents`;
- `PATCH /api/agents/:name`;
- manifiesto `PIHUB_AGENTS_FILE`;
- CLI `pihub agent create/update`;
- dashboard externo mediante la interfaz privada del Manager.

Forma REST/manifiesto:

```json
{
  "memory": {
    "sharedAccess": "read"
  }
}
```

Forma CLI propuesta:

```bash
pihub agent update integraciones --shared-memory none
pihub agent update integraciones --shared-memory read
pihub agent update integraciones --shared-memory read-write
```

Cambiar el acceso reinicia únicamente el Runner afectado para reconstruir tools y system prompt.

## Comportamiento del Runner

### `sharedAccess=none`

- Inyectar solo el índice de Agent Memory.
- No mencionar Shared Memory en el system prompt.
- Rechazar desde las tools cualquier operación de scope compartido.

### `sharedAccess=read`

- Inyectar el índice de Agent Memory y el índice de Shared Memory.
- Permitir `memory_read` en ambos ámbitos.
- Permitir `memory_save` y `memory_delete` solo en Agent Memory.
- Las operaciones de escritura compartida fallan con un error explícito y tipado.

### `sharedAccess=read-write`

- Inyectar ambos índices.
- Permitir lectura, escritura y borrado en ambos ámbitos.

La autorización se aplica dentro de la implementación de las tools. No debe depender únicamente de instrucciones del system prompt.

## Interfaz de las tools

El término público nuevo es `shared`; `global` queda como alias de compatibilidad para sesiones antiguas.

```ts
memory_read({ scope: "agent" | "shared", name? })
memory_save({ scope: "agent" | "shared", title, content })
memory_delete({ scope: "agent" | "shared", name })
```

Reglas:

- `agent` siempre se refiere al Agent actual;
- `shared` se refiere a la Shared Memory del User Runtime;
- una llamada legacy con `scope: "global"` se normaliza a `shared` antes de validar permisos;
- errores de autorización no revelan rutas internas;
- los resultados y descripciones dejan de utilizar “global” como término de producto.

## Persistencia

Layout lógico:

```text
/data
├── shared/memory/              # Shared Memory del User Runtime
└── agents/<name>/memory/       # Agent Memory privada
```

El layout físico existente `/data/global/memory` puede mantenerse inicialmente para evitar una migración destructiva, pero debe exponerse en código y UI como Shared Memory. Si se mueve a `/data/shared/memory`, el bootstrap debe migrarlo de forma idempotente y conservar backup.

Las escrituras y la regeneración de `MEMORY.md` compartido deben serializarse para evitar lost updates cuando dos Agents escriban simultáneamente.

## Seguridad y sandbox

- Un Agent no puede acceder directamente a las rutas de memoria mediante `bash`, `read`, `write` o `edit`.
- El Agent Sandbox permite modificar su workspace, pero las memorias se atraviesan únicamente mediante las tools autorizadas.
- Un Agent con `sharedAccess=none` no recibe la ruta ni el índice de Shared Memory.
- Un Agent con `sharedAccess=read` no puede modificar Shared Memory aunque intente invocar directamente la tool.
- La configuración protegida no puede ser alterada por el propio Agent.

Esta feature depende del sandbox por Agent definido para la integración con el dashboard; no debe considerarse segura si todos los Runners pueden leer `/data` mediante rutas absolutas.

## Migración desde el comportamiento actual

- `PIHUB_MEMORY_ENABLED` conserva su significado.
- El nuevo default es `PIHUB_SHARED_MEMORY_DEFAULT=none`.
- La memoria global ya existente no se borra.
- Tras actualizar, los Agents sin override dejan de verla, pero puede recuperarse configurando `sharedAccess=read` o `read-write`.
- Las llamadas guardadas en sesiones con `scope: "global"` continúan funcionando si el Agent tiene el permiso equivalente.
- README, `.env.example`, `agents.example.json`, API y CLI deben dejar clara la migración de `global` a `shared`.

## Criterios de aceptación

1. Un Agent nuevo utiliza Agent Memory privada y no conoce Shared Memory por defecto.
2. Dos Agents con `sharedAccess=none` no pueden leer las memorias privadas del otro ni Shared Memory.
3. Un Agent con `read` puede leer Shared Memory y no puede guardarla ni borrarla.
4. Un Agent con `read-write` puede leer, guardar y borrar Shared Memory.
5. Cambiar `sharedAccess` reinicia solo el Runner afectado y aplica el nuevo system prompt.
6. La API nunca devuelve contenido de memoria dentro de `AgentConfig`; solo configuración de acceso.
7. `scope: "global"` de una sesión anterior se comporta como `shared` y respeta el acceso vigente.
8. Dos escrituras compartidas concurrentes no pierden entradas ni corrompen `MEMORY.md`.
9. Desactivar `PIHUB_MEMORY_ENABLED` elimina las tools e índices de memoria de todos los Agents.
10. Tests cubren env, schema, API, manifiesto, CLI, prompt, tools, migración y concurrencia.

## Fuera de alcance

- Compartir Agent Memory directamente entre dos Agents.
- Memoria transversal de Chat Mode.
- Sincronizar Shared Memory con Knowledge Bases.
- Búsqueda vectorial sobre memoria.
- Compartir memoria entre User Runtimes distintos.
- UI propia de pihub; el dashboard externo será la interfaz principal.
