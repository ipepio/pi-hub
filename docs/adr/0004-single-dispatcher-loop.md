---
status: accepted
---

# Dispatcher único con concurrencia limitada

El loop de orquestación es un único dispatcher en el manager, no un worker por agente. La concurrencia es un límite configurable (default 1); "worker" no es un proceso persistente sino una iniciativa en vuelo. El loop despacha, y cuántas iniciativas vuelan a la vez es el dial. Nunca se despachan dos iniciativas del mismo agente en paralelo (preserva la sesión aislada por iniciativa, ver ADR-0003).

## Considered Options

- **Un worker por agente** (rechazado): sobre-ingeniería; complica la infra con N procesos persistentes cuando la latencia entre agentes es aceptable para tareas autónomas en segundo plano.
- **Pool de workers sin restricción de agente** (rechazado): rompe la coherencia del agente — dos iniciativas del mismo agente en paralelo significan dos sesiones razonando a la vez sin nada que las sincronice.

## Consequences

- El dial de concurrencia es el control del presupuesto (cuántos LLMs corren a la vez). Vive en el manager.
- Con default 1, el modelo es secuencial puro; subir el dial habilita paralelismo entre agentes distintos sin tocar el código del loop.
- Un agente con agenda larga no bloquea a otros si su iniciativa necesita input humano: la iniciativa se traslada al canal del humano y el worker se libera.

## Contexto posterior

El límite de una Initiative por Agent no lo impone pihub hoy: el POST de turnos no rechaza un segundo turno del mismo Agent y abre un WS por cada petición/key (`packages/manager/src/api-v1/routes.ts:947-990`), mientras el Runner permite múltiples `ChatHub` por key (`packages/runner/src/hub.ts:154-162`). Hoy la serialización por Agent la aplica el dashboard con un lock de Redis (`../goguest-ai-dashboard-new/packages/control-plane/src/agents/execute-agent-turn.ts:18-31`; `../goguest-ai-dashboard-new/packages/control-plane/src/agents/redis-agent-turn-lock.ts:20-40`). Ese lock externo no sustituye decidir a quién pertenece ese límite: si el futuro dispatcher de pihub debe imponer el mismo límite, otro límite o una política por fuente.

El alcance queda acotado a Initiatives entre sí: no serializa una conversación humana contra una Initiative autónoma. Las sesiones en paralelo ya forman parte del diseño actual: `SessionHubRegistry` mantiene un `ChatHub` y una `AgentSession` por `sessionKey` (`packages/runner/src/hub.ts:141-162`) y Telegram mantiene una `AgentSession` por chat (`packages/runner/src/telegram.ts:10-33`). Por tanto, el dispatcher aplica el límite de ADR-0004 a sus propias Initiatives sin bloquear al humano.
