# Design brief — pihub (handoff para opendesign)

Eres el diseñador de producto de **pihub**: una plataforma web autoalojada para
levantar y orquestar múltiples agentes de IA, cada uno con su propia persona,
modelo, recursos y memoria. Construida sobre pi (pi.dev), corre en Docker y la
opera una sola persona (o un equipo pequeño) sobre su propia infraestructura.
NO es un producto de consumo "cuqui": es una herramienta de developer/operador.
Referencias de tono: Linear, Vercel, Railway, Warp — técnico, sobrio, denso en
información pero limpio, con carácter propio. Idioma de la UI: español.

Diseña el **sistema visual completo** de pihub. Son dos aplicaciones web que
comparten el mismo design system, servidas como ficheros estáticos:

## A) MANAGER (plano de control, una instancia)
- Login por token (pantalla mínima).
- Lista de AGENTES: cada uno con estado (running / stopped / restarting),
  modelo actual, y acciones (arrancar, parar, reiniciar, abrir su UI).
- Crear agente: nombre, modelo, token de Telegram opcional, persona/system
  prompt, paquetes iniciales.
- Paquetes globales: instalar (npm/git/local) y listar/desinstalar.
- Variables de entorno globales: añadir clave+valor (los valores nunca se
  muestran, solo nombres), listar, borrar. Aviso de que guardar reinicia
  agentes.
- Proveedores OAuth (Claude Pro/Max, ChatGPT/Codex): estado conectado/no,
  flujo de autorización.

## B) RUNNER (uno por agente)
- Header: nombre del agente, modelo, indicador de conexión, nueva sesión.
- CHAT: burbujas usuario / asistente, "pensando" (thinking), mensajes de
  sistema, y "tool-chips" (chips que muestran qué herramienta ejecuta el agente,
  con estado ok/error). Streaming de respuesta token a token y botón de abortar.
  Es la vista más usada: cuídala especialmente. Debe funcionar igual de bien en
  móvil (muchos usuarios entran desde el móvil).
- RECURSOS: instalar paquete con selector de ámbito (este agente / global),
  listas de instalados por ámbito, y variables de entorno (mismo patrón que el
  manager pero con ámbito agente/global).

## VISIÓN A FUTURO (déjale hueco al sistema, aunque no lo diseñes en detalle)
pihub tendrá una capa de ORQUESTACIÓN — los agentes actuarán solos, no solo por
chat. Conceptos: "iniciativas" (unidades de trabajo), "agendas" (cola de
iniciativas pendientes por agente), "triggers" (schedule tipo cron o suscripción
a eventos externos), "canales" (chat web / Telegram por donde el agente pide
input humano cuando lo necesita). El design system debe poder crecer hacia un
panel de orquestación (timeline de iniciativas, estados solo/ask/waiting/done)
sin rehacerse.

## RESTRICCIONES
- Se sirve como HTML/CSS/JS estático (hoy es vanilla, sin framework). Prioriza un
  sistema implementable con CSS variables y componentes simples; si propones
  framework, justifícalo.
- Dark-first (es la estética actual) pero define también tema claro. Usa design
  tokens.
- Responsive de verdad: móvil primero para el chat.
- Accesible (contraste, foco, teclado).

## PALETA ACTUAL (punto de partida, libre de evolucionarla)
`bg #101418` · `panel #181e24` · `borde #2a333c` · `texto #e6edf3` ·
`muted #8b98a5` · `acento #4ea1ff` · `peligro #ff6b6b` · `ok #3ecf8e`

Tipografía actual: `system-ui`. Puedes proponer una tipografía con más carácter.

## ENTREGABLES
1. Design system: tokens (color, tipografía, espaciado, radios, sombras), escala
   tipográfica, y catálogo de componentes (botones, inputs, chips, cards, listas,
   tabs, estados de conexión, toasts/feedback).
2. Mockups de cada pantalla (manager y runner), en tema oscuro y claro.
3. Estados: vacío, cargando, error, y —clave en el chat— streaming y
   "reiniciando agente".
4. Specs de interacción de las piezas no obvias (streaming del chat, tool-chips,
   guardado de env que reinicia el agente con su feedback).

Entrega, si puedes, como HTML/CSS de referencia (implementable), no solo imagen.
