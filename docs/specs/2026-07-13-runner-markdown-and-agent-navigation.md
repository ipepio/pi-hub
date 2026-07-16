# Spec — Markdown en el chat y acceso al Agent desde el Manager

## Problem Statement

La conversación de un Agent presenta actualmente las respuestas como texto plano. Como consecuencia, el Markdown que produce el Agent —incluidos encabezados, listas, código en línea y bloques de código— se muestra con sus caracteres de sintaxis, en vez de como contenido legible y estructurado.

Además, el Manager lista los Agents como tarjetas operativas, pero la conversación de un Agent no es el destino natural al pulsar su tarjeta. El operador debe localizar y pulsar una acción separada para abrir la UI. Una vez en la conversación, necesita poder administrar los recursos que dan capacidades al Agent, como skills, paquetes, prompts y templates, sin volver al Manager.

## Solution

El Runner renderizará las respuestas del Agent como Markdown seguro y progresivo. El contenido será legible durante el streaming y, al completarse cada respuesta, tendrá semántica visual para bloques de código y el resto de elementos Markdown soportados. El texto que envía el humano seguirá mostrándose literalmente, sin interpretar Markdown.

Cada tarjeta de Agent del Manager permitirá abrir su Runner al pulsar el área principal de la tarjeta, llevando directamente a su conversación. Los controles de ciclo de vida, apertura explícita y borrado mantendrán comportamientos independientes y no activarán esa navegación accidentalmente.

La vista de Recursos del Runner será el lugar desde el que el operador administra las capacidades instalables del Agent —incluidas skills, extensiones, prompts y templates— y los secretos/configuración por ámbito Agent o global. La navegación desde la conversación a Recursos y de vuelta al chat conservará el funcionamiento existente.

## User Stories

1. Como operador de pihub, quiero leer una respuesta del Agent con encabezados renderizados, para distinguir su estructura sin interpretar almohadillas manualmente.
2. Como operador de pihub, quiero ver párrafos Markdown separados correctamente, para que las explicaciones extensas sean legibles.
3. Como operador de pihub, quiero que las listas ordenadas y no ordenadas del Agent se presenten como listas, para seguir pasos y opciones con claridad.
4. Como operador de pihub, quiero que el código en línea se diferencie del texto normal, para reconocer identificadores, comandos y fragmentos técnicos.
5. Como operador de pihub, quiero que los bloques de código fenced se muestren como bloques de código, para copiar y revisar ejemplos sin ruido de sintaxis Markdown.
6. Como operador de pihub, quiero que el contenido de un bloque de código conserve sus saltos de línea e indentación, para que siga siendo válido y comprensible.
7. Como operador de pihub, quiero que las separaciones horizontales Markdown se distingan visualmente, para reconocer cambios de sección en respuestas largas.
8. Como operador de pihub, quiero que el texto vaya apareciendo mientras el Agent responde, para no esperar al final de una respuesta larga.
9. Como operador de pihub, quiero que el streaming no produzca HTML roto ni una interfaz que salte erráticamente cuando un token completa una construcción Markdown, para poder seguir la respuesta en curso.
10. Como operador de pihub, quiero que el cursor de streaming continúe indicando que el Agent está generando contenido, para conocer el estado de la respuesta.
11. Como operador de pihub, quiero que una respuesta finalizada deje de mostrar el cursor de streaming, para saber que ya está completa.
12. Como operador de pihub, quiero que el contenido recibido del Agent se trate como no confiable, para que una respuesta no pueda ejecutar scripts ni inyectar interfaz en mi navegador.
13. Como operador de pihub, quiero que mis propios mensajes sigan mostrándose como texto literal, para que un prompt que contiene Markdown o código no cambie de significado visualmente.
14. Como operador de pihub, quiero que los mensajes de pensamiento, sistema y las chips de herramientas mantengan su presentación actual, para no perder señales operativas del Agent.
15. Como operador de pihub, quiero pulsar el área principal de la tarjeta de un Agent en el Manager, para abrir su conversación sin buscar una acción secundaria.
16. Como operador de pihub, quiero que el destino de esa navegación sea el Runner del Agent seleccionado, para hablar con el Agent correcto.
17. Como operador de pihub, quiero abrir la conversación incluso si el Agent está detenido, para conservar una ruta clara hacia su interfaz y recibir su estado allí.
18. Como operador de pihub, quiero que pulsar Iniciar, Detener o Reiniciar no abra la conversación, para operar el ciclo de vida sin navegación inesperada.
19. Como operador de pihub, quiero que pulsar Borrar no abra la conversación, para que la confirmación de borrado sea inequívoca.
20. Como operador de pihub, quiero que la tarjeta navegable sea operable con teclado y anuncie su destino, para usar el Manager de manera accesible.
21. Como operador de pihub, quiero conservar una acción explícita para abrir la UI en una pestaña independiente, para comparar el Manager y la conversación simultáneamente cuando lo necesite.
22. Como operador de pihub, quiero abrir Recursos desde la vista del Agent, para administrar sus capacidades sin regresar al Manager.
23. Como operador de pihub, quiero instalar un paquete en el ámbito del Agent desde Recursos, para añadir capacidades solo a ese Agent.
24. Como operador de pihub, quiero instalar un paquete global desde Recursos, para compartir capacidades con todos los Agents.
25. Como operador de pihub, quiero gestionar paquetes que contengan skills, extensiones, prompts o templates, para adaptar cómo trabaja el Agent.
26. Como operador de pihub, quiero ver los recursos instalados separados por ámbito Agent y global, para entender qué capacidades hereda el Agent.
27. Como operador de pihub, quiero quitar un recurso desde la vista del Agent, para retirar capacidades que ya no necesito.
28. Como operador de pihub, quiero recibir feedback de instalación, eliminación y reinicio, para saber si un cambio de recursos se aplicó.
29. Como operador de pihub, quiero definir y quitar secretos/configuración por ámbito desde Recursos sin ver sus valores almacenados, para administrar el Agent sin exponer credenciales.
30. Como operador de pihub, quiero volver a Chat desde Recursos sin perder la sesión ni los mensajes que ya veo, para alternar entre conversación y configuración eficientemente.
31. Como operador de pihub, quiero que estas interacciones funcionen también desde pantallas pequeñas, para administrar y conversar con un Agent desde móvil.

## Implementation Decisions

- El punto de extensión de Markdown será el renderer de contenido de mensajes del Runner: los eventos de texto del Agent acumularán su fuente Markdown y actualizarán una representación renderizada segura durante el streaming.
- La representación debe soportar, como mínimo, encabezados, párrafos, énfasis, enlaces, listas ordenadas y no ordenadas, citas, reglas horizontales, código en línea y bloques de código fenced. El código conservará whitespace y no interpretará su contenido como HTML.
- El renderer sanitizará el resultado antes de insertarlo en el DOM. No se usará la inserción de HTML no confiable sin sanitización. Los enlaces renderizados deberán ser seguros para navegación web.
- Los mensajes del humano, los mensajes del sistema y el contenido de pensamiento no pasan por el renderer Markdown; se conservan como texto plano y con sus estilos y semántica actuales.
- La actualización de streaming debe renderizar a partir de la fuente acumulada, no de HTML incremental. Las construcciones incompletas de Markdown se degradarán de forma legible hasta que se cierren.
- Los estilos del chat añadirán tipografía y espaciado específicos para elementos Markdown, con tratamiento diferenciado y desplazable para bloques de código. Mantendrán los tokens visuales, temas oscuro/claro y comportamiento responsive del sistema actual.
- La zona informativa de cada tarjeta de Agent en el Manager será un único destino navegable y accesible hacia el Runner del Agent. Tendrá semántica de enlace o botón equivalente, foco visible y activación por teclado.
- Las acciones operativas de la tarjeta seguirán siendo controles independientes; su propagación de eventos se aislará de la activación de la tarjeta.
- La acción explícita de abrir la UI continuará disponible para abrir el Runner en otra pestaña. La activación de la tarjeta abrirá el Runner como navegación principal de la pestaña actual.
- Recursos seguirá siendo una vista del Runner. Su catálogo de paquetes representa recursos instalables de pi, por lo que cubre skills, extensiones, prompts y templates sin crear flujos de instalación distintos por tipo.
- La administración de recursos y variables conservará los ámbitos global y Agent, el modelo de reinicio existente y la regla de no devolver valores de secretos.
- No se cambia el modelo de Agent: un Agent sigue siendo la entidad con persona, modelo, recursos y memoria. Esta mejora cambia sus superficies de conversación y administración, no su ciclo de vida ni el loop de orquestación.

## Testing Decisions

- La costura principal de pruebas será el renderer de mensajes del Runner: se probará su entrada Markdown y el DOM seguro/semántico resultante, no detalles internos de nodos transitorios.
- Los casos de Markdown cubrirán encabezados, párrafos, listas, código en línea, bloques fenced con saltos de línea, reglas horizontales, construcciones incompletas durante streaming y contenido hostil que deba permanecer inerte.
- Se comprobará que el flujo de deltas conserva el cursor durante streaming y que la finalización lo elimina sin perder el contenido renderizado.
- Se comprobará que los mensajes del humano permanecen como texto literal, incluidos caracteres Markdown y HTML.
- La costura de navegación del Manager será una tarjeta de Agent renderizada: se comprobará que activar su destino principal construye la URL del Runner correcta y que las acciones de ciclo de vida/borrado no producen navegación.
- Se comprobará interacción por teclado y foco visible para el destino de conversación.
- La regresión de Recursos verificará instalación, eliminación, separación por ámbito y feedback de los flujos existentes desde la vista del Runner.
- Se conservarán las comprobaciones actuales de build de TypeScript y se añadirán comprobaciones de navegador para el chat en escritorio y móvil, ambos temas, incluyendo bloques de código largos y una respuesta en streaming.

## Out of Scope

- Editar desde el Runner la identidad/configuración estructural del Agent, como nombre, modelo, puerto, token de Telegram o SYSTEM.md.
- Añadir edición individual de archivos internos de una skill, prompt o template instalada; esta entrega administra paquetes de recursos, no sus fuentes.
- Crear un editor Markdown para los mensajes del humano.
- Persistir o rehidratar el historial del chat al recargar la página.
- Cambiar el protocolo WebSocket, el ciclo de vida del Agent, la memoria, Telegram o la arquitectura de orquestación.
- Rediseñar globalmente el Manager o el Runner fuera de los componentes afectados.

## Further Notes

- La especificación usa la terminología del proyecto: Agent para la entidad administrada y Runner para su interfaz/proceso de conversación.
- El repositorio no configura un issue tracker ni su vocabulario de triage; por ello esta spec se guarda localmente y no se puede publicar ni etiquetar `ready-for-agent`.
