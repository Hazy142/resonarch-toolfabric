import test from "node:test";
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {canonicalDigest, sha256} from "../src/contracts/canonical.js";
import {ArtifactStore} from "../src/evidence/artifacts.js";
import {verifyChain, type Receipt} from "../src/evidence/receipt.js";
import {GitIsolationRuntime} from "../src/runtime/gitIsolation.js";
import {WritePlaneRuntime} from "../src/runtime/writePlane.js";
import {bindProcessPlan} from "../src/runtime/processPlan.js";
import {ProcessLifecycleRuntime} from "../src/runtime/processLifecycle.js";
import type {ToolCall} from "../src/runtime/readPlane.js";

const execFile = promisify(execFileCallback);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile("git", args, {cwd, windowsHide: true})).stdout.trim();
}

test("P2C real isolated change -> failing test -> patch -> passing test -> commit binds one receipt chain", async t => {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-local-action-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  const artifacts = join(root, "artifacts");
  await mkdir(repo, {recursive: true});
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Local Action Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "calc.cjs"), "exports.add = (a, b) => a - b;\n");
  await writeFile(join(repo, "calc.test.cjs"), 'const test = require("node:test"); const assert = require("node:assert/strict"); const {add} = require("./calc.cjs"); test("sum matches expected value", () => assert.equal(add(2, 3), 5));\n');
  await writeFile(join(repo, "notes.txt"), "original notes\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial fixture"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(join(repo, "source-only.txt"), "unrelated source state\n");
  const sourceStatus = await git(repo, ["status", "--porcelain=v1"]);
  const receipts: Receipt[] = [];
  const calls: Array<{tool: string; status: string; request_digest: string; result_digest: string}> = [];
  const previous = () => receipts.at(-1)?.receipt_hash ?? "sha256:GENESIS";
  const approval = "approval:local-action";
  const authority = {capabilities: ["git:branch", "git:worktree", "git:commit", "fs:write", "test:run", "process:host_execution"], approved_refs: [approval]};
  function call(tool: string, args: Record<string, unknown>, expected_state: Record<string, unknown>): ToolCall {
    return {schema: "resonarch.toolfabric.call/v1", call_id: crypto.randomUUID(), task_id: "local-action-fixture", trace_id: "local-action-trace",
      tool: {id: tool, version: "2.0.0"}, arguments: args, expected_state, approval_ref: approval,
      scope: {workspace_root: workspace}, deadline: new Date(Date.now() + 30_000).toISOString()};
  }
  function retain(request: ToolCall, executed: {result: any; receipts: Receipt[]}) {
    assert.equal(executed.receipts[0]!.previous_receipt_hash, previous());
    receipts.push(...executed.receipts);
    calls.push({tool: request.tool.id, status: executed.result.status, request_digest: canonicalDigest(request), result_digest: canonicalDigest(executed.result)});
    assert.equal(verifyChain(receipts), true);
    return executed.result;
  }
  const isolation = await GitIsolationRuntime.create({authority, identity: {name: "Local Action Host", email: "host@example.invalid"}});
  const branchCall = call("git.branch", {repo_path: "repo", name: "feature/local-action"}, {head, branch_absent: true});
  assert.equal(retain(branchCall, await isolation.execute(branchCall)).status, "succeeded");
  const worktreeCall = call("git.worktree", {repo_path: "repo", branch: "feature/local-action", path: "task-wt"}, {branch_head: head, target_absent: true});
  assert.equal(retain(worktreeCall, await isolation.execute(worktreeCall)).status, "succeeded");
  const worktree = join(workspace, "task-wt");
  await writeFile(join(worktree, "notes.txt"), "unrelated staged notes\n");
  await git(worktree, ["add", "--", "notes.txt"]);
  const unrelatedStaged = await git(worktree, ["diff", "--cached", "--binary", "--", "notes.txt"]);
  async function runBoundTest() {
    const plan = await bindProcessPlan({id: "local-action-test", workspace_root: workspace, cwd: "task-wt",
      executable: process.execPath, argv: ["--test", "--test-reporter=tap", "calc.test.cjs"],
      input_paths: ["task-wt/calc.cjs", "task-wt/calc.test.cjs"], repo_path: "task-wt", expected_head: head,
      grant: "host-user", purpose: "test", max_runtime_ms: 10_000, max_output_bytes: 64 * 1024});
    const runtime = await ProcessLifecycleRuntime.create({workspace_root: workspace, artifact_root: artifacts, plans: [plan], authority,
      previous_receipt_hash: previous()});
    t.after(() => runtime.close());
    const request = call("test.run", {plan_id: plan.id}, {plan_digest: plan.digest});
    const result = retain(request, await runtime.execute(request));
    await runtime.close();
    return {plan, result};
  }
  const failed = await runBoundTest();
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.error.code, "TEST_FAILED");
  assert.equal(failed.result.output.session.exit_code, 1);
  const artifactStore = new ArtifactStore(artifacts);
  const failedStdout = Buffer.from(await artifactStore.get(failed.result.artifacts[0])).toString();
  assert.match(failedStdout, /not ok 1 - sum matches expected value/);
  const preimage = await readFile(join(worktree, "calc.cjs"));
  const writer = await WritePlaneRuntime.create({authority, previous_receipt_hash: previous()});
  const patchCall = call("fs.patch", {path: "task-wt/calc.cjs", old_text: "a - b", new_text: "a + b", expected_replacements: 1},
    {exists: true, sha256: sha256(preimage)});
  assert.equal(retain(patchCall, await writer.execute(patchCall)).status, "succeeded");
  const passed = await runBoundTest();
  assert.notEqual(passed.plan.digest, failed.plan.digest, "test plan must bind the changed input bytes");
  assert.equal(passed.result.status, "succeeded");
  assert.equal(passed.result.output.session.exit_code, 0);
  const passedStdout = Buffer.from(await artifactStore.get(passed.result.artifacts[0])).toString();
  assert.match(passedStdout, /ok 1 - sum matches expected value/);
  assert.match(passedStdout, /# fail 0/);
  const commitRuntime = await GitIsolationRuntime.create({authority, identity: {name: "Local Action Host", email: "host@example.invalid"},
    previous_receipt_hash: previous()});
  const commitCall = call("git.commit", {repo_path: "task-wt", message: "fix isolated sum", paths: ["calc.cjs"]}, {head});
  const committed = retain(commitCall, await commitRuntime.execute(commitCall));
  assert.equal(committed.status, "succeeded");
  const commit = committed.output.commit;
  assert.equal(await git(worktree, ["show", `${commit}:calc.cjs`]), "exports.add = (a, b) => a + b;");
  assert.equal(await git(worktree, ["show", `${commit}:notes.txt`]), "original notes");
  assert.equal(await git(worktree, ["diff", "--cached", "--binary", "--", "notes.txt"]), unrelatedStaged);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(repo, ["status", "--porcelain=v1"]), sourceStatus);
  assert.equal(await readFile(join(repo, "calc.cjs"), "utf8"), "exports.add = (a, b) => a - b;\n");
  assert.deepEqual(calls.map(call => call.status), ["succeeded", "succeeded", "failed", "succeeded", "succeeded", "succeeded"]);
  assert.equal(receipts.length, 12);

  const retained = new ArtifactStore(resolve("evidence/local/p2c-artifacts"));
  for (const ref of [...failed.result.artifacts, ...passed.result.artifacts]) assert.equal(await retained.put(await artifactStore.get(ref)), ref);
  const runtimeFiles: Record<string, string> = {};
  for (const file of await readdir("dist/src/runtime")) {
    if (file.endsWith(".js")) runtimeFiles[`dist/src/runtime/${file}`] = sha256(await readFile(`dist/src/runtime/${file}`));
  }
  if (process.platform === "win32") runtimeFiles["dist/native/toolfabric-process-host.exe"] = sha256(await readFile("dist/native/toolfabric-process-host.exe"));
  const proof = {schema: "resonarch.toolfabric.local-action-evidence/v1", platform: process.platform, node: process.version,
    runtime_revision: await git(process.cwd(), ["rev-parse", "HEAD"]), runtime_file_digests: runtimeFiles,
    fixture_pre_head: head, fixture_post_commit: commit, committed_tree: committed.output.tree,
    source_unchanged: true, unrelated_staged_preserved: true, receipts_verified: verifyChain(receipts),
    calls, receipts, negative_test: {plan_digest: failed.plan.digest, result: failed.result, stdout: failedStdout},
    positive_test: {plan_digest: passed.plan.digest, result: passed.result, stdout: passedStdout}, execution_grant: "host-user",
    claims: ["P2C_PROCESS_LIFECYCLE_SLICE", "P2_ISOLATED_CHANGE_TEST_RECEIPT_FIXTURE"],
    non_claims: ["OS filesystem/network sandbox", "P2_LOCAL_ACTION_PASS", "installed MCP server", "production readiness", "crash-durable receipt ledger"]};
  await mkdir("evidence/local", {recursive: true});
  await writeFile("evidence/local/p2c-local-action.json", JSON.stringify(proof, null, 2) + "\n");
});
