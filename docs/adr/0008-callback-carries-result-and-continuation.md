# El callback lleva resultado y continuación juntas

Cuando un agente B termina un trabajo que A le encomendó, encola en A una iniciativa de tipo callback que lleva a la vez el resultado ("ya hice X, aquí está lo que encontré") y la continuación ("ahora te toca a ti"). El callback referencia, vía `parent`, la iniciativa de A que lo originó; el loop reactiva esa iniciativa (que estaba `waiting`) en su misma sesión aislada y le inyecta el resultado como contexto.

## Contexto

La interacción entre agentes es asíncrona con callback (ver ADR-0002). La cadena A→B→C→A→D requiere que cada eslabón devuelva el resultado y reactive al anterior. Había que decidir si el resultado (información) y la continuación (control que reactiva) viajan juntos o separados.

## Decisión

Viajan juntos. El callback es a la vez resultado y continuación: un único mensaje con `parent: <id de la iniciativa originadora>` y `result: "..."`. El loop, al despacharlo, reactiva la iniciativa pausada del emisor y le inyecta el resultado como contexto.

## Considered Options

- **Resultado y continuación separados** (rechazado): crea dos estados absurdos — A reactivado sin saber el resultado, o el resultado entregado pero A dormido. En la práctica "ya hice X, continúa tú" siempre va junto.

## Consequences

- Es el patrón actor puro: el mensaje (callback) lleva a la vez el qué (resultado) y el después (reactivación), como un `reply` en el modelo actor.
- El `parent` es la clave que resuelve "¿a qué sesión de A devolver?" — el loop reactiva la iniciativa referenciada.
- La iniciativa que espera un callback debe persistir su contexto (lo que hacía y por qué esperaba) para retomarlo; vive en la agenda durable y puede apoyarse en la memoria del agente.
- No hace falta inventar un buzón de resultados ni un mecanismo de lectura aparte: el callback es la entrega.
