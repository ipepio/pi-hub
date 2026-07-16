# Interacción asíncrona con callback

Cuando un agente A necesita que B haga algo, A encola "haz X y avísame" en B y sigue libre. B, al terminar, encola un callback en A. Nadie se bloquea esperando; los ciclos (A→B→A) no deadlockean, solo vuelven a encolar.

## Contexto

La cadena A→B→C→A→D requiere que cada eslabón devuelva el resultado al anterior. Había que decidir si el emisor se bloquea esperando (síncrono) o sigue libre (asíncrono).

## Considered Options

- **Síncrono** (rechazado): el emisor se bloquea hasta tener respuesta. Un ciclo A→B→A es un deadlock directo, y un agente bloqueado no puede atender nada más.
- **Híbrido** (rechazado): innecesario; el asíncrono puro ya cubre todos los casos sin añadir complejidad.

## Consequences

- No hay deadlocks con cadenas largas ni con ciclos.
- Cada agente queda libre para atender otras iniciativas mientras espera.
- El agente debe recordar por qué esperaba algo; se apoya en la memoria persistente, que ya existe en pihub.
- El callback lleva a la vez el resultado y la continuación (ver ADR-0008).
