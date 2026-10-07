# P2B Git Isolation

Status: focused implementation slice. This document claims only `P2B_GIT_ISOLATION_SLICE`. It does not claim `P2_LOCAL_ACTION_PASS`, a complete P2 write plane, or production readiness.

## Scope

P2B turns three canonical local Git contracts into real mutating primitives:

- `git.branch@2.0.0`
- `git.worktree@2.0.0`
- `git.commit@2.0.0`

The contracts are version-bumped because the former generic descriptors did not define their mutation inputs or expected-state semantics.

P2B deliberately excludes `git.rebase`, `git.merge`, push/fetch, Forge writes, and any remote/network Git operation.

## Authority and approval

The host grants operation-specific capabilities:

- `git:branch`
- `git:worktree`
- `git:commit`

A capability for one primitive does not authorize the other two.

By default every P2B mutation also requires a call-level `approval_ref` present in the host-owned approved-reference set. Tool/model arguments cannot self-grant either capabilities or approvals.

`git.commit` additionally requires a host-owned author/committer identity supplied to the runtime. Ambient user/global Git identity is not treated as authority.

## Repository boundary

Every `repo_path` is resolved beneath the canonical ToolFabric workspace root and must be the exact top-level root of a non-bare Git worktree. Parent repository discovery or a subdirectory masquerading as the requested repository is rejected. Both the per-worktree Git directory and canonical common Git directory must also resolve inside the authorized workspace; a linked worktree pointing at repository metadata outside the workspace fails closed with `REPOSITORY_METADATA_ESCAPE`.

Linked worktree targets must:

- stay inside the ToolFabric workspace;
- not already exist;
- not already be registered as a linked worktree;
- live outside the source worktree so the isolation directory cannot become an untracked subtree of the source checkout.

## Git execution hardening

P2B invokes the real `git` executable without a shell.

For every Git subprocess the runtime:

- removes inherited `GIT_*` environment overrides before installing its own bounded values;
- disables terminal prompts and pagers;
- disables system/global Git configuration;
- disables hooks through command-level `core.hooksPath`;
- disables fsmonitor and recursive submodule checkout;
- disables automatic CRLF rewriting for the P2B execution path;
- disables replacement-object rewriting and commit signing for the bounded mutation path;
- forces literal pathspec semantics;
- forbids protocol requests originating from user input.

Checkout/add-capable operations also inspect effective local configuration, including local include files. Any configured clean/smudge/process filter driver fails closed with `UNSAFE_GIT_FILTER_CONFIG`. The filter check is repeated after intent and immediately before checkout/add-capable mutation, closing the in-runtime configuration TOCTOU window. This prevents repository-controlled filter commands from becoming an execution side channel during `git.worktree` or `git.commit`.

## Expected-state contracts

### git.branch

Arguments:

```json
{"repo_path":"repo","name":"feature/task-123"}
```

Expected state:

```json
{"head":"<full-object-id>","branch_absent":true}
```

The runtime verifies that the current repository HEAD is the exact expected commit and that the target ref is absent. Creation uses `git update-ref <new> <expected> <zero>`, so the ref transition itself is compare-and-swap bounded.

### git.worktree

Arguments:

```json
{"repo_path":"repo","branch":"feature/task-123","path":"worktree-task-123"}
```

Expected state:

```json
{"branch_head":"<full-object-id>","target_absent":true}
```

The branch must exist at the exact expected revision and must not already be checked out by another worktree. The target path must be absent and isolated from the source worktree.

### git.commit

Arguments:

```json
{
  "repo_path":"worktree-task-123",
  "message":"Implement task 123",
  "paths":["src/a.ts","tests/a.test.ts"]
}
```

Expected state:

```json
{"head":"<full-object-id>"}
```

An optional `expected_state.selection_digest` may additionally bind the exact selected worktree snapshot when the caller already possesses that digest.

P2B refuses `git.commit` on the primary source worktree. Commits are accepted only from a linked worktree, keeping the source checkout outside the commit-mutation surface.

Before the intent receipt the runtime snapshots the declared selection using Git status/diff plus content digests for untracked files. Immediately before mutation it re-checks:

- symbolic branch identity;
- exact expected HEAD;
- exact selected-path snapshot digest.

Any drift fails closed before Git mutation begins.

## Commit construction

`git.commit` does not call porcelain `git commit`.

Instead it uses a temporary isolated index:

1. `read-tree <expected HEAD>`;
2. `git add --all -- <declared paths>` into the temporary index;
3. `write-tree`;
4. reject an unchanged tree with `NOTHING_TO_COMMIT`;
5. `commit-tree` using the host-owned identity;
6. atomically compare-and-swap the current branch with `update-ref <branch> <new> <expected>`;
7. synchronize only the declared paths in the real worktree index to the committed revision with a path-limited `git reset <commit> -- <paths>`;
8. delete the temporary index.

Only declared paths enter the new tree. Other dirty files remain uncommitted, and unrelated staged index state is preserved.

Creating temporary index/tree/blob/commit objects after the intent receipt may leave unreachable Git objects when a later ref transition fails. P2B does not claim immediate object-store garbage collection; the observable branch revision remains the authority boundary.

## Leases and fencing

Every operation takes deterministic per-surface leases through the existing `LeaseBook`. Repository identity is derived from the canonical common Git directory, so the source checkout and all linked worktrees fence the same branch-ref surfaces rather than accidentally receiving independent repository identities.

Examples:

- branch ref surface;
- linked-worktree target surface;
- repository index surface;
- selected filesystem surfaces.

Fencing tokens are recorded in the intent receipt and revalidated immediately before mutation. A stale token fails closed before the Git side effect.

This protects cooperating ToolFabric writers sharing the same lease book. It is not an operating-system lock against arbitrary external Git/process activity.

## Deadline semantics

The call deadline is checked before preparation and before the first mutation. Every individual Git subprocess receives only the remaining bounded deadline budget. Expired calls return `cancelled/DEADLINE_EXCEEDED`.

If a timeout/error happens after a Git mutation may have started, P2B reconciles real repository state before selecting the final result.

## Intent, completion, and reconciliation

After authority, expected-state, and preparation checks pass, P2B emits an intent receipt before the first repository mutation.

The intent binds:

- canonical request digest;
- operation plan digest;
- expected revision/pre-state;
- target ref/worktree/path selection;
- fencing tokens;
- approval reference;
- task/trace/call identity.

A completion receipt chains directly to the intent receipt and includes the final result status.

Ambiguous outcomes are reconciled from real Git state:

- exact intended ref/worktree/commit state observed -> `succeeded`, with `reconciled=true` when the command reported an error;
- exact pre-state still observed -> known failed/denied result;
- neither pre nor intended post-state can be proven -> `uncertain`.

The runtime never blindly retries an ambiguous local Git mutation.

## Evidence and tests

The P2B fixture suite uses real temporary Git repositories and linked worktrees. It covers:

- missing capability;
- missing approval;
- operation-specific capability separation;
- expected-revision branch creation;
- stale revision;
- existing/invalid branch names;
- stale fencing token;
- post-`update-ref` ambiguity reconciliation;
- isolated linked-worktree creation;
- nested target denial;
- direct and included filter-driver denial;
- filter configuration introduced after intent denies checkout and commit before filter execution, preserving branch and index state;
- selected-path-only commit;
- detached-HEAD denial;
- expected-state drift after intent;
- host-owned commit identity;
- ambiguous commit acknowledgement reconciliation;
- externally replaced post-commit branch state -> `uncertain`;
- deadline cancellation;
- end-to-end `branch -> worktree -> commit` receipt-chain verification.

## Non-claims

P2B does not claim:

- `P2_LOCAL_ACTION_PASS`;
- `P2_WRITE_PLANE_PASS`;
- `P1_READ_PLANE_PASS`;
- `git.rebase` or `git.merge` execution;
- push/fetch or any remote Git operation;
- process lifecycle execution;
- test/lint/typecheck/build execution;
- crash-durable receipt persistence;
- exactly-once repository mutation semantics;
- protection from arbitrary non-ToolFabric processes that mutate the repository between OS-level operations;
- automatic garbage collection of unreachable objects created after intent;
- production readiness.

The remaining normative P2 gate still requires controlled process lifecycle and the first isolated change -> test -> receipt fixture before `P2_LOCAL_ACTION_PASS` can be considered.
