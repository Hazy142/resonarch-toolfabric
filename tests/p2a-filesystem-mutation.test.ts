import test from "node:test";
import assert from "node:assert/strict";
import {chmod, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sha256} from "../src/contracts/canonical.js";
import {verifyChain} from "../src/evidence/receipt.js";
import {LeaseBook} from "../src/orchestrator/leases.js";
import type {ToolCall} from "../src/runtime/readPlane.js";
import {WritePlaneRuntime} from "../src/runtime/writePlane.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p2a-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, {recursive: true});
  return {root, workspace};
}

function call(
  tool: "fs.write" | "fs.patch" | "fs.move",
  args: Record<string, unknown>,
  expected_state: Record<string, unknown>,
  workspace: string,
  approval_ref: string | undefined = "approval:test",
): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: "call-" + tool + "-" + Math.random().toString(36).slice(2, 8),
    task_id: "task-p2a",
    trace_id: "trace-p2a",
    tool: {id: tool, version: "2.0.0"},
    arguments: args,
    expected_state,
    approval_ref,
    scope: {workspace_root: workspace},
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function runtime(options: Record<string, unknown> = {}) {
  return WritePlaneRuntime.create({
    authority: {capabilities: ["fs:write"], approved_refs: ["approval:test"]},
    ...options,
  } as any);
}

test("P2A denies filesystem mutation without fs:write authority before intent", async () => {
  const {workspace} = await fixture();
  const r = await WritePlaneRuntime.create({authority: {capabilities: [], approved_refs: ["approval:test"]}});
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "CAPABILITY_DENIED");
  assert.equal(executed.receipts.length, 1);
  await assert.rejects(readFile(join(workspace, "a.txt")));
});

test("P2A requires host-approved approval_ref by default", async () => {
  const {workspace} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace, ""));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "APPROVAL_REQUIRED");
  assert.equal(executed.receipts.length, 1);
});

test("fs.write atomically creates an expected-missing file with intent/completion receipts", async () => {
  const {workspace} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "succeeded");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "hello");
  assert.equal(executed.receipts.length, 2);
  assert.equal(executed.receipts[0]?.phase, "intent");
  assert.equal(executed.receipts[1]?.phase, "completion");
  assert.equal(verifyChain(executed.receipts), true);
  assert.equal((executed.result.output as any).post_state.sha256, sha256("hello"));
});

test("expected-state mismatch denies before mutation and preserves original bytes", async () => {
  const {workspace} = await fixture();
  await writeFile(join(workspace, "a.txt"), "original");
  const r = await runtime();
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "new"}, {exists: true, sha256: sha256("wrong")}, workspace));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "EXPECTED_STATE_MISMATCH");
  assert.equal(executed.receipts.length, 1);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "original");
});

test("fs.patch binds the preimage digest and exact replacement count", async () => {
  const {workspace} = await fixture();
  await writeFile(join(workspace, "a.txt"), "alpha beta alpha");
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.patch",
    {path: "a.txt", old_text: "alpha", new_text: "omega", expected_replacements: 2},
    {exists: true, sha256: sha256("alpha beta alpha")},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "omega beta omega");
  assert.equal(verifyChain(executed.receipts), true);
});

test("fs.patch rejects replacement-count drift without emitting intent", async () => {
  const {workspace} = await fixture();
  await writeFile(join(workspace, "a.txt"), "alpha");
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.patch",
    {path: "a.txt", old_text: "alpha", new_text: "omega", expected_replacements: 2},
    {exists: true, sha256: sha256("alpha")},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "PATCH_PRECONDITION_FAILED");
  assert.equal(executed.receipts.length, 1);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "alpha");
});

test("fs.move requires bound source and destination states and moves atomically", async () => {
  const {workspace} = await fixture();
  await writeFile(join(workspace, "a.txt"), "payload");
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.move",
    {source: "a.txt", destination: "b.txt"},
    {
      source: {exists: true, sha256: sha256("payload")},
      destination: {exists: false},
    },
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  await assert.rejects(readFile(join(workspace, "a.txt")));
  assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "payload");
  assert.equal(verifyChain(executed.receipts), true);
});

test("stale fencing token stops the write after intent and before commit", async () => {
  const {workspace} = await fixture();
  const book = new LeaseBook();
  const r = await runtime({
    lease_book: book,
    before_commit: ({surfaces}: any) => {
      book.claim(surfaces[0], "competing-worker");
    },
  });
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "STALE_FENCING_TOKEN");
  assert.equal(executed.receipts.length, 2);
  await assert.rejects(readFile(join(workspace, "a.txt")));
});

test("ambiguous post-rename error reconciles to success when the expected post-state is present", async () => {
  const {workspace} = await fixture();
  const r = await runtime({
    fs_ops: {
      rename: async (source: string, destination: string) => {
        await rename(source, destination);
        throw new Error("simulated transport ambiguity after rename");
      },
    },
  });
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "succeeded");
  assert.equal((executed.result.output as any).reconciled, true);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "hello");
});

test("unexpected post-state after an ambiguous commit is reported uncertain and never guessed", async () => {
  const {workspace} = await fixture();
  const r = await runtime({
    fs_ops: {
      rename: async (source: string, destination: string) => {
        await rename(source, destination);
        await writeFile(destination, "unexpected");
        throw new Error("simulated ambiguous commit");
      },
    },
  });
  const executed = await r.execute(call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "uncertain");
  assert.equal(executed.result.error?.code, "MUTATION_OUTCOME_UNCERTAIN");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "unexpected");
  assert.equal(verifyChain(executed.receipts), true);
});

test("workspace traversal is denied for mutation targets", async () => {
  const {workspace} = await fixture();
  const r = await runtime();
  const executed = await r.execute(call("fs.write", {path: "../escape.txt", content: "x"}, {exists: false}, workspace));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "WORKSPACE_ESCAPE");
  assert.equal(executed.receipts.length, 1);
});


test("fs.write atomically replaces an expected existing file", async () => {
  const {workspace} = await fixture();
  await writeFile(join(workspace, "a.txt"), "before");
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.write",
    {path: "a.txt", content: "after"},
    {exists: true, sha256: sha256("before")},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "after");
  assert.equal(verifyChain(executed.receipts), true);
});

test("direct symbolic-link mutation targets fail closed when symlinks are available", async t => {
  const {root, workspace} = await fixture();
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");
  try {
    await symlink(outside, join(workspace, "link.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is not permitted on this host");
      return;
    }
    throw error;
  }
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.write",
    {path: "link.txt", content: "mutated"},
    {exists: true, sha256: sha256("outside")},
    workspace,
  ));
  assert.equal(executed.result.status, "denied");
  assert.equal(executed.result.error?.code, "SYMLINK_MUTATION_FORBIDDEN");
  assert.equal(await readFile(outside, "utf8"), "outside");
});


test("expired deadlines cancel before intent and preserve the filesystem", async () => {
  const {workspace} = await fixture();
  const r = await runtime();
  const request = call("fs.write", {path: "a.txt", content: "hello"}, {exists: false}, workspace);
  request.deadline = new Date(Date.now() - 1000).toISOString();
  const executed = await r.execute(request);
  assert.equal(executed.result.status, "cancelled");
  assert.equal(executed.result.error?.code, "DEADLINE_EXCEEDED");
  assert.equal(executed.receipts.length, 1);
  await assert.rejects(readFile(join(workspace, "a.txt")));
});

test("replacing an existing file preserves its POSIX mode", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX mode preservation is not meaningful on Windows");
    return;
  }
  const {workspace} = await fixture();
  const target = join(workspace, "script.sh");
  await writeFile(target, "#!/bin/sh\necho before\n");
  await chmod(target, 0o755);
  const r = await runtime();
  const executed = await r.execute(call(
    "fs.write",
    {path: "script.sh", content: "#!/bin/sh\necho after\n"},
    {exists: true, sha256: sha256("#!/bin/sh\necho before\n")},
    workspace,
  ));
  assert.equal(executed.result.status, "succeeded");
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test("sequential P2A calls extend one canonical task receipt chain", async () => {
  const {workspace} = await fixture();
  const r = await runtime();
  const first = await r.execute(call("fs.write", {path: "a.txt", content: "a"}, {exists: false}, workspace));
  const second = await r.execute(call("fs.write", {path: "b.txt", content: "b"}, {exists: false}, workspace));
  assert.equal(verifyChain([...first.receipts, ...second.receipts]), true);
});
