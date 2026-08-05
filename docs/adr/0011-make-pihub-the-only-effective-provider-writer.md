---
status: accepted
---

# Make pihub the only writer of effective Provider files

The Providers Module is the only writer of effective `auth.json`, `models.json` and managed ownership metadata. It preserves standalone and OAuth entries, stores API keys separately, writes atomically, and coordinates Runner reloads without interrupting a live turn. Legacy Provisioner materialization is transitional only.

## Contexto posterior

"Only writer" is the target state, not a description of the current transition: while ADR-0012's dual path is active, the legacy Provisioner still mutates files, so this rule should not be read as violated during rollout. The Providers Module prepares `models.json` before the bootstrap phase (`packages/manager/src/bootstrap.ts:34-35`) and the legacy exception is removed only after the fleet rollout completes (`docs/adr/0012-keep-a-dual-provider-transition-until-rollout.md:7`).
