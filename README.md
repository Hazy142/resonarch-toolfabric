# ToolFabric

**Open execution infrastructure for AI agents.**

> Real tools. Agent-operated. Human-controlled. Every action leaves a receipt.

ToolFabric by **resonArch** is a provider-agnostic contract and execution layer for AI agents.
It turns high-level user workflows into typed backend operations with explicit capabilities,
authority boundaries, risk classes, receipts, and verification gates.

## Status

**Early implementation / contracts + execution preview.** The architecture defines 112 backend
primitives and 20 standard user tools. P1A–P1D provide real read-only execution for
filesystem, Git, environment, registry, instruction resolution, TypeScript/JavaScript symbol
inspection, dependency/test discovery, deterministic context packing, immutable exact/lexical
memory retrieval, and explicitly authorized content-addressed HTTPS fetches. P1E adds the
remote-relay contract/client foundation and deterministic in-memory reference counterpart;
real network transports remain a subsequent slice. `P1_READ_BOUNDARY_PASS` is claimed, while the
full `P1_READ_PLANE_PASS` remains open. P2A implements the bounded filesystem-mutation kernel and
P2B implements local Git branch/worktree/commit isolation; neither slice claims
`P2_LOCAL_ACTION_PASS`. P2C adds host-approved process lifecycle and real test execution, with an
isolated change -> failing test -> patch -> passing test -> commit receipt fixture. Host-user
execution is explicitly authorized and is not an OS filesystem/network sandbox. See
[the P2C contract and evidence boundaries](docs/architecture/18-p2c-process-lifecycle.md).
Production readiness remains gated by the normative conformance plan.

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
