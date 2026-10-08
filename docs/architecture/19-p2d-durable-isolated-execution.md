# P2D — Durable, isolated container jobs

The user explicitly selected hardened Linux container jobs controlled from Windows/WSL and Linux, and exactly one durable result publication per operation with safe retries of isolated computation. This profile is distinct from P2C host-user execution. It does not claim exactly-one physical execution of arbitrary uncooperative programs, native Windows application confinement, or an installed MCP server.

## Decision contract

The host registers immutable sealed capsules and grants `test:run`, `process:host_execution`, `process:isolated_execution` and approved references. A caller cannot grant rights or register/change an image by supplying a capsule object. A configured Docker launcher, endpoint and flags are host-owned; there is no fallback to the unconfined host-user executor.

The trusted boundary is the controller, its stable host-owned signing key and state directory, the Docker daemon/runtime, kernel and storage honoring SQLite synchronization. Unrelated host processes are preserved. Processes created by the application, even with a new session/process group, remain inside the owned private PID/mount/network/IPC domain. Access to external host launch brokers is prevented by the unavailable Docker socket, absent host mounts and network denial.

## Complete readable userland binding

`sealCapsule` copies the host-approved input directory to a fresh context outside live inputs, records every file's bytes and normalized mode, and bakes that snapshot and the trusted broker into an image. Input symlinks must be materialized by the host before sealing; aliases that resolve into live source fail closed. The fixed recipe binds executable, argv, cwd, environment and resource limits. Image ID and rootfs-layer identities bind all pre-existing userland libraries and packages available to the job. Runtime package downloads are unavailable.

The base is explicitly provisioned and immutable: `node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, platform Linux/amd64. Image/recipe/input/backend digests are checked before activation and retained. A live source change after sealing does not silently change the executed snapshot. This binds the execution domain; it does not promise deterministic clock/random output or defend against a compromised trusted kernel/daemon.

## Isolation and lifetime

Jobs have private PID/network/IPC namespaces, read-only rootfs, no writable host mounts or daemon socket, `no-new-privileges`, PID limit 64, memory 256 MiB and one CPU. Writable application output and temporary files use bounded tmpfs. The trusted PID-1 broker executes application code at UID/GID 10001, with effective application capabilities zero. Its narrowly retained capabilities are used to drop child identity, inspect private results and terminate owned namespace processes.

The broker never imports application code at UID0. A root-owned 0700 control directory in an owned private persistent volume holds the start marker and terminal record. The application cannot read/write these records or elevate back to root. The broker kills all live owned namespace descendants and drains both output pipes before sealing outputs. Unconfirmed namespace or pipe quiescence cannot become success.

The broker enforces its own lifetime even when the controller dies. A repeated start of a finished attempt returns its existing terminal record without executing the application again; an interrupted attempt with a durable start marker stays uncertain. A new speculative attempt has a new private namespace/volume and is admitted only after the former inspected namespace is non-running. Application effects remain provisional and cannot touch the live workspace/network.

## Durable journal and exactly-once publication

`OperationJournal` uses SQLite WAL and synchronous FULL. Schema/root, operations and a chained event log are authenticated with a stable host-owned HMAC key. Unique operation keys bind a semantic input digest. Changed semantics under the same key are denied; active ownership, renewed leases and fencing prevent concurrent/stale controllers from publishing. Consistent database read transactions prevent false integrity failures during legitimate concurrent commits. Tampering, including replacing a live record with an authentic older version, fails closed.

The intent is committed before backend creation/start. Names and labels include the journal identity, operation and attempt, so different state stores do not collide. Existing backend objects are adopted only after image, authority-label, resource, mount, capability and namespace policy verification. Missing or unavailable trusted state is not converted into a successful retry.

Stdout, stderr and bounded output files become authenticated content-addressed SQLite blobs. Provisional blobs are not readable through the job API. Final outcome, artifact references and canonical intent/completion receipts are committed as one immutable published result. Thus a committed result does not depend on a separate file rename surviving a crash. Repeated authorized calls return the same result digest and publication count one, even after owned backend cleanup.

The exactly-once claim is **one durable logical result publication**, including negative terminal outcomes. An isolated computation may execute again after a genuinely interrupted private attempt. Arbitrary external host/network effects and interactive stdin protocols are not part of this sealed batch-job profile. Previously approved P2C host-user APIs remain separate and do not inherit these assurances.

## Recovery and observable gates

Actual controller SIGKILL tests cover durable intent, created backend, started backend, collected result before publication, and committed publication before response. Reopening authenticates state, waits for an old ownership lease if necessary, adopts existing owned work, or returns the already published result. A private killed attempt can be recomputed, with one final publication.

The live suite also checks UID10001/CapEff0, blocked elevation, input mutation, private state, Docker socket and network; detached-descendant cleanup; complete stdout/stderr capture; unchanged unrelated namespace; concurrent controllers and retained exit-code-7 failure; replay after cleanup. Journal snapshots, raw outcomes, receipt/blob verification and image/backend/kernel identities are retained in `evidence/local/p2d-proof.json` and `p2d-journals/`.

Run `npm run check` for the ordinary suite and `npm run check:hardened` for mandatory real Docker gates. The latter uses a private empty Docker client configuration and the pinned base. Linux CI executes and uploads these gates. Hosted Windows CI runs portable journal/snapshot/compatibility tests; Windows-controller/WSL-Linux execution is separately observed locally and accurately labeled as Linux execution, not native Windows application execution.

## Scope and reconsideration

Supported within this profile: contained application process lifetime, controller-crash recovery, authenticated durable state and output, exactly-once publication, and sealed pre-existing userland dependencies. Power/storage guarantees rely on the documented SQLite/storage synchronization assumptions; the tests force process/controller failure, not physical disk power removal.

Kernel/daemon identity change, unknown backend ownership, image/input mutation, stale fencing, unsigned/changed state, unconfirmed cleanup, or exhausted private attempt budget require denial or uncertainty. No automatic fallback may weaken isolation. General user-tool workflow dispatch, native Windows confinement, arbitrary external exactly-once side effects and MCP serving require their own contracts and gates. MCP work remains deferred until this hardened slice is verified.
