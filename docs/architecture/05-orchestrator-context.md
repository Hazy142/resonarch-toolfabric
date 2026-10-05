# 05 — Orchestrator, task DAG, workers, context, and memory

The control plane is model-independent. Models propose work; durable task state, leases, fencing, receipts, budgets, and authority live outside the model.

Parallel writes are allowed only for disjoint write surfaces or isolated worktrees. Stale leases fail closed.

Context is separated into HOT (active contracts and open calls), WARM (deterministic closed-call records), and COLD (raw content-addressed artifacts).
Semantic retrieval is a candidate generator, never the sole proof of execution. Before a claim or side effect, a semantic hit requires raw source reload.
