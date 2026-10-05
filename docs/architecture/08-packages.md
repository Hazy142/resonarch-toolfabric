# 08 — Repository, package, and implementation plan

The TypeScript reference runtime keeps canonical contracts separate from provider projections.

Public naming: CLI toolfabric; target package family @resonarch/toolfabric-*; canonical contracts under contracts/; provider projections under src/adapters/; workflow contracts under user-tools/.

The repository remains package-private during the implementation preview to prevent accidental npm publication.
MCP is one adapter surface, not the product identity.

The v0.1 adapter classes intentionally implement only canonical descriptor projection and result normalization.
Network/provider invocation is a later P6 claim.
