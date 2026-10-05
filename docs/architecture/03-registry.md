# 03 — Backend registry

The registry contains exactly 112 primitives in 14 families of eight.
Each primitive is intentionally small; workflows compose primitives instead of growing god-tools.

contracts/tools/registry.source.json is the human-reviewable source definition.
scripts/generate-registry.mjs deterministically materializes each checked-in descriptor and registry.snapshot.json.
New primitive IDs require contract review and a new atomic side-effect, authority, or observability need.
