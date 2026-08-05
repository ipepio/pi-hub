---
status: accepted
---

# SQLite embebido para Agenda y estado terminal de turnos

## Contexto

La Agenda recibe escrituras concurrentes desde Triggers, el Loop, Callbacks e input humano; además necesita consultas por estado y fecha y transacciones que abarquen varias entidades. Los ficheros JSON actuales se escriben de forma atómica mediante fichero temporal y `rename`, pero ese helper no adquiere ningún lock (`packages/providers/src/index.ts:248-256`), por lo que ese patrón no ofrece la coordinación ni la atomicidad multi-entidad que requiere la Agenda.

El modo Gobernador es el valor por defecto y administra el Runtime desde su panel local (`README.md:42-57`). Exigir Postgres o Redis para esta capacidad obligaría a ese servicio autoalojado a desplegar infraestructura externa adicional.

## Decisión

El Manager usa SQLite embebido, como un fichero dentro del volumen persistente, para guardar en una sola capa:

- la Agenda y sus entidades;
- por cada `turnId`, la `idempotencyKey`, el estado terminal y el resultado del turno.

El límite es explícito: se persiste estado terminal, no un log de eventos. Los deltas para reanudación por cursor continúan en el buffer Redis del dashboard, cuyo stream tiene un TTL de 24 horas desde el último evento (`../goguest-ai-dashboard-new/packages/control-plane/src/chat/redis-turn-event-buffer.ts:5-6,35-64`).

## Considered Options

- **Ficheros JSON** (rechazado): hay múltiples escritores, se necesitan consultas por estado y fecha y una transición puede afectar varias entidades atómicamente. El `rename` evita un fichero parcial, pero no coordina escritores ni ofrece transacciones.
- **Postgres o Redis** (rechazado): resolverían concurrencia y consultas, pero romperían el modo Gobernador como servicio autoalojado al imponer una dependencia operativa externa.
- **Log durable de eventos de turno en SQLite** (rechazado): duplica el buffer SSE que ya resuelve deltas y cursor; el alcance de pihub es únicamente el estado terminal.

## Consequences

- Agenda y terminación de turnos pueden actualizarse con transacciones locales y sobrevivir a reinicios del Manager.
- La idempotencia deja de depender únicamente del registro en memoria que hoy se pierde o expulsa entradas (`packages/manager/src/api-v1/turns.ts:1-35`).
- Al implementarse, cierra la parte de estado terminal e idempotencia de la deuda descrita en `docs/PENDIENTE.md:76-88`; el replay de SSE queda fuera de este ADR porque no se almacena un log de eventos.
- ADR-0007 pasa a ser implementable porque el arranque dispone de estado durable para localizar Initiatives que quedaron `running`.
- El esquema, las migraciones y la retención concreta de turnos terminados quedan pendientes de especificar; este ADR no fija esos valores.
