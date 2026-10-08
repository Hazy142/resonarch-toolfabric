# P3B — MCP execution surface

P3B exposes ToolFabric's existing execution runtimes through the official Model Context Protocol TypeScript SDK v2.

## Implemented scope

- MCP protocol revision 2026-07-28 through the stable v2 SDK.
- Local stdio serving through `serveStdio()`.
- Stateless Streamable HTTP through `createMcpHandler()` on `/mcp`.
- HTTP is intentionally loopback-only in P3B.
- Tool discovery is generated from canonical ToolFabric descriptors.
- Only tools with a real executor, an allowed tool ID, and every required host capability are exposed.
- MCP arguments are validated against the descriptor JSON Schema plus the reserved optional `_toolfabric` metadata object.
- The workspace root, capability set, approval allowlist, process plans, and Git identity come from host configuration, never from the model.
- `tools/call` is translated into a canonical `resonarch.toolfabric.call/v1` and dispatched into the existing read, filesystem mutation, Git isolation, or process lifecycle runtime.
- MCP tool results return the canonical ToolFabric result plus receipts in `structuredContent`.
- Non-success ToolFabric statuses are projected with MCP `isError: true`.

## Reserved call metadata

Canonical tool arguments stay at the top level. MCP-only execution metadata lives under `_toolfabric`:

```json
{
  "path": "src/example.ts",
  "old_text": "before",
  "new_text": "after",
  "_toolfabric": {
    "task_id": "optional-task-chain",
    "trace_id": "optional-trace",
    "approval_ref": "host-issued-approval",
    "expected_state": {
      "exists": true,
      "sha256": "sha256:..."
    },
    "idempotency_key": "optional-client-key",
    "deadline_ms": 10000
  }
}
```

The client cannot widen the descriptor timeout: `deadline_ms` is clamped to the canonical tool default. Supplying an `approval_ref` does not grant approval; the referenced value must already be present in the host authority configuration.

## Host configuration

Example:

```json
{
  "workspace_root": "D:/work/project",
  "artifact_root": "D:/work/.toolfabric-artifacts",
  "registry_root": "./contracts/tools",
  "authority": {
    "capabilities": ["fs:read", "fs:write"],
    "approved_refs": ["approval:local-edit"],
    "require_approval": true
  },
  "allow_tools": ["fs.read", "fs.patch"]
}
```

Relative paths are resolved relative to the configuration file. Unknown configuration fields fail closed.

## Running

Build first:

```sh
npm run build
```

Local MCP host / IDE child process:

```sh
node dist/src/cli.js mcp stdio --config path/to/mcp.json
```

Local Streamable HTTP:

```sh
node dist/src/cli.js mcp http --config path/to/mcp.json --port 8787
```

The HTTP endpoint is `http://127.0.0.1:8787/mcp`. Non-loopback binds are denied until authenticated remote serving is implemented.

## Security boundary

MCP is a transport and projection layer, not an authority source.

A client cannot:

- select a different workspace root;
- grant itself capabilities;
- add approved references to the host allowlist;
- register process execution plans;
- widen the canonical deadline;
- make an unimplemented descriptor executable merely because it exists in the registry.

Filesystem, Git, process and test mutations keep their existing ToolFabric expected-state, lease/fencing, approval and receipt semantics.

Tool annotations such as read-only or idempotent are hints for MCP clients. Enforcement remains in ToolFabric.

## Verification

`tests/p3b-mcp-runtime.test.ts` exercises:

1. a real external MCP v2 client spawning ToolFabric over stdio;
2. pinned negotiation of protocol revision 2026-07-28;
3. deterministic discovery of only implemented and authorized tools;
4. denial of an unapproved filesystem mutation without changing the file;
5. successful approved `fs.patch` with an exact expected-state hash and two receipts;
6. a real modern Streamable HTTP client call with a returned receipt;
7. denial of non-loopback HTTP exposure.

## Non-claims

P3B does not yet claim authenticated remote HTTP serving, MCP Tasks, MCP Apps, Skills, subscription-backed workflow events, or universal recovery for every future tool class. Durable workflow execution and reconciliation remain ToolFabric core facilities; projecting durable workflows as MCP Tasks is a subsequent focused slice.
