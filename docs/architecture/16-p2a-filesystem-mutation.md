# P2A Filesystem Mutation Kernel

Status: focused implementation slice. This document claims only `P2A_FILESYSTEM_MUTATION_SLICE`, not a complete P2 write plane or production readiness.

## Scope

P2A turns three canonical filesystem contracts into real mutating primitives:

- `fs.write@2.0.0`
- `fs.patch@2.0.0`
- `fs.move@2.0.0`

The contracts are version-bumped because their input semantics are now explicit and materially narrower than the former generic descriptor stubs.

## Authority boundary

The write runtime is disabled unless the host supplies `fs:write` capability. By default every mutation also requires a call-level `approval_ref` that is present in the host-owned approved-reference set. Tool arguments cannot grant either capability or approval.

Calls outside the three P2A primitives are denied by this runtime slice.

## Expected-state binding

Every filesystem mutation requires an explicit expected pre-state before an intent receipt can be emitted.

For `fs.write` and `fs.patch`:

```json
{"exists": true, "sha256": "sha256:<64 hex>"}
```

or, for creation:

```json
{"exists": false}
```

For `fs.move`:

```json
{
  "source": {"exists": true, "sha256": "sha256:<64 hex>"},
  "destination": {"exists": false}
}
```

A mismatch fails closed with `EXPECTED_STATE_MISMATCH`. After the intent receipt and immediately before commit, the runtime probes the bound surfaces again. Drift becomes `EXPECTED_STATE_DRIFT` and no write is attempted.

## Workspace and path safety

Mutation paths remain rooted in the canonical workspace boundary. Absolute paths, lexical traversal, resolved ancestor escapes, and direct symbolic-link mutation targets fail closed.

P2A does not create missing parent directories. The immediate target parent must already exist.

## Fencing

Each write surface is leased through the existing `LeaseBook`. `fs.move` acquires both source and destination surfaces in stable order. The runtime re-validates every fencing token immediately before mutation.

A stale fencing token stops the operation before commit. The call deadline is also validated before preparation and re-checked immediately before mutation; an elapsed deadline cancels the call without starting a filesystem side effect.

This coordinates ToolFabric writers that share the same lease book. It is not an operating-system transaction lock against arbitrary external processes.

## Atomic mutation path

`fs.write` and `fs.patch` write a same-directory temporary file, preserve the existing target mode when replacing a file, sync the temporary file, close it, then rename it into the target path. Temporary files are cleaned on failure.

`fs.patch` is deliberately exact rather than fuzzy: it accepts `old_text`, `new_text`, and an optional bounded `expected_replacements`. A replacement-count mismatch is denied before intent.

`fs.move` performs a workspace-bounded rename and currently rejects destination-exists plans through expected-state validation. Cross-device fallback copying is not implemented.

## Intent, completion, and reconciliation

A mutation that passes authority and pre-state validation emits an intent receipt before its first filesystem side effect. The intent binds:

- canonical call digest;
- operation plan digest;
- exact pre-state and intended post-state;
- fencing tokens;
- task/trace/call identity.

The completion receipt chains directly to the intent receipt.

If the mutation API reports an error after commit may have begun, the runtime re-probes the real filesystem:

- intended post-state observed -> `succeeded` with `reconciled=true`;
- exact pre-state still observed -> known `failed` / `denied`;
- neither state can be proven -> `uncertain`.

The runtime never guesses success or failure for an ambiguous side effect.

## Evidence

The P2A test suite covers:

- missing capability;
- missing approval;
- successful atomic create;
- stale expected-state rejection;
- exact patch preimage and replacement count;
- atomic move;
- stale fencing token rejection;
- simulated error after a successful rename and post-state reconciliation;
- simulated ambiguous/tampered post-state yielding `uncertain`;
- workspace traversal denial;
- receipt-chain verification.

## Non-claims

P2A does not yet claim:

- `P2_LOCAL_ACTION_PASS`;
- a complete `P2_WRITE_PLANE_PASS`;
- a durable crash-recovery ledger;
- exactly-once mutation semantics;
- cross-process OS-level compare-and-swap against hostile external writers;
- cross-device move fallback;
- process execution;
- Git mutation;
- `code.edit` execution;
- production readiness.

The next intended slices are Git mutation and controlled process execution after this filesystem kernel is independently reviewed.
