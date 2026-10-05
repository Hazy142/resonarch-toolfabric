import test from "node:test";
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative} from "node:path";
import {canonicalDigest} from "../src/contracts/canonical.js";
import {verifyChain} from "../src/evidence/receipt.js";
import {ReadPlaneRuntime, type ToolCall} from "../src/runtime/readPlane.js";

const execFile = promisify(execFileCallback);

async function makeFixture(): Promise<{workspace: string; artifacts: string}> {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p1-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(join(workspace, "src", "nested"), {recursive: true});
  await writeFile(join(workspace, "AGENTS.md"), "# root rules\n", "utf8");
  await writeFile(join(workspace, "src", "CLAUDE.md"), "# path rules\n", "utf8");
  await writeFile(join(workspace, "src", "hello.txt"), "alpha\nbeta\nneedle\n", "utf8");
  await writeFile(join(workspace, "src", "nested", "other.txt"), "needle twice needle\n", "utf8");
  await execFile("git", ["init"], {cwd: workspace});
  await execFile("git", ["config", "user.email", "fixture@example.invalid"], {cwd: workspace});
  await execFile("git", ["config", "user.name", "ToolFabric Fixture"], {cwd: workspace});
  await execFile("git", ["add", "."], {cwd: workspace});
  await execFile("git", ["commit", "-m", "fixture"], {cwd: workspace});
  return {workspace, artifacts};
}

function call(toolId: string, args: Record<string, unknown>, workspace: string): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: "call-" + toolId,
    task_id: "task-p1",
    trace_id: "trace-p1",
    tool: {id: toolId, version: "1.0.0"},
    arguments: args,
    scope: {workspace_root: workspace},
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function treeDigest(root: string): Promise<string> {
  const entries: Array<{path: string; type: string; size: number; mtimeMs: number; digest?: string}> = [];
  async function walk(path: string): Promise<void> {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const full = join(path, name);
      const info = await lstat(full);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (info.isDirectory()) {
        entries.push({path: rel, type: "dir", size: 0, mtimeMs: info.mtimeMs});
        await walk(full);
      } else if (info.isFile()) {
        entries.push({
          path: rel,
          type: "file",
          size: info.size,
          mtimeMs: info.mtimeMs,
          digest: canonicalDigest(new Uint8Array(await readFile(full))),
        });
      } else {
        entries.push({path: rel, type: info.isSymbolicLink() ? "symlink" : "other", size: info.size, mtimeMs: info.mtimeMs});
      }
    }
  }
  await walk(root);
  return canonicalDigest(entries);
}

test("P1 executes real fs reads and emits a verifiable receipt", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const request = call("fs.read", {path: "src/hello.txt"}, workspace);
  const executed = await runtime.execute(request);
  assert.equal(executed.result.status, "succeeded");
  assert.equal((executed.result.output as {content: string}).content, "alpha\nbeta\nneedle\n");
  assert.equal(executed.receipt.tool_id, "fs.read");
  assert.equal(executed.receipt.request_digest, canonicalDigest(request));
  assert.equal(verifyChain([executed.receipt]), true);
});

test("P1 runtime advances receipt chains per task without cross-task tail leakage", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const first = await runtime.execute(call("fs.stat", {path: "src/hello.txt"}, workspace));
  const second = await runtime.execute(call("fs.list", {path: "src"}, workspace));
  const otherRequest = call("registry.list", {}, workspace);
  otherRequest.task_id = "task-p1-other";
  otherRequest.call_id = "call-registry-list-other";
  const other = await runtime.execute(otherRequest);
  assert.equal(verifyChain([first.receipt, second.receipt]), true);
  assert.equal(other.receipt.previous_receipt_hash, "sha256:GENESIS");
});


test("P1 workspace boundary denies traversal and mutating primitives", async () => {
  const {workspace, artifacts} = await makeFixture();
  const outside = join(dirname(workspace), "outside.txt");
  await writeFile(outside, "outside", "utf8");
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const traversal = await runtime.execute(call("fs.read", {path: "../outside.txt"}, workspace));
  assert.equal(traversal.result.status, "denied");
  assert.equal((traversal.result.error as {code: string}).code, "WORKSPACE_ESCAPE");
  const write = await runtime.execute(call("fs.patch", {path: "src/hello.txt", patch: "anything"}, workspace));
  assert.equal(write.result.status, "denied");
  assert.equal((write.result.error as {code: string}).code, "P1_WRITE_FORBIDDEN");
  assert.equal(await readFile(join(workspace, "src", "hello.txt"), "utf8"), "alpha\nbeta\nneedle\n");
});

test("P1 rejects symlink escape when the platform permits the fixture", async t => {
  const {workspace, artifacts} = await makeFixture();
  const outside = join(dirname(workspace), "outside.txt");
  await writeFile(outside, "outside", "utf8");
  try {
    await symlink(outside, join(workspace, "src", "escape.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is not permitted on this host");
      return;
    }
    throw error;
  }
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const result = await runtime.execute(call("fs.read", {path: "src/escape.txt"}, workspace));
  assert.equal(result.result.status, "denied");
  assert.equal((result.result.error as {code: string}).code, "WORKSPACE_ESCAPE");
});

test("P1 artifactizes large canonical output outside the workspace", async () => {
  const {workspace, artifacts} = await makeFixture();
  await writeFile(join(workspace, "src", "large.txt"), "x".repeat(4096), "utf8");
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, inlineOutputLimitBytes: 128});
  const executed = await runtime.execute(call("fs.read", {path: "src/large.txt"}, workspace));
  assert.equal(executed.result.status, "succeeded");
  assert.equal(executed.result.artifacts.length, 1);
  assert.equal((executed.result.output as {artifactized: boolean}).artifactized, true);
  assert.ok((executed.result.output as {bytes: number}).bytes > 4096);
  const stored = JSON.parse(new TextDecoder().decode(await runtime.artifactStore.get(executed.result.artifacts[0]!)));
  assert.equal(stored.content.length, 4096);
});

test("P1 refuses artifact storage inside the workspace before creating it", async () => {
  const {workspace} = await makeFixture();
  const artifactRoot = join(workspace, ".toolfabric-artifacts");
  await writeFile(join(workspace, "src", "large.txt"), "x".repeat(4096), "utf8");
  const runtime = await ReadPlaneRuntime.create({artifactRoot, inlineOutputLimitBytes: 128});
  const executed = await runtime.execute(call("fs.read", {path: "src/large.txt"}, workspace));
  assert.equal(executed.result.status, "denied");
  assert.equal((executed.result.error as {code: string}).code, "ARTIFACT_STORE_SCOPE");
  await assert.rejects(() => lstat(artifactRoot), /ENOENT/);
});

test("P1 runs read-only git commands against a real fixture repository without workspace writes", async () => {
  const {workspace, artifacts} = await makeFixture();
  await writeFile(join(workspace, "src", "hello.txt"), "alpha\nchanged\n", "utf8");
  const before = await treeDigest(workspace);
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const status = await runtime.execute(call("git.status", {}, workspace));
  const log = await runtime.execute(call("git.log", {limit: 5}, workspace));
  const diff = await runtime.execute(call("git.diff", {}, workspace));
  assert.equal(status.result.status, "succeeded");
  assert.equal((status.result.output as {clean: boolean}).clean, false);
  assert.equal(log.result.status, "succeeded");
  assert.equal((log.result.output as {commits: unknown[]}).commits.length, 1);
  assert.match((diff.result.output as {diff: string}).diff, /changed/);
  assert.equal(await treeDigest(workspace), before);
});

test("P1 discovers scoped instruction files, searches files, and exposes read-only environment helpers", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const instructions = await runtime.execute(call("instructions.discover", {path: "src/nested"}, workspace));
  assert.equal(instructions.result.status, "succeeded");
  assert.deepEqual(
    (instructions.result.output as {instructions: Array<{path: string}>}).instructions.map(item => item.path),
    ["AGENTS.md", "src/CLAUDE.md"],
  );
  const search = await runtime.execute(call("fs.search", {path: "src", query: "needle"}, workspace));
  assert.equal(search.result.status, "succeeded");
  assert.deepEqual(
    (search.result.output as {matches: Array<{path: string}>}).matches.map(item => item.path),
    ["src/hello.txt", "src/nested/other.txt"],
  );
  process.env.TOOLFABRIC_TEST_TOKEN = "super-secret";
  const env = await runtime.execute(call("env.snapshot", {keys: ["TOOLFABRIC_TEST_TOKEN", "PATH"]}, workspace));
  assert.equal((env.result.output as {variables: Record<string, string>}).variables.TOOLFABRIC_TEST_TOKEN, "[REDACTED]");
  const which = await runtime.execute(call("command.which", {command: "git"}, workspace));
  assert.equal(which.result.status, "succeeded");
  assert.equal(typeof (which.result.output as {path: string}).path, "string");
});

test("P1 registry read primitives execute while expired calls cancel before execution", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const list = await runtime.execute(call("registry.list", {}, workspace));
  assert.equal(list.result.status, "succeeded");
  assert.equal((list.result.output as {tools: unknown[]}).tools.length, 112);
  const describe = await runtime.execute(call("registry.describe", {id: "fs.read"}, workspace));
  assert.equal((describe.result.output as {tool: {id: string}}).tool.id, "fs.read");
  const expired = call("fs.read", {path: "src/hello.txt"}, workspace);
  expired.deadline = new Date(Date.now() - 1000).toISOString();
  const cancelled = await runtime.execute(expired);
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal((cancelled.result.error as {code: string}).code, "DEADLINE_EXCEEDED");
});

test("P1 fs.read_many, fs.list, and fs.stat execute against real filesystem state", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const many = await runtime.execute(call("fs.read_many", {paths: ["AGENTS.md", "src/hello.txt"]}, workspace));
  assert.equal(many.result.status, "succeeded");
  assert.equal((many.result.output as {files: unknown[]}).files.length, 2);
  const list = await runtime.execute(call("fs.list", {path: "src"}, workspace));
  assert.equal(list.result.status, "succeeded");
  assert.deepEqual(
    (list.result.output as {entries: Array<{name: string}>}).entries.map(entry => entry.name),
    ["CLAUDE.md", "hello.txt", "nested"],
  );
  const stat = await runtime.execute(call("fs.stat", {path: "src/hello.txt"}, workspace));
  assert.equal(stat.result.status, "succeeded");
  assert.equal((stat.result.output as {type: string}).type, "file");
});

test("P1 git reads ignore hostile host redirection and cannot discover a parent repo outside scope", async () => {
  const {workspace, artifacts} = await makeFixture();
  const other = await makeFixture();
  await writeFile(join(other.workspace, "src", "hello.txt"), "outside repo is dirty\n", "utf8");

  const previousDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(other.workspace, ".git");
  process.env.GIT_WORK_TREE = other.workspace;
  try {
    const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
    const status = await runtime.execute(call("git.status", {}, workspace));
    assert.equal(status.result.status, "succeeded");
    assert.equal((status.result.output as {clean: boolean}).clean, true);
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousWorkTree;
  }

  const scopedRuntime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const parentEscape = await scopedRuntime.execute(call("git.status", {}, join(workspace, "src")));
  assert.equal(parentEscape.result.status, "failed");
  assert.equal((parentEscape.result.error as {code: string}).code, "GIT_COMMAND_FAILED");
});

test("P1 fails closed on malformed fs paths and git revision options", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const badPath = await runtime.execute(call("fs.read", {path: 42}, workspace));
  assert.equal(badPath.result.status, "denied");
  assert.equal((badPath.result.error as {code: string}).code, "INVALID_ARGUMENT");
  const injectedRevision = await runtime.execute(call("git.diff", {revision: "--no-index"}, workspace));
  assert.equal(injectedRevision.result.status, "denied");
  assert.equal((injectedRevision.result.error as {code: string}).code, "INVALID_ARGUMENT");
});
