# H09 — Exponer subida de ficheros en `/api/v1`

> **Estado: completada.** Publicada en `v0.4.0` y mantenida en `v0.6.0`.
> La referencia vigente es [`../manager-api-v1.md`](../manager-api-v1.md) §8;
> esta task conserva el análisis y los criterios originales como historial.

**Va antes que** la T08 del dashboard, que no puede empezar sin esta ruta.

## Goal

Que el control plane pueda dejar un fichero en el workspace de un Agent, sin ver
nunca el puerto del Runner.

## Criterios de aceptación

1. `POST /api/v1/agents/:name/uploads` acepta `multipart/form-data` con un campo
   `file` y devuelve `{ path, name, size, type }` — el mismo cuerpo que ya
   devuelve el Runner, sin campos añadidos.
2. El `path` devuelto es **relativo al workspace** (`uploads/1234-informe.csv`).
   Nunca absoluto: un `/data/...` filtraría la topología interna del contenedor,
   que la spec §7 prohíbe.
3. Un Agent inexistente responde `AGENT_NOT_FOUND` **antes** de mirar el body —
   mismo orden que `POST /agents/:name/sessions`, para no revelar si el payload
   era válido.
4. Sin credencial de servicio: `MISSING_AUTH`. Con una que no vale:
   `INVALID_AUTH`. Nunca acepta cookie de panel.
5. Un fichero por encima del máximo responde un error del catálogo cerrado, no el
   texto crudo del Runner.
6. El puerto del Runner no aparece en ninguna respuesta ni en ningún log.
7. `npm test` verde y `npm run test:contract-red` verde con el Manager arrancado.
8. La spec `docs/manager-api-v1.md` documenta la ruta en una sección `4.6`.

## Análisis

### Lo que ya existe

`packages/runner/src/server.ts:104` tiene `POST /api/upload` funcionando: valida
que venga un `File`, corta a `MAX_UPLOAD_BYTES` (50 MB), **sanea el nombre**
(`replace(/[^\w.\-]+/g, "_")`, 120 caracteres) y escribe en
`workspace/uploads/{timestamp}-{nombre}`. Lo usa el panel.

O sea: la capacidad está. Lo que falta es exponerla por la interfaz privada.

### Lo que hay que hacer

Una ruta en `packages/manager/src/api-v1/routes.ts` que reenvíe el multipart al
Runner del Agent y traduzca su respuesta. El patrón está a la vista en
`POST /agents/:name/turns`: resolver el Agent, obtener su estado (y con él el
puerto interno), hablar con `127.0.0.1:{port}` y **no devolver nunca ese puerto**.

**No reimplementes el guardado.** El saneado del nombre y el límite de tamaño ya
están en el Runner y son la parte delicada. Duplicarlos en el Manager crea dos
sitios donde arreglar el mismo fallo el día que aparezca.

### Por qué no va en el turno

Sería tentador añadir un campo de adjuntos a `createTurnV1Schema` y resolverlo en
una sola llamada. No lo hagas: subir y conversar tienen ritmos distintos —un
fichero de 50 MB no puede bloquear la apertura del SSE del turno— y el turno es
idempotente por `idempotencyKey`, mientras que una subida repetida deja dos
ficheros. Mezclarlos rompe esa garantía.

El fichero se sube primero y el turno lo menciona por su `path`.

### Trampa

`/api/v1` se monta **antes** que el guard `app.use("/api/*")` del panel — está en
`docs/PENDIENTE.md` §Decisiones que conviene no deshacer. Si registras la ruta
fuera de `createApiV1Router`, una petición sin credencial devolverá el envelope
viejo y los contract tests fallarán por una razón que no tiene nada que ver con
subir ficheros.

### Al terminar

Publicar `v0.4.0` (tag `v*`, el workflow publica solo) y pasarle el digest al
dashboard, que tiene que fijarlo en seis sitios — están listados en su
`docs/tasks/T08`.
