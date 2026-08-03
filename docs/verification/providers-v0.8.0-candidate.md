# Checkpoint de verificación — Providers v0.8.0 candidate

**Fecha:** 2026-08-03  
**Repositorio:** pihub  
**Rama:** `release/v0.8.0-providers-candidate`  
**Ancestro Skills:** `6008a7c`  
**Feature Providers:** `df1f533`  
**Fix reload:** `add6a88`  
**Commit candidate de código/versionado:** `c16333120cddad4a0a051214610570b549d72c9b`

## Imagen

- Tag local desechable: `pihub:v0.8.0-candidate`.
- Imagen construida desde `c163331`: `sha256:7acd750d64f9f7f62af3410baff241a1d3512add1d372eb448c1f50ac65fbf28`.
- OCI version: `pihub:0.8.0`; OCI revision: `c163331`.
- Contiene `@pihub/providers`, Skills v0.7 y el fix `add6a88`.
- Se reconstruirá desde el commit final que incluya estos informes antes del
  punto de autorización. No se usó `latest`.

## Contratos probados

La Interface del Module se verificó por `RuntimeProviders.snapshot()`,
`RuntimeProviders.apply(...)` y `RuntimeProviders.resolveModel(...)` contra
filesystem temporal:

- built-ins, `models.json` y Provider sin auth;
- custom Provider, API key separada de `models.json`, rollback y escrituras
  atómicas;
- proyección managed replace idempotente, preservación de standalone/OAuth y
  ausencia de API key en snapshots;
- OAuth configurado/desconectado y logout con recarga;
- `$VAR` con Env Store global y precedencia por Agent, con Manager/Runner
  coherentes;
- registro de Provider de Extension solo detrás del Runner;
- colisiones y errores de configuración tipados/redactados cubiertos por la
  suite del Module y API v1.

Las rutas HTTP probadas fueron `/api/v1/models`, `/api/v1/providers`,
`PUT /api/v1/providers/custom/:providerId`, `PUT /api/v1/managed/providers` y
las rutas OAuth. `PUT /managed/providers` exige Bearer de servicio, reemplaza
solo ownership managed, conserva entradas standalone y no devuelve API keys.

## Contract Red reproducible

La suite original llegó a `0/39` cuando no existía Manager real. Se investigó
la causa: no era un fallo de contrato, sino ausencia de proceso/Provider. Se
preparó un seam OpenAI-compatible local determinista, con `models.json`,
`PIHUB_DEFAULT_MODEL`, Env Store y Runner compartiendo el mismo catálogo. La
suite conserva su modelo por defecto y admite `PIHUB_CONTRACT_MODEL` únicamente
para inyectar ese seam reproducible.

```text
npm run typecheck                                      PASS
npm test                                               PASS — 220/220
PIHUB_DEFAULT_MODEL=local/deterministic                configurado
PIHUB_CONTRACT_MODEL=local/deterministic               configurado
npm run test:contract-red --workspace=packages/manager PASS — 39/39
npm run build                                          PASS
npm run typecheck                                      PASS
npm test                                               PASS — 220/220
git diff --check                                       PASS
```

El servidor local no fue incluido en el repositorio ni en la imagen; fue un
seam externo temporal y determinista. No se usaron credenciales de Provider
real para este contract-red.

## OAuth real y Manager/Runner

Se usó `openai-codex` exclusivamente en `/tmp/pihub-v080-oauth-candidate`, con
API token de servicio local y `PIHUB_DATA_DIR` propio. `~/.pi/agent/auth.json`
no fue leído ni modificado.

Resultado del journey real:

1. Provider inicialmente desconectado.
2. Login OAuth browser completado mediante callback local `localhost:1455`.
3. Provider conectado y catálogo OAuth visible.
4. Manager y Runner coincidieron en los cuatro Models Codex y en
   `configured: true`.
5. Agent creado/reiniciado con un Model Codex.
6. Primer turno real terminó `turn-complete`.
7. Segundo turno real inició; logout se ejecutó mientras estaba vivo.
8. El turno activo terminó correctamente; la recarga de Providers fue diferida
   y no cortó el turno.
9. Snapshot posterior mostró `missing_credentials`; el Runner también quedó sin
   credencial configurada.
10. Turno posterior terminó en `turn-error`, sin reutilizar la credencial revocada.
11. Manager y Runner se reiniciaron; Agent persistió `running`, Provider siguió
    desconectado y el catálogo mantuvo el estado revocado.

Durante el checkpoint no se escribieron tokens, cookies, códigos ni callbacks
completos en este documento, logs de verificación o fixtures. Un primer intento
con flujos OAuth concurrentes produjo un state mismatch; se destruyó el Runtime
y el segundo intento, con un único flujo, pasó correctamente.

## Teardown y limitaciones

El Runtime OAuth, sus Agents, volumen, procesos Manager/Runner y callback local
fueron destruidos. No se tocó infraestructura ajena.

El rollout M4 de una flota que empiece sobre v0.7 y migre mediante el endpoint
Owner-only del dashboard no se declara ejecutado en este checkpoint; está
registrado como pendiente en la matriz del dashboard. También queda pendiente
la publicación GHCR y la fijación del digest productivo.

**Ausencia de secretos:** confirmada para snapshots, respuestas HTTP, errores,
logs de verificación, fixtures y documentos. No hubo push, tag nuevo ni
publicación de imagen.
