---
status: accepted
---

# Keep a dual Provider transition until rollout

The published v0.7 Runtime retains legacy materialization. A future Runtime Release may declare the `managed_http` capability and accept the versioned managed projection. Both paths remain until the fleet rollout is complete; legacy file mutation is removed separately after real Manager/Runner verification.

## Contexto posterior

La transición dejó de ser hipotética: desde 2026-08-05 el dashboard fija la Runtime Release v0.8.0-rc.1 con `providerProjection: "managed_http"` y digest `sha256:703cf0fe…` (`../goguest-ai-dashboard-new/packages/control-plane/src/runtime/runtime-release.ts:31-38`), y su reconcile cruza el seam HTTP solo cuando esa capacidad está declarada (`../goguest-ai-dashboard-new/packages/control-plane/src/runtime/reconcile-user-runtime.ts:38-46,246-320`). El writer legacy sigue disponible pero ya no es el camino productivo, mientras pihub documenta la imagen v0.7 publicada como legacy y la v0.8 como candidata local aún no publicada (`docs/ESTADO.md:3-5,91-94`). Sigue sin decidirse el criterio verificable de "rollout de flota completo" que permitiría retirar el writer legacy.
