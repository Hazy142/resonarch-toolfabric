# ToolFabric

**Open execution infrastructure for AI agents.**

> Real tools. Agent-operated. Human-controlled. Every action leaves a receipt.

ToolFabric by **resonArch** is a provider-agnostic contract and execution layer for AI agents.
It turns high-level user workflows into typed backend operations with explicit capabilities,
authority boundaries, risk classes, receipts, and verification gates.

## Status

**Early implementation / contracts + execution preview.** The architecture defines 112 backend
primitives and 20 standard user tools. P1A/P1B/P1C now provide real read-only local execution for
filesystem, Git, environment, registry, instruction resolution, TypeScript/JavaScript symbol
inspection, dependency/test discovery, deterministic context packing, and immutable exact/lexical
memory retrieval. The full
`P1_READ_PLANE_PASS` gate is not yet claimed, and production readiness remains gated by the
normative conformance plan.

## Core ideas

- workflows are not security boundaries;
- tool semantics live in versioned contracts;
- models may operate tools but cannot grant themselves authority;
- mutating actions bind expected state and durable intent/completion evidence;
- uncertain is a first-class state when a side effect cannot be reconstructed;
- provider adapters project one canonical contract into MCP, OpenAI-compatible, Anthropic, Gemini, CLI, or local runtimes;
- completion claims require evidence on the exact revision being claimed.

## Development

    npm ci
    npm run check

Read AGENTS.md before changing the repository.

## License

Apache-2.0. See LICENSE and NOTICE.
