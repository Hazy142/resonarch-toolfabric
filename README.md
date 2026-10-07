# ToolFabric

**Open execution infrastructure for AI agents.**

> Real tools. Agent-operated. Human-controlled. Every action leaves a receipt.

ToolFabric by **resonArch** is a provider-agnostic contract and execution layer for AI agents.
It turns high-level user workflows into typed backend operations with explicit capabilities,
authority boundaries, risk classes, receipts, and verification gates.

## Status

**Early implementation / contracts + execution preview.** The architecture defines 112 backend
primitives and 20 standard user tools. P1A–P1E provide full read-only and projection execution across
all declared Read primitives, including AST/symbol code inspection, security scanning, policy compilation,
research bundling, and verified receipt chains. The E2E User-Tool DAGs for `inspect`, `research`, and
read-only `audit` execute with full receipt-chain continuity. The `P1_READ_PLANE_PASS` gate is now
verified and claimed. Production readiness for mutating primitives remains gated by the P2 plan.

## Core ideas

- workflows are not security boundaries;
- tool semantics live in versioned contracts;
- models may operate tools but cannot grant themselves authority;
- mutating actions bind expected state and durable intent/completion evidence;
- uncertain is a first-class state when a side effect cannot be reconstructed;
- provider adapters project one canonical contract into MCP, OpenAI-compatible, Anthropic, Gemini, CLI, or local runtimes;
- completion claims require evidence on the exact revision being claimed.

## Remote Relay Architecture

ToolFabric includes an opt-in execution transport client (`RemoteRelayClient`) and in-memory reference counterpart (`InMemoryRemoteRelayReference`) under `src/relay/remoteRelay.ts`.

- **Contract-Bounded**: Enforces typed versioned envelope schemas (`request/v1`, `response/v1`, `lifecycle/v1`).
- **Opt-In & Local Independence**: Disabled by default (`enabled: false`) with no default hosted endpoint or secret defaults. Local ToolFabric operation remains 100% independent without requiring any remote relay or cloud infrastructure.
- **Flow Control & Bounds**: Strict payload bounds (max 1 MB), in-flight ceilings, request queues with backpressure, and session-isolated request tracking.
- **Reference & Documentation**: See [docs/architecture/15-p1-remote-relay.md](docs/architecture/15-p1-remote-relay.md) for full protocol specification, security boundaries, and custom counterpart implementation guidelines.

## Development

    npm ci
    npm run check

Read AGENTS.md before changing the repository.

## License

Apache-2.0. See LICENSE and NOTICE.
