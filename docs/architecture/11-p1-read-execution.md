# P1A Read Execution Core

Status: implemented on the P1A branch; this document does **not** claim `P1_READ_PLANE_PASS`.

## Scope

P1A turns a focused subset of the frozen ToolFabric contracts into real local execution:

- `registry.list`, `registry.describe`
- `instructions.discover`
- `fs.read`, `fs.read_many`, `fs.list`, `fs.stat`, `fs.search`
- `git.status`, `git.log`, `git.diff`
- `env.snapshot`, `command.which`

The runtime consumes canonical v1 calls and returns canonical v1 result envelopes plus a
content-bound receipt. Calls are deadline checked before execution.

## Workspace boundary

Filesystem and repository reads are rooted in the call's `scope.workspace_root`.
Absolute paths, lexical `..` escapes, and resolved symlink escapes are denied.
Recursive search never follows symlinks and skips `.git`.

## Git execution

Git reads execute the real `git` binary with `execFile`, never through a shell.
The runtime disables optional locks and fsmonitor and disables external diff/textconv
execution for `git.diff`. Host variables that can redirect Git state (`GIT_DIR`,
`GIT_WORK_TREE`, index/object/config injection variables) are stripped, and
`GIT_CEILING_DIRECTORIES` prevents discovery of a parent repository outside the workspace.
Revision arguments beginning with `-` are rejected so a revision cannot become an option injection.

## P1 write barrier

Before dispatch, the runtime checks the frozen descriptor. Any primitive whose
`side_effect` is not `none` is denied with `P1_WRITE_FORBIDDEN`. This includes
`fs.patch`, `fs.write`, `process.start`, `git.worktree`, commits, rebases and merges.

This is deliberate: mutating semantics belong to P2 and require expected-state,
policy/capability/approval and intent/completion handling.

## Large output

Canonical output larger than the configured inline limit is written to the content-addressed
Artifact Store outside the workspace. The runtime validates the prospective Artifact-Store path
before execution and denies roots that are lexically inside the workspace or resolve there through
an existing symlink ancestor. The result contains only the artifact reference and byte count.
Artifact refs are strict `artifact://sha256:<64 hex>` identifiers; writes use a synced temporary
file followed by rename.

## Evidence boundary

Integration tests use a real temporary filesystem and a real Git repository. They verify:

- successful local filesystem reads;
- traversal and symlink-escape denial;
- mutating primitive denial;
- large-output artifactization;
- real `git status/log/diff`;
- byte/mtime tree equality before and after the read-only Git sequence;
- scoped instruction discovery;
- exact literal filesystem search;
- environment redaction, including secret/private/access-key names;
- Artifact-Store scope denial before any workspace-local artifact directory can be created;
- command discovery;
- expired-call cancellation;
- malformed input and Git option-injection rejection.

## Not yet P1 complete

P1A does not yet implement the full Notion P1 gate. Remaining work includes at least:

- research/docs read adapters;
- exact indexed retrieval / FTS layer;
- remaining declared read primitives and primitive-by-primitive conformance vectors;
- first read-only user-tool E2E gates (`inspect`, `research`, read-only `audit`);
- Windows + Linux CI on the exact P1 candidate.

No production-readiness or full P1 PASS claim follows from this slice.
