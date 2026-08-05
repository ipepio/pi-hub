---
status: superseded
---

# Canal interno manager→runner para iniciativas

El loop de orquestación vive en el manager, pero las `AgentSession` las crea el runner (`SessionFactory`), que es quien posee el workspace, los recursos, el `AuthStorage` y el `ModelRegistry`. Para ejecutar una iniciativa, el manager no duplica esa maquinaria ni reutiliza el WebSocket del chat web: el runner expone un canal interno dedicado (p.ej. `POST /api/initiative`) que crea una sesión aislada por iniciativa (ver ADR-0003), corre la intención y notifica al manager el resultado (o la necesidad de input humano, que el manager traslada al canal del humano).

## Considered Options

- **Reutilizar el WebSocket del chat web** (rechazado): cero código nuevo, pero se cuela en el `ChatHub` (sesión compartida del web), violando la sesión aislada por iniciativa — el loop y el humano compartirían sesión e historial.
- **El manager crea la sesión él mismo** (rechazado): duplica el `SessionFactory` en el manager y apunta al mismo `workspaceDir`; dos procesos tocando el mismo `AgentSession`/`SessionManager` es frágil.

## Consequences

- La maquinaria de sesiones sigue viviendo en el runner, donde está hoy; el manager solo despacha y escucha resultados.
- Encaja con el modelo de actor: el runner es el actor que posee sus sesiones, el loop le envía iniciativas por un canal dedicado y recibe callbacks.
- El "traslado a canal humano" encaja naturalmente: cuando el runner detecta que la iniciativa necesita input, notifica al manager, que la reenvía al canal web/Telegram del agente.
- Coste: un endpoint nuevo en el runner y un cliente en el manager — la costura inevitable entre dos procesos que ya están separados.

## Contexto posterior

La decisión de que el Runner siga creando las `AgentSession` sigue en pie, pero el canal concreto quedó adelantado por la implementación: el Runner acepta prompts por `/ws` (`packages/runner/src/server.ts:236-280`) y el Manager hace el puente WS→SSE (`packages/manager/src/api-v1/routes.ts:983-990`); no existe `POST /api/initiative` ni notificación de callback/input autónomo. Además, la premisa de que el Runner es dueño exclusivo de `AuthStorage`/`ModelRegistry` ya no describe el sistema desde el módulo de Providers: Manager y Runner tienen instancias del Providers Module que encapsulan ambos recursos (`packages/manager/src/index.ts:17-22`; `packages/runner/src/session.ts:36,44-56`; `packages/providers/src/index.ts:362-372`).

ADR-0013 reemplaza el canal dedicado: una Initiative se ejecuta por el mismo `POST /api/v1/agents/:name/turns`, con una `sessionKey` propia y un campo explícito de origen. Ese camino ya aísla sesiones por `sessionKey` (`packages/runner/src/hub.ts:141-162`), hace el puente WS→SSE (`packages/manager/src/api-v1/routes.ts:983-990`), ofrece abort por ruta dedicada (`packages/manager/src/api-v1/routes.ts:1103-1134`) y deduplica por `idempotencyKey` (`packages/manager/src/api-v1/routes.ts:968-976`). Reutilizarlo evita reconstruir y mantener esas cuatro garantías en un canal paralelo.
