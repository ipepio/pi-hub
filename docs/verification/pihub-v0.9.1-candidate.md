# Checkpoint de verificación — Pihub v0.9.1 candidate

**Fecha:** 2026-08-10
**Repo:** goguest_agent_pi
**Rama:** `main`
**SHA del commit candidato:** `687be56578985c5907f21c1fa3651456e27060ad` (`git rev-parse HEAD`)

> Este checkpoint fija un SHA local, no publica nada. No se tocó workflow, tag,
> push ni GHCR (eso es A23, gate del propietario).

## Imagen candidata

- Tag local desechable: `pihub:v0.9.1-candidate` (construida con `--pull`).
- Digest local (`docker image inspect --format '{{.Id}}'`):
  `sha256:20f0cacdbcba80e175bb51f066f6720f70677fc4b69041077be035ec27f38121`

## Comandos ejecutados y salida real

### `npm run verify`

```text
# tests 657
# pass 657
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

(`npm run verify` = `npm run typecheck && npm run build && npm test` — PASS.)

### `docker build --pull -t pihub:v0.9.1-candidate .`

```text
#25 unpacking to docker.io/library/pihub:v0.9.1-candidate
#25 unpacking to docker.io/library/pihub:v0.9.1-candidate 13.4s done
#25 DONE 20.0s
```

Build OK.

### Digest local de la imagen

```text
$ docker image inspect pihub:v0.9.1-candidate --format '{{.Id}}'
sha256:20f0cacdbcba80e175bb51f066f6720f70677fc4b69041077be035ec27f38121
```

### Smoke de health

Contenedor arrancado con:

```bash
docker run -d --rm \
  -e API_TOKEN=release-smoke -e PIHUB_PANEL_ENABLED=false \
  -p 127.0.0.1:4400:4000 pihub:v0.9.1-candidate
```

Bucle de espera de hasta 60s con `curl -fsS -H 'Authorization: Bearer release-smoke'
http://127.0.0.1:4400/api/v1/health`:

```text
{"status":"ok","version":"0.9.1","timestamp":"2026-08-10T15:29:09.056Z"}
```

(Segunda pasada limpia del mismo comando:
`{"status":"ok","version":"0.9.1","timestamp":"2026-08-10T15:29:15.859Z"}`)

- Con Bearer `release-smoke` → HTTP 200, `status: ok`, `version: 0.9.1`.
- Sin Bearer → HTTP 401 (rechazo correcto).

Logs del contenedor:

```text
(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[pihub] STARTUP_RECOVERY_CLEAN running=0 deadline=0
[pihub] manager escuchando en :4000 (panel desactivado)
```

### Estado del repo tras el smoke

```text
$ git rev-parse HEAD
687be56578985c5907f21c1fa3651456e27060ad
$ git diff --check      → PASS
$ git status --short
?? ARCHITECTURE_MAP.md          (untracked, fuera del alcance)
?? docs/verification/pihub-v0.9.1-candidate.md
```

## Teardown y limitaciones

El contenedor de smoke se destruyó al terminar (`--rm` + `docker rm -f`).
No hubo push, tag nuevo ni publicación de imagen; el digest local queda como
referencia del checkpoint, no como digest público de GHCR.
