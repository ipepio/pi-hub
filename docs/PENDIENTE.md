# Qué queda en pihub, y por qué

> Estado revisado para **v0.7.0** (2026-08-03). Cada entrada identifica qué
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

## 3. Variables `$VAR` de `models.json` en el Runtime Providers Module ✅ Resuelto en `feature/providers-module`

`RuntimeProviders` resuelve explícitamente las referencias `$VAR` desde el Env
Store global y, en el Runner, desde el Env Store del Agent por encima del
Store global. Solo la API key efectiva entra en la instancia privada de
`AuthStorage`; nunca se devuelve por HTTP ni se imprime.

La imagen publicada v0.7.0 todavía no contiene este Module. El comportamiento
queda pendiente de una release candidata de Providers y de su rollout; la
solución no hereda el entorno completo del Manager.

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

## 7. Release separada del Providers Module

El Module profundo, el catálogo first-class, custom Providers, la proyección
managed y el registro de Providers de Extensions están implementados en la rama
`feature/providers-module`, con `npm test` y `npm run typecheck` verdes.

**Pendiente:** construir una imagen candidata, ejecutar Manager/Runner reales y
verificar OAuth, dos Agents del mismo Runtime, turnos vivos durante login/logout,
proyección idempotente y ausencia de secretos antes de publicar una nueva
release. El dashboard debe mantener su camino legacy hasta que esa matriz esté
verde; no se cambia el digest v0.7.0 en este trabajo.

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
