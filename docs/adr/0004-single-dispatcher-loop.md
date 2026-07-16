# Dispatcher único con concurrencia limitada

El loop de orquestación es un único dispatcher en el manager, no un worker por agente. La concurrencia es un límite configurable (default 1); "worker" no es un proceso persistente sino una iniciativa en vuelo. El loop despacha, y cuántas iniciativas vuelan a la vez es el dial. Nunca se despachan dos iniciativas del mismo agente en paralelo (preserva la sesión aislada por iniciativa, ver ADR-0003).

## Considered Options

- **Un worker por agente** (rechazado): sobre-ingeniería; complica la infra con N procesos persistentes cuando la latencia entre agentes es aceptable para tareas autónomas en segundo plano.
- **Pool de workers sin restricción de agente** (rechazado): rompe la coherencia del agente — dos iniciativas del mismo agente en paralelo significan dos sesiones razonando a la vez sin nada que las sincronice.

## Consequences

- El dial de concurrencia es el control del presupuesto (cuántos LLMs corren a la vez). Vive en el manager.
- Con default 1, el modelo es secuencial puro; subir el dial habilita paralelismo entre agentes distintos sin tocar el código del loop.
- Un agente con agenda larga no bloquea a otros si su iniciativa necesita input humano: la iniciativa se traslada al canal del humano y el worker se libera.
