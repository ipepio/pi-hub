---
status: accepted
---

# Keep a dual Provider transition until rollout

The published v0.7 Runtime retains legacy materialization. A future Runtime Release may declare the `managed_http` capability and accept the versioned managed projection. Both paths remain until the fleet rollout is complete; legacy file mutation is removed separately after real Manager/Runner verification.
