# Loop de orquestación central en el manager

La autonomía y la interacción entre agentes vive en un loop de orquestación central en el manager, como infraestructura de plataforma (código, sin LLM), que agenda y enruta iniciativas. Los agentes siguen siendo procesos y sesiones individuales que el loop despierta. La proactividad es propiedad de la plataforma, no de un agente especial.

## Contexto

pihub hoy es estrictamente reactivo: un agente solo actúa cuando un humano le manda un prompt. Para la autonomía había que decidir dónde vive el mecanismo que la hace posible.

## Considered Options

- **Cada agente con su propio loop + bus compartido** (rechazado): obliga a reescribir el runner como proceso perpetuo, inventar un bus de mensajes y pierde el control central de cuándo y cuánto corre cada agente.
- **Un orquestador que es él mismo un agente con LLM** (rechazado): duplica la inteligencia en el orquestador. La inteligencia debe vivir en cada agente; un agente orquestador es un caso de uso que se construye encima —otro agente al que el loop le da turnos—, no la base.

## Consequences

- Encaja con la forma actual de pihub: el manager ya es dueño del ciclo de vida de los procesos y del supervisor.
- Mantiene a cada agente como su propia identidad y proceso, que es lo que se confirmó del concepto de Agent.
- La interacción entre agentes es trivial: encolar en la agenda de otro, porque el manager ya los conoce a todos.
- Permite control de concurrencia y presupuesto centralizado (ver ADR-0004).
