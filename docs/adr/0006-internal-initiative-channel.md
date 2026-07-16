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
