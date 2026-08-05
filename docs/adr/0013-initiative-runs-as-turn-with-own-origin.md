---
status: accepted
---

# La Initiative se ejecuta como un turno con origen propio

## Contexto

ADR-0006 decidió un canal interno dedicado, por ejemplo `POST /api/initiative`, antes de que existiera el camino actual de turnos. Hoy el contrato recibe `sessionKey`, `turnId`, `idempotencyKey` y `correlationId` en el turno (`packages/manager/src/api-v1/schemas.ts:25-37`), y el Manager usa esa `sessionKey` al abrir el WebSocket del Runner y traducirlo a SSE (`packages/manager/src/api-v1/routes.ts:947-990`).

## Decisión

Una Initiative se despacha mediante el mismo `POST /api/v1/agents/:name/turns` que los demás turnos, con una `sessionKey` propia de la Initiative y un campo explícito que identifica su origen autónomo. La forma exacta de ese campo en el contrato queda pendiente de especificar; no se crea un segundo protocolo de ejecución. Esta decisión reemplaza ADR-0006.

## Considered Options

- **Canal propio de Initiative** (rechazado): obligaría a reconstruir en paralelo el aislamiento por `sessionKey` del Runner (`packages/runner/src/hub.ts:141-162`), el puente WS→SSE (`packages/manager/src/api-v1/routes.ts:983-990`), el abort por ruta dedicada (`packages/manager/src/api-v1/routes.ts:1103-1134`) y la idempotencia por key (`packages/manager/src/api-v1/routes.ts:968-976`). Mantener dos caminos exigiría conservar esas garantías sincronizadas.
- **Reutilizar la sesión del chat humano** (rechazado): mezclaría historial y contexto con la Initiative, contradiciendo el aislamiento de ADR-0003.

## Consequences

- La Initiative comparte el ciclo de vida y el transporte de un turno, sin una costura Manager→Runner adicional.
- Una `sessionKey` propia conserva una `AgentSession` y un transcript separados del chat humano.
- El origen permite distinguir una ejecución autónoma sin inferirla desde la sesión o el contenido del Intent.
- La idempotencia durable y el estado terminal del turno pertenecen al almacén decidido en ADR-0014; el registro actual todavía es efímero (`packages/manager/src/api-v1/turns.ts:1-35`).
- ADR-0006 pasa a `superseded`; su texto original se conserva como registro de la decisión anterior.
