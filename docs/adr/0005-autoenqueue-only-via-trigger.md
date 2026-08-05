---
status: accepted
---

# Autoencolado solo vía trigger explícito

Un agente no puede autoencolar iniciativas inmediatamente al terminar una. Para repetir o continuar un trabajo, debe programar un trigger futuro (schedule o suscripción) que el loop ejecutará. No existe el autoencolado inmediato libre.

## Contexto

La auto-asignación —el agente se encarga trabajo a sí mismo al terminar una iniciativa— es la fuente de autonomía, pero sin freno permite bucles infinitos: un agente que razona "mejor lo reviso en 5 minutos" puede quemar LLM para siempre. Hoy ese riesgo no existe porque nada se autoencola.

## Decisión

El autoencolado inmediato libre está prohibido. El agente solo puede crear triggers futuros (deterministas: schedule o suscripción) para repetir o continuar. Las iniciativas nacen de triggers, de callbacks entre agentes, o de input humano — nunca de un agente autoencolándose a sí mismo al instante.

## Considered Options

- **Límite de autoencolados por iniciativa** (rechazado): freno mecánico (máx K derivadas), pero permite K bucles antes de parar y deja la decisión en el LLM.
- **Budget de tokens por iniciativa** (rechazado): freno contable, pero requiere medir coste y propagarlo por toda la cadena A→B→C.
- **Confianza total** (rechazado): el agente se autoencola lo que quiera; riesgo de bucle infinito sin freno.

## Consequences

- El bucle infinito autónomo se elimina por construcción: no hay autoencolado inmediato que se alimente a sí mismo.
- La autonomía se preserva: el agente sigue decidiendo qué hacer después, solo que lo expresa como un trigger futuro en vez de un autoencolado al instante.
- Todos los "futuros" del agente son triggers visibles en su `AgentConfig`, auditables, no iniciativas ocultas encadenándose en una sesión aislada.
- El agente no puede "seguir trabajando ahora mismo por iniciativa propia"; si hay que seguir ahora, es otra iniciativa (callback de otro agente o trigger), no un bucle auto-alimentado.

## Contexto posterior

La promesa de triggers auditables en `AgentConfig` no se cumple en el runtime actual: `AgentConfig` y los schemas de Agent no tienen triggers (`packages/shared/src/types.ts:13-27`; `packages/manager/src/api-v1/schemas.ts:4-17`). La barrera anti-loop sigue siendo buena idea; su mecanismo —quién crea/revoca triggers y dónde se persisten— está por definir antes de codificar la prohibición.

ADR-0014 fija SQLite como persistencia de la Agenda. La v1 implementa únicamente triggers de tipo `schedule`. El esquema nace con un campo `kind`, de modo que añadir suscripciones después sea aditivo, pero sin implementar todavía la ingesta ni el filtro de eventos externos. Para materializar la visibilidad prometida por este ADR, `AgentConfig` necesita un campo de triggers que hoy no existe (`packages/shared/src/types.ts:13-27`); la autoridad concreta para crear y revocar esos triggers sigue pendiente de decidir.
