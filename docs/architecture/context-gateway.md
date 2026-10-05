# Context Gateway runtime

ToolFabric owns the canonical contracts, evidence and execution semantics. The
in-tree Context Gateway is the OpenAI-compatible proxy that applies those semantics
to long-running model sessions before requests reach an inference provider.

## Runtime flow

1. A client sends an OpenAI-compatible request to the local Context Gateway.
2. The gateway identifies closed function-call/output pairs and leaves open calls
   untouched in the HOT tier.
3. First-seen tool pairs fail open. Once persisted, older closed pairs can be
   represented as WARM metadata or omitted from the active prompt as COLD data.
4. Every persisted tool pair is serialized deterministically and written under its
   SHA-256 digest when `RACG_ARTIFACT_ROOT` is configured.
5. WARM records expose `artifact://sha256:<digest>`, the same reference shape used
   by `src/evidence/artifacts.ts`.
6. ToolFabric receipts can be projected into the compaction model with
   `receiptToToolHistory`; request/result digests and artifact refs remain the
   evidence anchors instead of copying large outputs into future prompts.
7. Retrieval may rehydrate an exact stored pair when it becomes relevant again.

## Authority boundary

The gateway is not an authority source. It may compact and retrieve context, but it
does not widen capabilities, reinterpret risk classes, fabricate receipts, or turn
model output into trusted state. ToolFabric contracts and receipt validation remain
canonical.

## Compatibility

The runtime lives at `packages/context-gateway/`. Existing `RACG_*` environment
variables are retained so the former standalone deployment can migrate without a
configuration flag day.

The original standalone repository is the donor lineage. ToolFabric is now the
integration target for new runtime work.
