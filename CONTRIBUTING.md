# Contributing to ToolFabric

ToolFabric is evidence-first. Small, reviewable changes are preferred over broad rewrites.

## Pull requests

Every PR states scope, authority boundary, exact tests/evidence, new risk, and non-claims.
Generated files must be reproducible from checked-in source definitions.

Breaking canonical contract changes require a major contract version.
Provider-specific behavior belongs in adapters, never shared semantics.

Do not commit credentials, cookies, tokens, private keys, or production data.
