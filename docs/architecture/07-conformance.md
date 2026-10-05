# 07 — Conformance, testing, benchmarks, and gates

Tests target observable behavior, not prompt strings.

Conformance levels are schema/pure contract, primitive unit, adapter contract, integration, user-tool golden DAG, failure injection, and end-to-end.

Provider adapters must preserve succeeded, failed, denied, cancelled, partial, and uncertain as distinct result states.
Missing provider capability is explicit UNSUPPORTED behavior; it is never silent semantic degradation.

GitHub CI runs the same contract suite on Windows and Linux and verifies that deterministic generators leave the worktree unchanged.

P0 covers contracts, 112 descriptors, 20 workflows, deterministic canonicalization, policy/authority metadata, and receipt integrity.
Later P1–P8 gates remain separate claims.
