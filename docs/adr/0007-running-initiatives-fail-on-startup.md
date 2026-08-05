---
status: accepted
---

# Iniciativas running se marcan failed al arranque

Cuando el manager arranca, toda iniciativa que en disco estaba `running` se marca `failed` y no se reejecuta. No hay reencolado automático ni reconciliación con el runner.

## Contexto

El manager es un proceso que puede morir (crash, reinicio del contenedor, OOM). Si cae a mitad de una iniciativa `running`, al arrancar no sabe si el runner la terminó, la abandonó o sigue corriendo. Es el problema clásico de orphaned work en un sistema distribuido.

## Decisión

Política de consistencia: preferir no duplicar efectos secundarios sobre no perder trabajo. Toda iniciativa `running` al arranque se marca `failed`.

## Considered Options

- **Reencolar como `pending`** (rechazado): duplica trabajo. El caso crítico es la PR comentada dos veces: un efecto visible fuera de pihub. Reencolar produce duplicados.
- **Reconciliación con el runner** (rechazado): preciso, pero requiere un protocolo de heartbeat/confirmación entre manager y runner, que ya tiene suficiente complejidad.

## Consequences

- No se producen efectos secundarios duplicados (comentarios dobles, emails enviados dos veces). El coste es perder el progreso de iniciativas que estaban corriendo.
- El coste es acotado: unos minutos de trabajo de LLM, infrecuente (solo en crashes).
- La autonomía se recupera sola: el trigger que originó la iniciativa (si era un schedule) volverá a disparar; si era un evento, el humano puede reencolar; el agente puede detectar "esto falló a medias" desde su memoria.

## Contexto posterior

La política no es ejecutable hoy: no hay Initiative durable ni campo `running` de Initiative que inspeccionar; al arrancar se leen Agents y se inician los que tienen `enabled` (`packages/manager/src/supervisor.ts:73-83`; `packages/shared/src/types.ts:13-27`). Tampoco hay estado durable de turnos: al reiniciar se pierden las referencias de idempotencia y los WS vivos, y una key repetida puede volver a ejecutar el turno (`packages/manager/src/api-v1/turns.ts:1-12`). Debe aclararse qué significa "failed" para un trabajo con side effects y cómo coordina pihub con el dashboard.

La garantía de este ADR se limita al reintento tras un crash: evita repetir el turno que quedó `running`. No impide duplicar efectos entre ejecuciones sucesivas de un Trigger; la misma PR podría volver a comentarse en la siguiente ejecución programada. Esa segunda garantía corresponde al diseño del Intent y a cómo este reconoce los efectos que ya produjo, no a la recuperación de pihub.
