# pihub

Plataforma autoalojada para levantar y orquestar múltiples agentes de IA, cada uno con su propia persona, modelo, recursos y memoria, construida sobre pi (pi.dev).

## Language

**Agent**:
Una entidad con su propia persona, modelo, recursos y memoria que se puede arrancar y parar. Persiste como configuración entre reinicios y, cuando está arrancada, razona y actúa por sí misma.
_Avoid_: perfil, bot, asistente

## Orquestación

**Loop**:
El dispatcher central del manager que saca iniciativas de las agendas y las ejecuta. Su concurrencia es configurable (por defecto 1) y nunca despacha dos iniciativas del mismo agente a la vez.
_Avoid_: orquestador, scheduler, motor

**Initiative**:
Una unidad de trabajo que el loop despacha y ejecuta. Nace de un trigger, de un callback de otro agente, o de input humano transferido al agente.
_Avoid_: tarea, job, mensaje

**Agenda**:
La cola durable de iniciativas pendientes de un agente. Se llena cuando un trigger se dispara, llega un callback o se transfiere input humano; el loop la vacía despachando una a una.
_Avoid_: lista de tareas, queue

**Callback**:
Una iniciativa que un agente encola en otro para devolverle el resultado de un trabajo previo y reactivar su continuación. No bloquea al emisor.
_Avoid_: respuesta, reply, webhook

**Trigger**:
La condición determinista que dispara una iniciativa: un schedule (cada día a las 9) o una suscripción a un evento externo (una PR en la org X). Es estructurado; no razona. Puede sugerir opcionalmente una skill, pero el agente decide si la usa o razona por libre.
_Avoid_: regla, condición, evento

**Intent**:
La descripción en lenguaje natural de lo que el agente debe hacer cuando un trigger se dispara. Se interpreta al ejecutar, no al configurar. Declara un modo por defecto (solo o ask); el agente puede escalar de solo→ask en runtime, pero no al revés.
_Avoid_: prompt, instrucción, tarea

**Channel**:
La interfaz por la que un agente habla con su humano: el chat web o Telegram. Una iniciativa autónoma se traslada a un canal cuando necesita input del humano.
_Avoid_: interfaz, medio, conexión

**Solo mode**:
El agente trabaja sin pedir input. Al terminar, la iniciativa pasa a `done`.
_Avoid_: automático, desatendido

**Ask mode**:
El agente necesita una decisión del humano. La iniciativa se traslada al canal del humano y queda en espera (`waiting_human`), liberando el loop para despachar a otros. El agente puede escalar de solo a ask en runtime, pero no al revés.
_Avoid_: interactivo, pausado

## Capacidades

**Skill**:
Un paquete de uno o varios ficheros markdown que instruyen al agente sobre cómo hacer algo. Se instala como paquete pi y se invoca con `/skill:laquesea`. No es código que ejecuta; es conocimiento procedimental que el agente carga y sigue con sus tools.
_Avoid_: herramienta, plugin, función, capability

**Secret**:
Una credencial del humano que opera pihub (un token, una API key). El agente la usa pero no la posee; el humano la asigna a agentes vía el env store, con ámbito global (todos los agentes la ven) o por agente (solo ese agente).
_Avoid_: credencial, token, variable (es el valor, no la clave)
