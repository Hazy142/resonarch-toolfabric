import {randomUUID} from "node:crypto";
import {mkdir, realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {canonicalDigest, canonicalJson} from "../contracts/canonical.js";
import type {ResultStatus, ToolDescriptor} from "../contracts/types.js";
import {createReceipt, type Receipt} from "../evidence/receipt.js";
import {ArtifactStore} from "../evidence/artifacts.js";
import {LeaseBook} from "../orchestrator/leases.js";
import type {Lease} from "../orchestrator/types.js";
import {loadRegistry} from "../registry/load.js";
import type {ToolCall, ToolResult} from "./readPlane.js";
import {verifyProcessPlan, processFileDigest, type BoundProcessPlan} from "./processPlan.js";
import type {MutationAuthority} from "./writePlane.js";
import {WorkspaceBoundary, isWithinPath} from "./workspace.js";
import {RuntimeExecutionError} from "./errors.js";
import {ProcessSessions} from "./processSessions.js";

export interface ProcessLifecycleOptions {
  workspace_root: string;
  artifact_root: string;
  plans: readonly BoundProcessPlan[];
  authority: MutationAuthority;
  previous_receipt_hash?: string;
  lease_book?: LeaseBook;
  max_active_sessions?: number;
  max_retained_sessions?: number;
  windows_host_path?: string;
  before_mutation?: (context: {tool_id: string; leases: Lease[]}) => void | Promise<void>;
  after_mutation?: (context: {tool_id: string}) => void | Promise<void>;
}

const TOOLS = new Set(["process.start", "process.input", "process.output", "process.stop", "process.list", "test.run"]);
const MUTATIONS = new Set(["process.start", "process.input", "process.stop", "test.run"]);

function assertDeadline(call: ToolCall): void {
  const time = Date.parse(call.deadline);
  if (!Number.isFinite(time)) throw new RuntimeExecutionError("INVALID_DEADLINE", "invalid call deadline", "denied");
  if (time <= Date.now()) throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "call deadline elapsed", "cancelled");
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value || value.includes("\0")) throw new RuntimeExecutionError("INVALID_ARGUMENT", `${key} must be a NUL-free string`, "denied");
  return value;
}

function exactArgs(args: Record<string, unknown>, keys: string[]): void {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "unknown or invalid process arguments", "denied");
  }
}

async function prepareArtifactRoot(root: string, workspace: string): Promise<string> {
  const path = resolve(root);
  if (isWithinPath(workspace, path)) throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifacts must be outside workspace", "denied");
  let probe = path;
  while (true) {
    try {
      const ancestor = await realpath(probe);
      if (isWithinPath(workspace, ancestor)) throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact ancestor enters workspace", "denied");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  await mkdir(path, {recursive: true});
  return realpath(path);
}

export class ProcessLifecycleRuntime {
  private readonly descriptors: Map<string, ToolDescriptor>;
  private readonly plans: Map<string, BoundProcessPlan>;
  private readonly capabilities: Set<string>;
  private readonly approvals: Set<string>;
  private readonly leases: LeaseBook;
  private readonly tails = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  private readonly artifacts: ArtifactStore;

  private constructor(private readonly options: ProcessLifecycleOptions, private readonly workspace: string,
    registry: ToolDescriptor[], private readonly sessions: ProcessSessions, artifactRoot: string) {
    this.descriptors = new Map(registry.map(tool => [tool.id, tool]));
    this.plans = new Map(options.plans.map(plan => [plan.id, plan]));
    this.capabilities = new Set(options.authority.capabilities);
    this.approvals = new Set(options.authority.approved_refs ?? []);
    this.leases = options.lease_book ?? new LeaseBook();
    this.artifacts = new ArtifactStore(artifactRoot);
  }

  static async create(options: ProcessLifecycleOptions): Promise<ProcessLifecycleRuntime> {
    const boundary = await WorkspaceBoundary.create(options.workspace_root);
    if (options.plans.length > 64 || new Set(options.plans.map(plan => plan.id)).size !== options.plans.length) {
      throw new RuntimeExecutionError("INVALID_PROCESS_PLANS", "host plans must have unique identities and count <=64", "denied");
    }
    for (const plan of options.plans) {
      if (plan.workspace_root !== boundary.root || plan.grant !== "host-user") throw new RuntimeExecutionError("INVALID_PROCESS_PLANS", "plan must match host workspace and explicit execution grant", "denied");
    }
    const artifactRoot = await prepareArtifactRoot(options.artifact_root, boundary.root);
    let windowsHost: {path: string; digest: string} | undefined;
    if (process.platform === "win32") {
      const path = await realpath(options.windows_host_path ?? resolve("dist/native/toolfabric-process-host.exe"));
      windowsHost = {path, digest: await processFileDigest(path)};
    }
    return new ProcessLifecycleRuntime(options, boundary.root, await loadRegistry("contracts/tools"),
      new ProcessSessions(windowsHost, options.max_active_sessions, options.max_retained_sessions), artifactRoot);
  }

  async execute(call: ToolCall): Promise<{result: ToolResult; receipts: Receipt[]}> {
    const prior = this.queues.get(call.task_id) ?? Promise.resolve();
    const pending = prior.then(() => this.executeOne(call));
    const tail = pending.then(() => undefined, () => undefined);
    this.queues.set(call.task_id, tail);
    try { return await pending; }
    finally { if (this.queues.get(call.task_id) === tail) this.queues.delete(call.task_id); }
  }

  private async executeOne(call: ToolCall): Promise<{result: ToolResult; receipts: Receipt[]}> {
    const started = new Date();
    let descriptor: ToolDescriptor | undefined;
    let intent: Receipt | undefined;
    let mutationStarted = false;
    let output: unknown = null;
    const result = (status: ResultStatus, error: ToolResult["error"] = null, artifacts: string[] = []): ToolResult => {
      const finished = new Date();
      return {schema: "resonarch.toolfabric.result/v1", call_id: call.call_id, status, output, artifacts, diagnostics: [],
        timing: {started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: finished.getTime() - started.getTime()}, error};
    };
    try {
      if (call.schema !== "resonarch.toolfabric.call/v1" || [call.call_id, call.task_id, call.trace_id].some(id => typeof id !== "string" || !id || id.length > 128 || id.includes("\0"))) {
        throw new RuntimeExecutionError("INVALID_CALL_SCHEMA", "invalid canonical call identity", "denied");
      }
      descriptor = this.descriptors.get(call.tool?.id);
      if (!descriptor || !TOOLS.has(descriptor.id)) throw new RuntimeExecutionError("P2C_TOOL_NOT_IMPLEMENTED", "tool is outside the process lifecycle slice", "denied");
      if (call.tool.version !== descriptor.version) throw new RuntimeExecutionError("TOOL_VERSION_MISMATCH", "tool version differs from registry", "denied");
      assertDeadline(call);
      const key = canonicalDigest({task_id: call.task_id, call_id: call.call_id});
      if (this.seen.has(key)) throw new RuntimeExecutionError("DUPLICATE_CALL_ID", "call identity was already used; do not replay mutations", "denied");
      if (this.seen.size >= 4096 || (!this.tails.has(call.task_id) && this.tails.size >= 256)) {
        throw new RuntimeExecutionError("PROCESS_CALL_BUDGET_EXCEEDED", "host runtime call/task budget exhausted", "denied");
      }
      this.seen.add(key);
      for (const capability of descriptor.capabilities) {
        if (!this.capabilities.has(capability)) throw new RuntimeExecutionError("CAPABILITY_DENIED", `missing host capability: ${capability}`, "denied");
      }
      const mutating = MUTATIONS.has(descriptor.id);
      if (mutating) {
        if (typeof call.approval_ref !== "string" || !call.approval_ref) throw new RuntimeExecutionError("APPROVAL_REQUIRED", "process mutation requires approval_ref", "denied");
        if (!this.approvals.has(call.approval_ref)) throw new RuntimeExecutionError("APPROVAL_DENIED", "approval_ref is not host approved", "denied");
      }
      const scope = await WorkspaceBoundary.create(call.scope.workspace_root);
      if (scope.root !== this.workspace) throw new RuntimeExecutionError("WORKSPACE_SCOPE_MISMATCH", "call workspace differs from host workspace", "denied");
      const args = call.arguments;
      if (descriptor.id === "process.list") {
        exactArgs(args, []);
        output = {sessions: this.sessions.list(call.task_id, this.workspace)};
        return this.finish(call, descriptor, result("succeeded"));
      }
      if (descriptor.id === "process.output") {
        exactArgs(args, ["session_id", "stdout_offset", "stderr_offset", "max_bytes"]);
        const id = stringArg(args, "session_id");
        const bytes = args.max_bytes ?? 16 * 1024;
        if (!Number.isInteger(bytes) || Number(bytes) > 32 * 1024) throw new RuntimeExecutionError("INVALID_OUTPUT_PAGE_SIZE", "output page limit is 32 KiB", "denied");
        const stdoutOffset = args.stdout_offset ?? 0;
        const stderrOffset = args.stderr_offset ?? 0;
        if (!Number.isInteger(stdoutOffset) || !Number.isInteger(stderrOffset)) throw new RuntimeExecutionError("INVALID_OUTPUT_CURSOR", "output cursors must be integers", "denied");
        output = this.sessions.read(id, call.task_id, this.workspace, stdoutOffset as number, stderrOffset as number, bytes as number);
        return this.finish(call, descriptor, result("succeeded"));
      }

      let plan: BoundProcessPlan | undefined;
      let sessionId: string | undefined;
      const launching = descriptor.id === "process.start" || descriptor.id === "test.run";
      if (launching) {
        exactArgs(args, ["plan_id"]);
        plan = this.plans.get(stringArg(args, "plan_id"));
        if (!plan) throw new RuntimeExecutionError("PROCESS_PLAN_NOT_FOUND", "plan was not registered by the host", "denied");
        if (call.expected_state?.plan_digest !== plan.digest) throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "plan digest differs from expected state", "denied");
        if (descriptor.id === "test.run" && plan.purpose !== "test") throw new RuntimeExecutionError("NOT_A_TEST_PLAN", "test.run requires a host-designated test plan", "denied");
        await verifyProcessPlan(plan, call.deadline);
      } else {
        exactArgs(args, descriptor.id === "process.input" ? ["session_id", "data", "eof"] : ["session_id"]);
        sessionId = stringArg(args, "session_id");
        const snapshot = this.sessions.snapshot(sessionId, call.task_id, this.workspace);
        this.sessions.assertRevision(sessionId, call.task_id, this.workspace, call.expected_state?.revision);
        if (descriptor.id === "process.input") {
          if (typeof args.data !== "string" || Buffer.byteLength(args.data) > 16 * 1024 || (args.eof !== undefined && typeof args.eof !== "boolean")) {
            throw new RuntimeExecutionError("INVALID_ARGUMENT", "stdin requires <=16 KiB data and optional boolean eof", "denied");
          }
          if (!this.plans.get(snapshot.plan_id)?.allow_input) throw new RuntimeExecutionError("PROCESS_INPUT_FORBIDDEN", "host plan forbids stdin", "denied");
          if (snapshot.state !== "running") throw new RuntimeExecutionError("PROCESS_NOT_RUNNING", "session is not running", "denied");
        }
      }
      const surface = `process/${canonicalDigest(this.workspace)}/${sessionId ?? plan!.id}`;
      const leases = [this.leases.claim(surface, "toolfabric-process-lifecycle", 125_000)];
      const planned = {tool_id: descriptor.id, plan_digest: plan?.digest ?? null, session_id: sessionId ?? null,
        expected_state: call.expected_state, execution_grant: "host-user", workspace: this.workspace};
      intent = createReceipt({schema: "resonarch.toolfabric.receipt/v1", receipt_id: `${call.call_id}:intent`, trace_id: call.trace_id,
        task_id: call.task_id, call_id: call.call_id, tool_id: descriptor.id, tool_version: descriptor.version,
        request_digest: canonicalDigest(call), result_digest: canonicalDigest(planned), side_effect: descriptor.side_effect,
        status: "intent", phase: "intent", previous_receipt_hash: this.previous(call.task_id), artifact_refs: [],
        plan_digest: canonicalDigest(planned), fencing_tokens: leases.map(lease => lease.fencing_token), approval_ref: call.approval_ref});
      if (this.options.before_mutation) await this.options.before_mutation({tool_id: descriptor.id, leases});
      assertDeadline(call);
      this.assertLeases(leases);
      if (plan) await verifyProcessPlan(plan, call.deadline);
      else this.sessions.assertRevision(sessionId!, call.task_id, this.workspace, call.expected_state?.revision);
      assertDeadline(call);
      this.assertLeases(leases);
      mutationStarted = true;
      if (launching) {
        const session = await this.sessions.start(plan!, call.task_id, call.deadline);
        output = {session};
        if (descriptor.id === "process.start") {
          if (this.options.after_mutation) await this.options.after_mutation({tool_id: descriptor.id});
          return this.finish(call, descriptor, result("succeeded"), intent);
        }
        const ended = await this.sessions.wait(session.session_id, call.task_id, this.workspace);
        const captured = this.sessions.read(session.session_id, call.task_id, this.workspace, 0, 0, plan!.max_output_bytes);
        const stdout = await this.artifacts.put(Buffer.from(captured.stdout_base64, "base64"));
        const stderr = await this.artifacts.put(Buffer.from(captured.stderr_base64, "base64"));
        const manifest = await this.artifacts.put(Buffer.from(canonicalJson({schema: "resonarch.toolfabric.process-evidence/v1",
          session: ended, declared_inputs: plan!.input_files, executable_digest: plan!.executable_digest,
          stdout_ref: stdout, stderr_ref: stderr, retained_bytes: captured.retained_bytes, discarded_bytes: captured.discarded_bytes,
          output_truncated: captured.truncated, execution_grant: "host-user"})));
        output = {session: ended, output_truncated: captured.truncated, stdout_ref: stdout, stderr_ref: stderr, manifest_ref: manifest};
        const refs = [stdout, stderr, manifest];
        if (ended.state === "uncertain") return this.finish(call, descriptor, result("uncertain", {code: "PROCESS_OUTCOME_UNCERTAIN", message: "process termination was not confirmed"}, refs), intent);
        if (ended.state === "timed_out" || ended.state === "stopped") return this.finish(call, descriptor,
          result("cancelled", {code: ended.state === "timed_out" ? "DEADLINE_EXCEEDED" : "PROCESS_STOPPED", message: "test process was terminated"}, refs), intent);
        if (ended.state !== "exited" || ended.exit_code !== 0) return this.finish(call, descriptor,
          result("failed", {code: "TEST_FAILED", message: `test exited with code ${ended.exit_code}`}, refs), intent);
        return this.finish(call, descriptor, result("succeeded", null, refs), intent);
      }
      if (descriptor.id === "process.input") {
        const accepted = await this.sessions.input(sessionId!, call.task_id, this.workspace, args.data as string, args.eof === true, call.deadline);
        output = {session: this.sessions.snapshot(sessionId!, call.task_id, this.workspace), accepted_bytes: accepted};
      } else output = {session: await this.sessions.stop(sessionId!, call.task_id, this.workspace)};
      if (this.options.after_mutation) await this.options.after_mutation({tool_id: descriptor.id});
      return this.finish(call, descriptor, result("succeeded"), intent);
    } catch (error) {
      const known = error instanceof RuntimeExecutionError ? error : null;
      const status = known?.status ?? (mutationStarted ? "uncertain" : "failed");
      return this.finish(call, descriptor, result(status, {code: known?.code ?? (mutationStarted ? "PROCESS_OUTCOME_UNCERTAIN" : "EXECUTION_FAILED"),
        message: error instanceof Error ? error.message : String(error)}), intent);
    }
  }

  private assertLeases(leases: Lease[]): void {
    try { for (const lease of leases) this.leases.assertCurrent(lease); }
    catch { throw new RuntimeExecutionError("STALE_FENCING_TOKEN", "process mutation lease is stale", "denied"); }
  }
  private previous(task: string): string { return this.tails.get(task) ?? this.options.previous_receipt_hash ?? "sha256:GENESIS"; }
  private finish(call: ToolCall, descriptor: ToolDescriptor | undefined, result: ToolResult, intent?: Receipt) {
    const completion = createReceipt({schema: "resonarch.toolfabric.receipt/v1", receipt_id: `${call.call_id}:completion:${randomUUID()}`,
      trace_id: call.trace_id, task_id: call.task_id, call_id: call.call_id, tool_id: descriptor?.id ?? call.tool?.id ?? "unknown",
      tool_version: descriptor?.version ?? call.tool?.version ?? "unknown", request_digest: canonicalDigest(call), result_digest: canonicalDigest(result),
      side_effect: descriptor?.side_effect ?? "none", status: result.status, phase: "completion", previous_receipt_hash: intent?.receipt_hash ?? this.previous(call.task_id),
      artifact_refs: result.artifacts, intent_receipt_hash: intent?.receipt_hash ?? null, approval_ref: call.approval_ref ?? null});
    if (this.tails.has(call.task_id) || this.tails.size < 256) this.tails.set(call.task_id, completion.receipt_hash);
    return {result, receipts: intent ? [intent, completion] : [completion]};
  }
  async close(): Promise<void> { await this.sessions.close(); }
}
