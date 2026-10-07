import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {bindProcessPlan, processFileDigest} from "../src/runtime/processPlan.js";
import {ProcessSessions} from "../src/runtime/processSessions.js";
import {ProcessLifecycleRuntime} from "../src/runtime/processLifecycle.js";
import type {ToolCall} from "../src/runtime/readPlane.js";
import {verifyChain} from "../src/evidence/receipt.js";
import {ArtifactStore} from "../src/evidence/artifacts.js";
import {LeaseBook} from "../src/orchestrator/leases.js";

const capabilities = ["process:start", "process:input", "process:read", "process:stop", "process:host_execution", "test:run"];

function call(tool: string, workspace: string, args: Record<string, unknown>, expected: Record<string, unknown> = {}, task = "task-process"): ToolCall {
  return {schema: "resonarch.toolfabric.call/v1", call_id: crypto.randomUUID(), task_id: task, trace_id: "trace-process",
    tool: {id: tool, version: "2.0.0"}, arguments: args, expected_state: expected, approval_ref: "approval:fixture",
    scope: {workspace_root: workspace}, deadline: new Date(Date.now() + 10_000).toISOString()};
}

async function fixture(program: string, overrides: Record<string, any> = {}) {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p2c-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(workspace);
  await writeFile(join(workspace, "program.cjs"), program);
  const plan = await bindProcessPlan({id: "fixture", workspace_root: workspace, cwd: ".", executable: process.execPath,
    argv: ["program.cjs"], input_paths: ["program.cjs"], environment: {FIXTURE_MODE: "allowed"},
    grant: "host-user", purpose: "command", allow_input: true, max_runtime_ms: 5000, max_output_bytes: 4096,
    ...overrides.plan});
  const runtime = await ProcessLifecycleRuntime.create({workspace_root: workspace, artifact_root: artifacts, plans: [plan],
    authority: {capabilities, approved_refs: ["approval:fixture"]}, ...overrides.runtime});
  return {workspace, artifacts, plan, runtime};
}

async function outputUntil(r: ProcessLifecycleRuntime, workspace: string, id: string, predicate: (output: any) => boolean) {
  const receipts = [];
  const until = Date.now() + 7000;
  while (Date.now() < until) {
    const observed = await r.execute(call("process.output", workspace, {session_id: id}));
    assert.equal(observed.result.status, "succeeded");
    receipts.push(...observed.receipts);
    if (predicate(observed.result.output)) return {output: observed.result.output as any, receipts};
    await delay(15);
  }
  assert.fail("session did not reach the expected observed state");
}

test("P2C denies process launch without explicit host-execution capability before intent", async t => {
  const f = await fixture('require("node:fs").writeFileSync("ran", "yes");', {runtime: {authority: {capabilities: ["process:start"], approved_refs: ["approval:fixture"]}}});
  t.after(() => f.runtime.close());
  const denied = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.result.error?.code, "CAPABILITY_DENIED");
  assert.equal(denied.receipts.length, 1);
  await assert.rejects(readFile(join(f.workspace, "ran")), {code: "ENOENT"});
});

test("P2C rejects missing approval and model-supplied executable arguments", async t => {
  const f = await fixture('process.stdout.write("approved only");');
  t.after(() => f.runtime.close());
  const noApproval = call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest});
  noApproval.approval_ref = undefined;
  assert.equal((await f.runtime.execute(noApproval)).result.error?.code, "APPROVAL_REQUIRED");
  const injected = await f.runtime.execute(call("process.start", f.workspace,
    {plan_id: f.plan.id, executable: "malicious", argv: ["injected"]}, {plan_digest: f.plan.digest}));
  assert.equal(injected.result.error?.code, "INVALID_ARGUMENT");
  assert.equal(injected.receipts.length, 1);
});

test("P2C starts a real bound command with separate stdout/stderr and valid receipts", async t => {
  const f = await fixture('process.stdout.write("alpha\\n"); process.stderr.write("bravo\\n");');
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const session = (started.result.output as any).session;
  const observed = await outputUntil(f.runtime, f.workspace, session.session_id, out => out.session.state === "exited");
  assert.equal(observed.output.session.exit_code, 0);
  assert.equal(Buffer.from(observed.output.stdout_base64, "base64").toString(), "alpha\n");
  assert.equal(Buffer.from(observed.output.stderr_base64, "base64").toString(), "bravo\n");
  assert.equal(verifyChain([...started.receipts, ...observed.receipts]), true);
  assert.equal(observed.output.session.execution_grant, "host-user");
});

test("P2C binds plan digest and rechecks input bytes after intent", async t => {
  const f = await fixture('require("node:fs").writeFileSync("ran", "yes");');
  t.after(() => f.runtime.close());
  const stale = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: "sha256:" + "0".repeat(64)}));
  assert.equal(stale.result.error?.code, "EXPECTED_STATE_MISMATCH");
  const racing = await ProcessLifecycleRuntime.create({workspace_root: f.workspace, artifact_root: f.artifacts, plans: [f.plan],
    authority: {capabilities, approved_refs: ["approval:fixture"]}, before_mutation: async () => {
      await writeFile(join(f.workspace, "program.cjs"), 'require("node:fs").writeFileSync("ran", "tampered");');
    }});
  t.after(() => racing.close());
  const denied = await racing.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.result.error?.code, "PLAN_INPUT_DRIFT");
  assert.equal(denied.receipts.length, 2);
  assert.equal(verifyChain(denied.receipts), true);
  await assert.rejects(readFile(join(f.workspace, "ran")), {code: "ENOENT"});
});

test("P2C interactive input uses expected session revision and preserves task ownership", async t => {
  const f = await fixture('process.stdin.on("data", b => process.stdout.write("echo:" + b));');
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const s = (started.result.output as any).session;
  const foreign = await f.runtime.execute(call("process.input", f.workspace, {session_id: s.session_id, data: "forged\n"}, {revision: s.revision}, "other-task"));
  assert.equal(foreign.result.error?.code, "SESSION_SCOPE_MISMATCH");
  const delivered = await f.runtime.execute(call("process.input", f.workspace, {session_id: s.session_id, data: "hello\n"}, {revision: s.revision}));
  assert.equal(delivered.result.status, "succeeded");
  const stale = await f.runtime.execute(call("process.input", f.workspace, {session_id: s.session_id, data: "duplicate\n"}, {revision: s.revision}));
  assert.equal(stale.result.error?.code, "EXPECTED_STATE_MISMATCH");
  const observed = await outputUntil(f.runtime, f.workspace, s.session_id, out => Buffer.from(out.stdout_base64, "base64").toString().includes("echo:hello\n"));
  assert.equal(Buffer.from(observed.output.stdout_base64, "base64").toString(), "echo:hello\n");
  const stopped = await f.runtime.execute(call("process.stop", f.workspace, {session_id: s.session_id}, {revision: observed.output.session.revision}));
  assert.equal(stopped.result.status, "succeeded");
  assert.equal((stopped.result.output as any).session.state, "stopped");
});

test("P2C drains excess output and enforces a shared output budget", async t => {
  const f = await fixture('process.stdout.write("a".repeat(100000)); process.stderr.write("b".repeat(100000));', {plan: {max_output_bytes: 1024}});
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const observed = await outputUntil(f.runtime, f.workspace, (started.result.output as any).session.session_id, out => out.session.state === "exited");
  assert.equal(observed.output.retained_bytes, 1024);
  assert.equal(observed.output.discarded_bytes, 198976);
  assert.equal(observed.output.session.exit_code, 0);
});

test("P2C does not inherit ambient secrets or NODE_OPTIONS into approved commands", async t => {
  const saved = process.env.TOOLFABRIC_AMBIENT_SECRET;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  process.env.TOOLFABRIC_AMBIENT_SECRET = "must-not-inherit";
  t.after(() => { if (saved === undefined) delete process.env.TOOLFABRIC_AMBIENT_SECRET; else process.env.TOOLFABRIC_AMBIENT_SECRET = saved; });
  const f = await fixture('process.stdout.write(JSON.stringify({secret: process.env.TOOLFABRIC_AMBIENT_SECRET ?? null, mode: process.env.FIXTURE_MODE}));');
  await writeFile(join(f.workspace, "ambient.cjs"), 'require("node:fs").writeFileSync("ambient-ran", "yes"); process.exit(88);');
  process.env.NODE_OPTIONS = "--require " + JSON.stringify(join(f.workspace, "ambient.cjs"));
  t.after(() => { if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedNodeOptions; });
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  const observed = await outputUntil(f.runtime, f.workspace, (started.result.output as any).session.session_id, out => out.session.state === "exited");
  assert.deepEqual(JSON.parse(Buffer.from(observed.output.stdout_base64, "base64").toString()), {secret: null, mode: "allowed"});
  await assert.rejects(readFile(join(f.workspace, "ambient-ran")), {code: "ENOENT"});
});

test("P2C real failing test retains exit code and content-addressed stdout/stderr", async t => {
  const f = await fixture('process.stdout.write("test-output\\n"); process.stderr.write("assertion failed\\n"); process.exitCode = 7;', {plan: {purpose: "test"}});
  t.after(() => f.runtime.close());
  const executed = await f.runtime.execute(call("test.run", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(executed.result.status, "failed");
  assert.equal(executed.result.error?.code, "TEST_FAILED");
  assert.equal((executed.result.output as any).session.exit_code, 7);
  assert.equal(executed.result.artifacts.length, 3);
  const store = new ArtifactStore(f.artifacts);
  assert.equal(Buffer.from(await store.get(executed.result.artifacts[0]!)).toString(), "test-output\n");
  assert.equal(Buffer.from(await store.get(executed.result.artifacts[1]!)).toString(), "assertion failed\n");
  assert.equal(verifyChain(executed.receipts), true);
});

test("P2C test deadlines cancel the real owned process", async t => {
  const f = await fixture('setInterval(() => {}, 1000);', {plan: {purpose: "test", max_runtime_ms: 250}});
  t.after(() => f.runtime.close());
  const executed = await f.runtime.execute(call("test.run", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(executed.result.status, "cancelled");
  assert.equal(executed.result.error?.code, "DEADLINE_EXCEEDED");
  assert.equal((executed.result.output as any).session.state, "timed_out");
});

test("P2C rejects another workspace, expired launch and repeated call identity", async t => {
  const f = await fixture('process.stdout.write("once");');
  t.after(() => f.runtime.close());
  const foreignRoot = await mkdtemp(join(tmpdir(), "toolfabric-foreign-"));
  const foreign = await f.runtime.execute(call("process.start", foreignRoot, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(foreign.result.error?.code, "WORKSPACE_SCOPE_MISMATCH");
  const expired = call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest});
  expired.deadline = new Date(Date.now() - 1).toISOString();
  assert.equal((await f.runtime.execute(expired)).result.error?.code, "DEADLINE_EXCEEDED");
  const request = call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest});
  assert.equal((await f.runtime.execute(request)).result.status, "succeeded");
  assert.equal((await f.runtime.execute(request)).result.error?.code, "DUPLICATE_CALL_ID");
});

async function terminated(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (process.platform === "linux") {
    const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    return !state || state.slice(state.lastIndexOf(")") + 2).startsWith("Z ");
  }
  return false;
}

for (const normalExit of [false, true]) {
  test(`P2C ${normalExit ? "normal parent exit" : "explicit stop"} terminates an ordinary child process`, async t => {
    const script = 'const {spawn} = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"}); console.log(c.pid); '
      + (normalExit ? 'setTimeout(() => process.exit(0), 700);' : 'setInterval(() => {}, 1000);');
    const f = await fixture(script);
    t.after(() => f.runtime.close());
    const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
    assert.equal(started.result.status, "succeeded");
    const s = (started.result.output as any).session;
    const observed = await outputUntil(f.runtime, f.workspace, s.session_id, out => /^\d+\s/.test(Buffer.from(out.stdout_base64, "base64").toString()));
    const childPid = Number(Buffer.from(observed.output.stdout_base64, "base64").toString().trim());
    t.after(() => { if (!Number.isNaN(childPid)) { try { process.kill(childPid, "SIGKILL"); } catch {} } });
    assert.equal(await terminated(childPid), false);
    if (normalExit) await outputUntil(f.runtime, f.workspace, s.session_id, out => out.session.state === "exited");
    else {
      const stopped = await f.runtime.execute(call("process.stop", f.workspace, {session_id: s.session_id}, {revision: observed.output.session.revision}));
      assert.equal(stopped.result.status, "succeeded");
    }
    const until = Date.now() + 3000;
    while (!(await terminated(childPid)) && Date.now() < until) await delay(20);
    assert.equal(await terminated(childPid), true, "ordinary child must not outlive its managed session");
  });
}

test("P2C session lists reveal only the current task and enforce active capacity", async t => {
  const f = await fixture('setInterval(() => {}, 1000);', {runtime: {max_active_sessions: 1, max_retained_sessions: 2}});
  t.after(() => f.runtime.close());
  assert.equal((await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}))).result.status, "succeeded");
  const own = await f.runtime.execute(call("process.list", f.workspace, {}));
  assert.equal((own.result.output as any).sessions.length, 1);
  const foreign = await f.runtime.execute(call("process.list", f.workspace, {}, {}, "other-task"));
  assert.deepEqual((foreign.result.output as any).sessions, []);
  const blocked = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}, "other-task"));
  assert.equal(blocked.result.error?.code, "PROCESS_CAPACITY_EXCEEDED");
});

test("P2C output rejects string cursors instead of weakening its integer contract", async t => {
  const f = await fixture('process.stdout.write("data");');
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const id = (started.result.output as any).session.session_id;
  const observed = await outputUntil(f.runtime, f.workspace, id, out => out.session.state === "exited");
  const invalid = await f.runtime.execute(call("process.output", f.workspace, {session_id: id, stdout_offset: "0"}));
  assert.equal(invalid.result.status, "denied");
  assert.equal(invalid.result.error?.code, "INVALID_OUTPUT_CURSOR");
  assert.equal(observed.output.session.exit_code, 0);
});

test("P2C stale fencing prevents launch after intent", async t => {
  const leases = new LeaseBook();
  const f = await fixture('require("node:fs").writeFileSync("ran", "yes");', {runtime: {
    lease_book: leases, before_mutation: async (context: any) => { leases.claim(context.leases[0].node_id, "other-worker"); },
  }});
  t.after(() => f.runtime.close());
  const executed = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(executed.result.error?.code, "STALE_FENCING_TOKEN");
  assert.equal(executed.receipts.length, 2);
  await assert.rejects(readFile(join(f.workspace, "ran")), {code: "ENOENT"});
});

test("P2C an ambiguous stdin acknowledgement is uncertain and cannot be replayed", async t => {
  const f = await fixture('process.stdin.on("data", b => process.stdout.write("echo:" + b));', {runtime: {
    after_mutation: async (context: any) => { if (context.tool_id === "process.input") throw new Error("lost input acknowledgement"); },
  }});
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const s = (started.result.output as any).session;
  const request = call("process.input", f.workspace, {session_id: s.session_id, data: "once\n"}, {revision: s.revision});
  const uncertain = await f.runtime.execute(request);
  assert.equal(uncertain.result.status, "uncertain");
  assert.equal(uncertain.result.error?.code, "PROCESS_OUTCOME_UNCERTAIN");
  assert.equal((await f.runtime.execute(request)).result.error?.code, "DUPLICATE_CALL_ID");
  const observed = await outputUntil(f.runtime, f.workspace, s.session_id, out => Buffer.from(out.stdout_base64, "base64").toString().includes("echo:once\n"));
  assert.equal(Buffer.from(observed.output.stdout_base64, "base64").toString(), "echo:once\n");
});

test("P2C executable byte drift prevents launch", async t => {
  const f = await fixture('process.stdout.write("unused");');
  t.after(() => f.runtime.close());
  const executable = join(f.workspace, process.platform === "win32" ? "fake.exe" : "fake");
  await writeFile(executable, "original executable bytes");
  const plan = await bindProcessPlan({id: "bound-exe", workspace_root: f.workspace, cwd: ".", executable,
    argv: [], input_paths: [], grant: "host-user", purpose: "command"});
  const r = await ProcessLifecycleRuntime.create({workspace_root: f.workspace, artifact_root: f.artifacts, plans: [plan],
    authority: {capabilities, approved_refs: ["approval:fixture"]}});
  t.after(() => r.close());
  await writeFile(executable, "changed executable bytes");
  const denied = await r.execute(call("process.start", f.workspace, {plan_id: plan.id}, {plan_digest: plan.digest}));
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.result.error?.code, "PLAN_EXECUTABLE_DRIFT");
  assert.equal(denied.receipts.length, 1);
});

test("P2C EOF input cannot report accepted bytes after the program closed stdin", async t => {
  const f = await fixture('process.stdin.once("close", () => { try { require("node:fs").closeSync(0); } catch (e) { if (e.code !== "EBADF") throw e; } console.log("stdin-closed"); }); process.stdin.destroy(); setInterval(() => {}, 1000);');
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const s = (started.result.output as any).session;
  const observed = await outputUntil(f.runtime, f.workspace, s.session_id, out => Buffer.from(out.stdout_base64, "base64").toString().includes("stdin-closed"));
  const delivered = await f.runtime.execute(call("process.input", f.workspace, {session_id: s.session_id, data: "must not report accepted", eof: true}, {revision: observed.output.session.revision}));
  assert.notEqual(delivered.result.status, "succeeded");
});

test("P2C EOF input confirms a live reader and exposes its actual received bytes", async t => {
  const f = await fixture('let data = ""; process.stdin.on("data", b => data += b); process.stdin.on("end", () => console.log("received:" + data)); setInterval(() => {}, 1000);');
  t.after(() => f.runtime.close());
  const started = await f.runtime.execute(call("process.start", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest}));
  assert.equal(started.result.status, "succeeded");
  const s = (started.result.output as any).session;
  const delivered = await f.runtime.execute(call("process.input", f.workspace, {session_id: s.session_id, data: "payload", eof: true}, {revision: s.revision}));
  assert.equal(delivered.result.status, "succeeded");
  assert.equal((delivered.result.output as any).accepted_bytes, 7);
  const observed = await outputUntil(f.runtime, f.workspace, s.session_id, out => Buffer.from(out.stdout_base64, "base64").toString().includes("received:payload"));
  assert.equal(Buffer.from(observed.output.stdout_base64, "base64").toString(), "received:payload\n");
});

test("P2C escaped POSIX pipes produce bounded uncertainty instead of a hanging test", {skip: process.platform !== "linux"}, async t => {
  const f = await fixture('const {spawn} = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached:true, stdio:["ignore", "inherit", "inherit"]}); require("node:fs").writeFileSync("escaped-pid", String(c.pid)); process.exit(0);',
    {plan: {purpose: "test", max_runtime_ms: 200}});
  t.after(async () => {
    const pid = Number(await readFile(join(f.workspace, "escaped-pid"), "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await f.runtime.close();
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      f.runtime.execute(call("test.run", f.workspace, {plan_id: f.plan.id}, {plan_digest: f.plan.digest})),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test must not hang on escaped pipes")), 8000); }),
    ]);
    assert.equal(outcome.result.status, "uncertain");
    assert.equal((outcome.result.output as any).session.state, "uncertain");
  } finally { if (timer) clearTimeout(timer); }
});

test("P2C simultaneous distinct-task launches cannot exceed the active session limit", async t => {
  const f = await fixture('setInterval(() => {}, 1000);');
  t.after(() => f.runtime.close());
  const second = await bindProcessPlan({id: "second-plan", workspace_root: f.workspace, cwd: ".", executable: process.execPath,
    argv: ["program.cjs"], input_paths: ["program.cjs"], grant: "host-user", purpose: "command", max_runtime_ms: 5000});
  const runtime = await ProcessLifecycleRuntime.create({workspace_root: f.workspace, artifact_root: f.artifacts,
    plans: [f.plan, second], authority: {capabilities, approved_refs: ["approval:fixture"]}, max_active_sessions: 1, max_retained_sessions: 4});
  t.after(() => runtime.close());
  const outcomes = await Promise.all([f.plan, second].map((plan, index) => runtime.execute(
    call("process.start", f.workspace, {plan_id: plan.id}, {plan_digest: plan.digest}, `capacity-task-${index}`))));
  assert.deepEqual(outcomes.map(outcome => outcome.result.status).sort(), ["denied", "succeeded"]);
  assert.equal(outcomes.find(outcome => outcome.result.status === "denied")!.result.error?.code, "PROCESS_CAPACITY_EXCEEDED");
});

test("P2C shutdown during Windows supervisor validation prevents the pending launch", {skip: process.platform !== "win32"}, async t => {
  const f = await fixture('setInterval(() => {}, 1000);');
  t.after(() => f.runtime.close());
  const path = resolve("dist/native/toolfabric-process-host.exe");
  const sessions = new ProcessSessions({path, digest: await processFileDigest(path)}, 1, 4);
  t.after(() => sessions.close());
  const pending = sessions.start(f.plan, "shutdown-task", new Date(Date.now() + 10_000).toISOString());
  const shutdown = sessions.close();
  await assert.rejects(pending, {code: "PROCESS_RUNTIME_CLOSED"});
  await shutdown;
  assert.deepEqual(sessions.list("shutdown-task", f.workspace), []);
});
