# Qué queda en pihub, y por qué

> Estado revisado para **v0.6.0** (2026-07-30). Cada entrada identifica qué
> falta, por qué no se implementa aún y qué impacto tiene. No son backlog
> genérico: si el motivo deja de ser válido, la entrada debe eliminarse o
> actualizarse.

## 1. Motor de autonomía: diseño aceptado, sin implementación

Los ocho ADRs de [`adr/`](adr/) describen Loop, Initiative, Agenda, Trigger,
Callback, sesión aislada y recuperación al arrancar. No existen todavía los
módulos que los materializan ni la persistencia que necesitarían.

**Impacto:** el dashboard puede proyectar autonomía contra un fake, pero no hay
una fuente real que ejecute Trigger → Initiative → `waiting_human`.

**Desbloqueo:** implementar el diseño de los ADRs como trabajo de Runtime, sin
reformular la decisión de arquitectura. No debe confundirse con el chat o con
el bridge SSE ya operativo.

## 2. Hardening de Runtime standalone (H01.05/H01.07)

El panel ya no conoce ni abre conexiones a los puertos de Runner. Sin embargo,
el `docker-compose.yml` standalone aún publica `4100-4199` y la imagen base no
impone por sí sola las restricciones de un User Runtime gestionado.

**Impacto:** un actor que alcance la red de ese contenedor puede intentar hablar
directamente con un Runner, evitando el Manager y su autorización.

**Desbloqueo:** cerrar los puertos de Runner en el despliegue standalone y
endurecer la imagen con usuario no root, capabilities eliminadas y filesystem
de solo lectura, sin romper el bridge interno Manager → Runner. El Provisioner
del dashboard ya aplica esa postura para sus User Runtimes; no hay que
duplicarla en el Manager.

## 3. Variables `$VAR` de `models.json` no llegan automáticamente al Runner

El Supervisor no hereda el entorno completo del Manager. Eso protege
`API_TOKEN` y secretos no destinados al Agent, pero un Provider configurado en
`models.json` como `"apiKey": "$MI_KEY"` solo funcionará si `MI_KEY` se pone
en el Env Store global o del Agent.

**Impacto:** una instalación que confiaba en herencia de entorno puede recibir
un error genérico del Runner tras actualizar; el Manager tenía la variable,
pero el Runner no.

**Desbloqueo:** resolver explícitamente las variables que `models.json`
referencia y añadir únicamente esas a la allowlist del Runner, o resolverlas
antes de lanzar el proceso. No se debe deshacer la allowlist completa.

## 4. Herramientas de red en la imagen

La imagen trae `curl`, `git`, `ripgrep`, Node y `uv`/`uvx`; no promete `ping`,
`dig`, `netcat` o `wget`. En un Runtime gestionado con root filesystem de solo
lectura, un Agent tampoco puede instalar herramientas del sistema en caliente.

**Impacto:** un Agent puede intentar instalar una herramienta inexistente y
fallar. En una política de red que bloquea destinos internos, añadir algunas de
ellas tampoco daría por sí solo una capacidad útil.

**Desbloqueo:** decidir qué herramientas justifican entrar en el Dockerfile y
documentar para el Agent la política de red efectiva. No instalar paquetes en
runtime como solución implícita.

## 5. Servicio systemd: no es un sandbox

`scripts/install.sh` instala un servicio nativo. En su modo por defecto corre
como root y el Agent puede administrar el host. `--user <nombre>` reduce
privilegios de sistema, pero conserva red y un `HOME` persistente.

**Impacto:** aplicar de forma silenciosa restricciones pensadas para Docker
cambiaría el producto nativo; no aplicarlas significa que no ofrece aislamiento
entre Agents.

**Desbloqueo:** si se necesita un tercer perfil nativo acotado, diseñarlo de
forma explícita con directivas systemd (`ProtectSystem`, `NoNewPrivileges`,
`CapabilityBoundingSet`, `MemoryMax`, `PrivateTmp`, `IPAddressDeny`) y su
matriz de capacidades. No mezclarlo con el modo Docker gestionado.

## 6. SSE e idempotencia son efímeros

`idempotencyKey`, turnos vivos y la asociación con el WebSocket interno viven
en memoria del Manager. El panel maneja un stream que termina sin evento final
como "stream perdido" y pide reintento explícito.

**Impacto:** un restart del Manager pierde esas referencias. No existe replay
SSE ni `Last-Event-ID`; repetir una clave después de ese restart puede volver a
iniciar el trabajo.

**Desbloqueo:** un buffer/replay durable y una semántica de recuperación entre
instancias. Es una ampliación de contrato separada: no simular replay
reintentando automáticamente el POST desde el panel.

## 7. Metadatos de la imagen Docker

El `Dockerfile` aún declara una label de versión `0.1.0` y un `source` histórico,
aunque la release vigente es `v0.6.0` y el workflow de publicación puede añadir
labels correctas al artefacto distribuido.

**Impacto:** una imagen construida localmente puede exponer metadatos engañosos
a un operador o a una herramienta de inventario; no cambia la ejecución.

**Desbloqueo:** alinear las OCI labels del `Dockerfile` con el repositorio y la
versión construida, o derivarlas del build de forma reproducible. Es cambio de
imagen, no una corrección de contrato v1.

## 8. Diagnóstico de errores de Provider en turnos

Un error del Provider puede llegar desde el Runner como `error`, que el Manager
traduce a `turn-error` con `INTERNAL_ERROR` y mensaje saneado. El Manager no
expone el detalle del Provider al caller.

**Impacto:** el dashboard/panel distinguen un turno fallido de uno terminado,
pero no siempre pueden diagnosticar si la causa concreta fue cuota, credencial
o red sin inspeccionar logs del Runtime.

**Desbloqueo:** definir un vocabulario seguro de errores de Provider, registrarlo
en el origen y propagar solo códigos/mensajes permitidos. Nunca reenviar el
texto crudo de Provider o Runner.

## Decisiones que no se deben deshacer accidentalmente

- El panel usa `/api/v1`, cookie same-origin y CSRF; no recibe el Bearer en
  JavaScript ni abre un WebSocket hacia un Runner.
- Las rutas `/api/*` siguen por compatibilidad del CLI actual. El panel no las
  usa y no deben recibir capacidad nueva.
- `/api/v1` se registra antes del guard legacy `/api/*`, porque ese patrón
  también coincide con el prefijo versionado.
- Las lecturas de env devuelven claves, nunca valores. El store global y el del
  Agent se mantienen separados.
- La build raíz compila `shared` antes de los demás workspaces; Docker parte de
  un árbol limpio y detecta el orden incorrecto.
- `totalTokens: 0` en `turn-complete` es deliberado mientras el Runner no mida
  consumo real; un número inventado sería peor.
