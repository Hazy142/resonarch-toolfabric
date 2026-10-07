import test from "node:test";
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {chmod, lstat, mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyChain} from "../src/evidence/receipt.js";
import {LeaseBook} from "../src/orchestrator/leases.js";
import {GitIsolationRuntime} from "../src/runtime/gitIsolation.js";
import type {ToolCall} from "../src/runtime/readPlane.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const {stdout} = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function fixture(): Promise<{workspace: string; repo: string; head: string}> {
  const workspace = await mkdtemp(join(tmpdir(), "toolfabric-p2b-"));
  const repo = join(workspace, "repo");
  await mkdir(repo, {recursive: true});
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture User"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "a.txt"), "alpha\n");
  await writeFile(join(repo, "b.txt"), "bravo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  return {workspace, repo, head};
}

async function linkedFixture(
  branch = "feature/linked",
  worktreeName = "linked-wt",
): Promise<{workspace: string; repo: string; worktree: string; head: string; branch: string}> {
  const base = await fixture();
  await git(base.repo, ["branch", branch, base.head]);
  const worktree = join(base.workspace, worktreeName);
  await git(base.repo, ["worktree", "add", "--quiet", worktree, branch]);
  return {...base, worktree, branch};
}

function call(
  tool: "git.branch" | "git.worktree" | "git.commit",
  args: Record<string, unknown>,
  expectedState: Record<string, unknown>,
  workspace: string,
  approvalRef: string | undefined = "approval:test",
  taskId = "task-p2b",
): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: `call-${tool}-${Math.random().toString(36).slice(2, 8)}`,
    task_id: taskId,
    trace_id: "trace-p2b",
    tool: {id: tool, version: "2.0.0"},
    arguments: args,
    expected_state: expectedState,
    approval_ref: approvalRef,
    scope: {workspace_root: workspace},
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function runtime(options: Record<string, unknown> = {}): Promise<GitIsolationRuntime> {
  return GitIsolationRuntime.create({
    authority: {capabilities: ["git:branch", "git:worktree", "git:commit"], approved_refs: ["approval:test"]},
    identity: {name: "ToolFabric Fixture", email: "toolfabric@example.invalid"},
    ...options,
  } as any);
}

test("P2B denies Git mutation without the required Git capability before intent", async () => {
  const {workspace, head} = await fixture();
  const r = await GitIsolationRuntime.create({
    authority: {capabilities: [], approved_refs: ["approval:test"]},
    identity: {name: "ToolFabric Fixture", email: "toolfabric@example.invalid"},
  });
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/no-capability"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "CAPABILITY_DENIED");
  assert.equal(executed.receipts.length, 1);
});

test("P2B requires a host-approved approval_ref by default", async () => {
  const {workspace, head} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/no-approval"},
    {head, branch_absent: true},
    workspace,
    "",
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "APPROVAL_REQUIRED");
  assert.equal(executed.receipts.length, 1);
});

test("git.branch creates an expected-revision-bound local branch with receipts", async () => {
  const {workspace, repo, head} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/p2b"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal(await git(repo, ["rev-parse", "refs/heads/feature/p2b"]), head);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(executed.receipts.length, 2);
  assert.equal(executed.receipts[0]?.phase, "intent");
  assert.equal(executed.receipts[1]?.phase, "completion");
  assert.equal(executed.receipts[0]?.approval_ref, "approval:test");
  assert.equal(executed.receipts[1]?.approval_ref, "approval:test");
  assert.equal(verifyChain(executed.receipts), true);
});

test("git.branch rejects stale expected revision and existing branch before intent", async () => {
  const {workspace, repo, head} = await fixture();
  const r = await runtime();
  const stale = "0".repeat(head.length);
  const staleResult = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/stale"},
    {head: stale, branch_absent: true},
    workspace,
  ));
  assert.equal(staleResult.result.status, "denied");
  assert.equal(staleResult.result.error?.code, "EXPECTED_STATE_MISMATCH");
  assert.equal(staleResult.receipts.length, 1);

  await git(repo, ["branch", "feature/existing"]);
  const existing = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/existing"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(existing.result.status, "denied");
  assert.equal(existing.result.error?.code, "BRANCH_ALREADY_EXISTS");
});

test("invalid branch names fail closed", async () => {
  const {workspace, head} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "@{-1}"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "INVALID_BRANCH_NAME");
});

test("stale fencing token prevents branch creation after intent", async () => {
  const {workspace, repo, head} = await fixture();
  const leases = new LeaseBook();
  const r = await runtime({
    lease_book: leases,
    before_mutation: ({surfaces}: any) => {
      leases.claim(surfaces[0], "competing-worker");
    },
  });
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/fenced"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "STALE_FENCING_TOKEN");
  assert.equal(executed.receipts.length, 2);
  await assert.rejects(git(repo, ["rev-parse", "--verify", "refs/heads/feature/fenced"]));
});

test("post-update-ref ambiguity reconciles git.branch to success", async () => {
  const {workspace, repo, head} = await fixture();
  const r = await runtime({
    after_mutation: () => {
      throw new Error("simulated acknowledgement loss");
    },
  });
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/reconcile"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal((executed.result.output as any).reconciled, true);
  assert.equal(await git(repo, ["rev-parse", "refs/heads/feature/reconcile"]), head);
});

test("git.worktree creates an isolated linked worktree for the expected branch head", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/worktree", head]);
  const r = await runtime();
  const executed = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/worktree", path: "feature-worktree"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  const target = join(workspace, "feature-worktree");
  assert.equal(await git(target, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(target, ["symbolic-ref", "-q", "HEAD"]), "refs/heads/feature/worktree");
  assert.equal(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
});

test("git.worktree denies nested targets and configured clean/smudge filters", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/unsafe", head]);
  const r = await runtime();

  const nested = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/unsafe", path: "repo/nested-worktree"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(nested.result.status, "denied");
  assert.equal(nested.result.error?.code, "WORKTREE_TARGET_INSIDE_REPOSITORY");

  await git(repo, ["config", "filter.evil.smudge", "node -e process.exit(99)"]);
  const unsafe = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/unsafe", path: "unsafe-worktree"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(unsafe.result.status, "denied");
  assert.equal(unsafe.result.error?.code, "UNSAFE_GIT_FILTER_CONFIG");
});

test("git.worktree reconciles success after an ambiguous post-create error", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/ambiguous-wt", head]);
  const r = await runtime({
    after_mutation: () => {
      throw new Error("simulated response loss");
    },
  });
  const executed = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/ambiguous-wt", path: "ambiguous-wt"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal((executed.result.output as any).reconciled, true);
  assert.equal(await git(join(workspace, "ambiguous-wt"), ["rev-parse", "HEAD"]), head);
});

test("git.commit commits only declared paths on an isolated worktree", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/commit", head]);
  await git(repo, ["worktree", "add", "--quiet", join(workspace, "commit-wt"), "feature/commit"]);
  const worktree = join(workspace, "commit-wt");
  await writeFile(join(worktree, "a.txt"), "alpha changed\n");
  await writeFile(join(worktree, "b.txt"), "bravo changed but unselected\n");
  await git(worktree, ["add", "b.txt"]);
  const stagedBefore = await git(worktree, ["diff", "--cached", "--binary", "--", "b.txt"]);

  const r = await runtime();
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "commit-wt", message: "change a only", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  const commit = (executed.result.output as any).commit as string;
  assert.ok(commit && commit !== head);
  assert.equal(await git(worktree, ["rev-parse", "HEAD"]), commit);
  assert.equal(await git(repo, ["rev-parse", "main"]), head);
  assert.equal(await git(worktree, ["show", `${commit}:a.txt`]), "alpha changed");
  assert.equal(await git(worktree, ["show", `${commit}:b.txt`]), "bravo");
  const status = await git(worktree, ["status", "--porcelain=v1"]);
  assert.match(status, /^M  b\.txt$/m);
  assert.equal(await git(worktree, ["diff", "--cached", "--binary", "--", "b.txt"]), stagedBefore);
  assert.equal(verifyChain(executed.receipts), true);
});

test("git.commit is restricted to isolated linked worktrees", async () => {
  const {workspace, repo, head} = await fixture();
  await writeFile(join(repo, "a.txt"), "changed\n");
  const r = await runtime();
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "repo", message: "primary forbidden", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "PRIMARY_WORKTREE_COMMIT_FORBIDDEN");
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), head);
});

test("git.commit rejects expected-head mismatch and detached linked HEAD", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/state-check", "state-check-wt");
  const r = await runtime();
  await writeFile(join(worktree, "a.txt"), "changed\n");
  const mismatch = await r.execute(call(
    "git.commit",
    {repo_path: "state-check-wt", message: "nope", paths: ["a.txt"]},
    {head: "0".repeat(head.length)},
    workspace,
  ));
  assert.equal(mismatch.result.status, "denied");
  assert.equal(mismatch.result.error?.code, "EXPECTED_STATE_MISMATCH");

  await git(worktree, ["checkout", "--detach", head]);
  const detached = await r.execute(call(
    "git.commit",
    {repo_path: "state-check-wt", message: "no detached", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(detached.result.status, "denied");
  assert.equal(detached.result.error?.code, "DETACHED_HEAD_FORBIDDEN");
});

test("git.commit detects selected-path drift after intent and does not move HEAD", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/drift", "drift-wt");
  await writeFile(join(worktree, "a.txt"), "planned\n");
  const r = await runtime({
    before_mutation: async () => {
      await writeFile(join(worktree, "a.txt"), "raced\n");
    },
  });
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "drift-wt", message: "planned change", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "EXPECTED_STATE_DRIFT");
  assert.equal(await git(worktree, ["rev-parse", "HEAD"]), head);
  assert.equal(executed.receipts.length, 2);
});

test("git.commit requires host-owned commit identity", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/identity", "identity-wt");
  await writeFile(join(worktree, "a.txt"), "changed\n");
  const r = await GitIsolationRuntime.create({
    authority: {capabilities: ["git:branch", "git:worktree", "git:commit"], approved_refs: ["approval:test"]},
  });
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "identity-wt", message: "identity required", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "GIT_IDENTITY_REQUIRED");
});

test("git.commit reconciles a lost acknowledgement after ref update", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/reconcile-commit", "reconcile-commit-wt");
  await writeFile(join(worktree, "a.txt"), "changed\n");
  const r = await runtime({
    after_mutation: () => {
      throw new Error("simulated commit acknowledgement loss");
    },
  });
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "reconcile-commit-wt", message: "reconcile commit", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal((executed.result.output as any).reconciled, true);
  assert.notEqual(await git(worktree, ["rev-parse", "HEAD"]), head);
});

test("git.commit reports uncertain when post-commit branch state is externally replaced", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/uncertain", "uncertain-wt");
  await writeFile(join(worktree, "a.txt"), "changed\n");
  const r = await runtime({
    after_mutation: async () => {
      await git(worktree, ["commit", "--allow-empty", "-m", "external race"]);
      throw new Error("simulated competing branch mutation");
    },
  });
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "uncertain-wt", message: "toolfabric commit", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "uncertain");
  assert.equal(executed.result.error?.code, "GIT_MUTATION_OUTCOME_UNCERTAIN");
  assert.equal(verifyChain(executed.receipts), true);
});

test("expired deadlines cancel before Git side effects", async () => {
  const {workspace, repo, head} = await fixture();
  const r = await runtime();
  const request = call(
    "git.branch",
    {repo_path: "repo", name: "feature/expired"},
    {head, branch_absent: true},
    workspace,
  );
  request.deadline = new Date(Date.now() - 1000).toISOString();
  const executed = await r.execute(request);
  assert.equal(executed.result.status, "cancelled");
  assert.equal(executed.result.error?.code, "DEADLINE_EXCEEDED");
  await assert.rejects(git(repo, ["rev-parse", "--verify", "refs/heads/feature/expired"]));
});

test("P2B branch -> worktree -> commit forms one verifiable receipt chain", async () => {
  const {workspace, repo, head} = await fixture();
  const surfaces = new Map<string, string[]>();
  const r = await runtime({
    before_mutation: ({tool_id, surfaces: current}: any) => {
      surfaces.set(tool_id, [...current]);
    },
  });
  const task = "task-p2b-e2e";

  const branch = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/e2e"},
    {head, branch_absent: true},
    workspace,
    "approval:test",
    task,
  ));
  assert.equal(branch.result.status, "succeeded");

  const worktree = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/e2e", path: "e2e-wt"},
    {branch_head: head, target_absent: true},
    workspace,
    "approval:test",
    task,
  ));
  assert.equal(worktree.result.status, "succeeded");

  const target = join(workspace, "e2e-wt");
  await writeFile(join(target, "a.txt"), "e2e changed\n");
  const commit = await r.execute(call(
    "git.commit",
    {repo_path: "e2e-wt", message: "e2e change", paths: ["a.txt"]},
    {head},
    workspace,
    "approval:test",
    task,
  ));
  assert.equal(commit.result.status, "succeeded");

  const receipts = [...branch.receipts, ...worktree.receipts, ...commit.receipts];
  assert.equal(verifyChain(receipts), true);
  assert.notEqual(await git(target, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(repo, ["rev-parse", "main"]), head);
  const branchRefSurface = surfaces.get("git.branch")?.[0];
  assert.ok(branchRefSurface);
  assert.equal(surfaces.get("git.worktree")?.[0], branchRefSurface);
  assert.equal(surfaces.get("git.commit")?.[0], branchRefSurface);
});


test("P2B capabilities remain operation-specific", async () => {
  const {workspace, repo, head} = await fixture();
  const branchOnly = await GitIsolationRuntime.create({
    authority: {capabilities: ["git:branch"], approved_refs: ["approval:test"]},
    identity: {name: "ToolFabric Fixture", email: "toolfabric@example.invalid"},
  });

  const branch = await branchOnly.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/capability-scope"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(branch.result.status, "succeeded");

  const worktree = await branchOnly.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/capability-scope", path: "capability-wt"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(worktree.result.status, "denied");
  assert.equal(worktree.result.error?.code, "CAPABILITY_DENIED");
  await assert.rejects(readFile(join(workspace, "capability-wt", "a.txt")));
  assert.equal(await git(repo, ["rev-parse", "refs/heads/feature/capability-scope"]), head);
});

test("P2B rejects filter drivers reached through local include config", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/include-filter", head]);
  await writeFile(
    join(repo, "filters.inc"),
    '[filter "evil"]\n\tsmudge = node -e "process.exit(99)"\n',
  );
  await git(repo, ["config", "--local", "include.path", "../filters.inc"]);

  const r = await runtime();
  const executed = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/include-filter", path: "include-filter-wt"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "UNSAFE_GIT_FILTER_CONFIG");
});


test("P2B disables repository hooks for mutating Git commands", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX hook executability is validated on Linux CI");
    return;
  }
  const {workspace, repo, head} = await fixture();
  const marker = join(workspace, "hook-fired");
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  await writeFile(hook, `#!/bin/sh\nprintf fired > "${marker}"\n`);
  await chmod(hook, 0o755);

  const r = await runtime();
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "repo", name: "feature/no-hooks"},
    {head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  await assert.rejects(readFile(marker));
});


test("git.commit rejects a caller-bound selection digest mismatch before intent", async () => {
  const {workspace, worktree, head} = await linkedFixture("feature/selection-digest", "selection-digest-wt");
  await writeFile(join(worktree, "a.txt"), "changed\n");
  const r = await runtime();
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "selection-digest-wt", message: "bound selection", paths: ["a.txt"]},
    {head, selection_digest: "sha256:" + "0".repeat(64)},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "EXPECTED_STATE_MISMATCH");
  assert.equal(executed.receipts.length, 1);
  assert.equal(await git(worktree, ["rev-parse", "HEAD"]), head);
});


test("P2B denies repositories whose Git metadata escapes the authorized workspace", async () => {
  const external = await fixture();
  const workspace = await mkdtemp(join(tmpdir(), "toolfabric-p2b-authorized-"));
  await git(external.repo, ["branch", "feature/external-metadata", external.head]);
  const linked = join(workspace, "linked");
  await git(external.repo, ["worktree", "add", "--quiet", linked, "feature/external-metadata"]);

  const r = await runtime();
  const executed = await r.execute(call(
    "git.branch",
    {repo_path: "linked", name: "feature/should-not-mutate-external"},
    {head: external.head, branch_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "REPOSITORY_METADATA_ESCAPE");
  await assert.rejects(git(external.repo, ["rev-parse", "--verify", "refs/heads/feature/should-not-mutate-external"]));
});
test("P2B rechecks filter safety after intent before checkout side effects", async () => {
  const {workspace, repo, head} = await fixture();
  await git(repo, ["branch", "feature/filter-race", head]);
  const r = await runtime({
    before_mutation: async () => {
      await git(repo, ["config", "filter.race.smudge", "node -e process.exit(99)"]);
    },
  });
  const executed = await r.execute(call(
    "git.worktree",
    {repo_path: "repo", branch: "feature/filter-race", path: "filter-race-wt"},
    {branch_head: head, target_absent: true},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "UNSAFE_GIT_FILTER_CONFIG");
  assert.equal(executed.receipts.length, 2);
  assert.equal(executed.receipts[0]?.phase, "intent");
  assert.equal(executed.receipts[1]?.status, "denied");
  assert.equal(verifyChain(executed.receipts), true);
  assert.equal(await git(repo, ["rev-parse", "refs/heads/feature/filter-race"]), head);
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).includes("filter-race-wt"), false);
  await assert.rejects(lstat(join(workspace, "filter-race-wt")), {code: "ENOENT"});
});

test("P2B rechecks filter safety after intent before commit side effects", async () => {
  const {workspace, worktree, head} = await linkedFixture();
  await writeFile(join(worktree, "a.txt"), "changed alpha\n");
  await writeFile(join(worktree, "b.txt"), "staged bravo\n");
  await git(worktree, ["add", "--", "b.txt"]);
  const indexTree = await git(worktree, ["write-tree"]);
  await writeFile(join(worktree, ".gitattributes"), "a.txt filter=race\n");
  await writeFile(join(worktree, "filter.cjs"),
    'require("node:fs").writeFileSync("filter-ran.txt", "executed\\n"); process.stdin.pipe(process.stdout);\n');
  const r = await runtime({
    before_mutation: async () => {
      await git(worktree, ["config", "filter.race.clean", "node filter.cjs"]);
    },
  });
  const executed = await r.execute(call(
    "git.commit",
    {repo_path: "linked-wt", message: "must deny filter race", paths: ["a.txt"]},
    {head},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "UNSAFE_GIT_FILTER_CONFIG");
  assert.equal(executed.receipts.length, 2);
  assert.equal(executed.receipts[0]?.phase, "intent");
  assert.equal(executed.receipts[1]?.status, "denied");
  assert.equal(verifyChain(executed.receipts), true);
  assert.equal(await git(worktree, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(worktree, ["write-tree"]), indexTree);
  assert.equal(await readFile(join(worktree, "a.txt"), "utf8"), "changed alpha\n");
  await assert.rejects(lstat(join(worktree, "filter-ran.txt")), {code: "ENOENT"});
});
