# P2C — Controlled process lifecycle and local-action fixture

Status: implemented focused slice. Claims: `P2C_PROCESS_LIFECYCLE_SLICE` and `P2_ISOLATED_CHANGE_TEST_RECEIPT_FIXTURE`. Full `P2_LOCAL_ACTION_PASS`, installed MCP serving, remote execution, and production readiness remain open.

## Explicit host-user execution authority

This slice executes host-approved programs with the operating-system privileges of the host user. The user explicitly selected this mode for the first local slice. Workspace validation binds the command's working directory and declared input identity; it does not prevent an authorized program from accessing other files or the network.

The former generic v1 process/test descriptors said `network: forbidden`. General subprocess execution cannot enforce that promise without an OS sandbox. This change therefore versions the six implemented contracts to v2. `process.start`, `process.input`, and `test.run` have R2 risk, optional network, host-user authority scope, and an additional `process:host_execution` capability. Old `process:write` grants and v1 calls do not implicitly authorize the new execution path. Unimplemented test/build/lint contracts are unchanged.

Tools cannot register command plans, grant execution privileges, or approve themselves. The host uses `bindProcessPlan()` and constructs `ProcessLifecycleRuntime` with a fixed workspace, capability set, approved references, and plans. Every mutation requires a host-approved call-level `approval_ref`.

## Implemented contracts

| Tool/version | Arguments | Expected state | Required capabilities |
|---|---|---|---|
| `process.start@2.0.0` | `plan_id` | `plan_digest` | `process:start`, `process:host_execution` |
| `process.input@2.0.0` | `session_id`, UTF-8 `data`, optional `eof` | integer session `revision` | `process:input`, `process:host_execution` |
| `process.output@2.0.0` | `session_id`, optional byte cursors and `max_bytes` | none | `process:read` |
| `process.stop@2.0.0` | `session_id` | integer session `revision` | `process:stop` |
| `process.list@2.0.0` | empty object | none | `process:read` |
| `test.run@2.0.0` | `plan_id` of a host-designated test | `plan_digest` | `test:run`, `process:host_execution` |

Unknown fields, including caller-supplied executable, shell, argv or environment, are rejected. The process runtime is separate from the P1 read runtime; the P1 boundary's unsupported process reads remain unsupported in that runtime.

## Host-owned immutable plans

A plan fixes the executable's canonical absolute path and SHA-256, literal argv, canonical workspace/cwd, explicit environment, declared input paths and hashes, purpose, stdin permission, lifetime and output budgets. An optional repository binding also fixes HEAD and verifies that the Git metadata is inside the workspace.

The canonical digest binds all these values. The executable, cwd, declared input bytes and optional HEAD are checked before intent and rechecked after the host hook and fencing validation, immediately before launch. This coordinates cooperating writers; it does not prevent arbitrary external OS-level replacement after the final check. Input files not declared by the host, dynamic dependencies and interpreter libraries are not hermetically captured.

No ambient environment is inherited beyond the required Windows `SystemRoot`; additional environment values must be in the host plan. Host-supplied argv and environment are hashed but are not copied into tool output or receipts in plaintext. Program output is retained as untrusted data; it cannot become capability or approval authority.

## Lifetime control and session scope

Programs are spawned without a shell. Windows requires real `.exe` programs; a script needs an explicitly approved interpreter plan. The Windows build compiles a small .NET Framework supervisor using the installed compiler. It creates the program suspended, assigns it to a non-breakaway Job Object with kill-on-close, emits a bound readiness frame, then resumes it. Killing or exiting the supervisor closes the job and terminates ordinary descendants. If the job cannot be created or assigned, the program is not resumed and launch fails.

POSIX uses a dedicated process group and sends SIGKILL to that group on stop, deadline, and normal parent exit. Deliberately escaped POSIX groups and separately created external processes are outside this lifetime control. Neither jobs nor process groups provide filesystem/network confinement. An unconfirmed cleanup returns `uncertain`; inherited pipes cannot make a test wait indefinitely.

Session IDs are opaque and runtime-local. Every session is bound to its task and canonical workspace. Listing filters to the current task; output/input/stop reject foreign session access. Tools never accept an arbitrary PID. Input and stop bind the current revision and revalidate their fence after intent.

Start success means an accepted managed session, not a completed successful program. Output exposes observed state, PID identities, exit code, signal and revision. Input success acknowledges delivery to stdin, not completion of a command written to stdin. An EOF callback coinciding with stop/deadline or a failed stream is not accepted as a positive acknowledgement; it remains `uncertain`. A lost input acknowledgement is `uncertain`, with no automatic replay. Call identities cannot be reused.

The host can close the runtime to stop its owned sessions. Stop is forceful. Limits are 1–16 active sessions (default 4), up to 256 retained sessions (default 32), 64 plans, 4096 calls and 256 task tails per runtime instance. Expired retained sessions may be evicted. Host plans allow 100–120000 ms runtime and 1–1048576 retained output bytes. The call deadline can shorten the plan lifetime. Cleanup has a separate bounded five-second containment allowance.

## Output and execution evidence

Stdout and stderr share one retained byte budget. Excess output is drained and counted, so a noisy program does not allocate an unbounded log or block on a full pipe. Pages expose exact bytes as base64 and separate byte cursors, preserving split UTF-8 sequences. Canonical output calls return at most 32 KiB raw bytes per page. Truncation is explicit; retained prefixes are not claimed as complete output.

`test.run` waits for a real process outcome. Exit 0 succeeds; nonzero exit fails with `TEST_FAILED`; deadline termination is cancelled; unconfirmed outcomes remain uncertain. Both successful and failed tests retain stdout, stderr and an execution manifest as three content-addressed artifacts. The manifest binds the plan, declared inputs, executable digest, observed session and output truncation counts.

Intent/completion receipts use the existing canonical schema and task-local hash chains. They are in-memory execution receipts, not a crash-durable intent journal. A runtime/host crash may interrupt execution and evidence persistence. This slice does not claim crash recovery or exactly-once effects.

## Real local-action fixture

`tests/p2c-local-action.test.ts` uses real Git repositories, linked worktrees, filesystem mutation and Node's real test runner. It executes:

1. Expected-HEAD branch creation.
2. Isolated linked-worktree creation.
3. A real failing test against the original source; retain the negative result.
4. An exact SHA-256-bound source patch.
5. A fresh host plan bound to changed source bytes; run the same test and observe PASS.
6. Selected-path commit on the isolated worktree.

All six calls form one verified chain of 12 intent/completion receipts. The fixture verifies unchanged source-worktree HEAD/status/bytes and preservation of unrelated staged changes in the linked worktree. It retains `evidence/local/p2c-local-action.json` and the content-addressed test artifacts, including source/runtime identities and the negative/positive raw TAP output.

This is a controlled execution fixture. It does not make the compiled `implement`/`test` user-tool DAGs into general workflow executors or establish an installed MCP/Remote Desktop Commander replacement. The broader P2 promotion remains open, including canonical verification-tool coverage and production acceptance outside this fixture.
