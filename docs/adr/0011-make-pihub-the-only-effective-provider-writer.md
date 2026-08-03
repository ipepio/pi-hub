---
status: accepted
---

# Make pihub the only writer of effective Provider files

The Providers Module is the only writer of effective `auth.json`, `models.json` and managed ownership metadata. It preserves standalone and OAuth entries, stores API keys separately, writes atomically, and coordinates Runner reloads without interrupting a live turn. Legacy Provisioner materialization is transitional only.
