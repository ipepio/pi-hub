---
status: accepted
---

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

## Contexto posterior

La elección asíncrona no choca con el transporte actual: el Manager hace de puente WS→SSE sin esperar una respuesta RPC bloqueante del Runner. Pero no existe todavía la cola/callback inter-Agent: `toTurnEvent` solo traduce eventos del WS del Runner y no un resultado/continuación (`packages/manager/src/api-v1/turns.ts:64-79,81-134`). La decisión conceptual sigue siendo válida, pero antes de implementarla hay que decidir la persistencia y la semántica de reintentos.

ADR-0014 resuelve la persistencia en SQLite; la semántica de terminación se concreta con dos límites complementarios: cada callback hereda del `parent` su profundidad incrementada en uno y, al superar la profundidad máxima, pasa a `failed` con el motivo; además, toda la cadena queda acotada por un deadline. Es necesario porque los ciclos que «solo vuelven a encolar» pueden ejecutarse indefinidamente, y ADR-0005 no los detiene: un callback lo encola otro Agent, no es autoencolado. Los valores concretos de profundidad máxima y deadline quedan pendientes de decidir.
