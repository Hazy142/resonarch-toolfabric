# 02 — Canonical contracts, risk, capabilities, and adapters

Provider formats are projections of canonical ToolFabric contracts.

Risk classes are R0 observe, R1 reversible local mutation, R2 external/repository write or material cost, R3 irreversible/high-impact mutation, and R4 secret/privileged/critical authority.
No adapter may silently lower risk.

The result state uncertain is mandatory when ToolFabric cannot prove whether a non-idempotent external side effect committed.

Canonical hashes use UTF-8 deterministic JSON with sorted object keys and finite JSON numbers. Runtime memory layouts are never hashed.
