# Sesión aislada por iniciativa

Cada iniciativa autónoma abre su propia `AgentSession`, separada del chat web y de Telegram. El agente trabaja en segundo plano; el resultado se entrega por callback a otro agente o se anota en memoria.

## Contexto

Hoy un agente tiene sesiones separadas (el web en `ChatHub`, una por chat de Telegram). Con el loop, el agente recibe input de tres fuentes a la vez (web, Telegram, loop). Había que decidir en qué sesión vive una iniciativa autónoma.

## Considered Options

- **Sesión compartida y visible en el web** (rechazado): concurrencia peligrosa — dos prompts solapados en una `AgentSession` que ya usa `followUp` y asume un único flujo; además ensucia el historial del humano con trabajo ajeno.
- **Sesión dedicada de autonomía fija** (rechazado): innecesaria. Una sesión por iniciativa es más limpia y además es el patrón que Telegram ya usa (una sesión por chat).

## Consequences

- Concurrencia segura: el loop y el humano nunca comparten sesión.
- Contexto limpio: una iniciativa no hereda el historial de una conversación ajena.
- El agente no "recuerda" entre iniciativas salvo por su memoria — y eso es deseable: la autonomía se apoya en memoria persistente, no en historial de chat efímero.
- Generaliza el patrón existente de Telegram (sesión por chat) a las iniciativas del loop.
