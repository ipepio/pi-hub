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
