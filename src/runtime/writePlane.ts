import {readFile} from "node:fs/promises";
import {canonicalDigest, sha256} from "../contracts/canonical.js";
import type {ResultStatus, ToolDescriptor} from "../contracts/types.js";
import {createReceipt, type Receipt} from "../evidence/receipt.js";
import {loadRegistry} from "../registry/load.js";
import {LeaseBook} from "../orchestrator/leases.js";
import type {Lease} from "../orchestrator/types.js";
import type {ToolCall, ToolResult} from "./readPlane.js";
import {RuntimeExecutionError} from "./errors.js";
import {
  atomicMove,
  atomicWrite,
  defaultMutationFsOps,
  exactReplacement,
  probeFile,
  stateMatches,
  utf8Bytes,
  type FileState,
  type MutationFsOps,
} from "./fsMutation.js";
import {WorkspaceBoundary} from "./workspace.js";

const P2A_TOOLS = new Set(["fs.write", "fs.patch", "fs.move"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface MutationAuthority {
  capabilities: readonly string[];
  approved_refs?: readonly string[];
  require_approval?: boolean;
}

export interface MutationHookContext {
  tool_id: string;
  surfaces: string[];
  leases: Lease[];
}

export interface WritePlaneOptions {
  authority: MutationAuthority;
  worker_id?: string;
  lease_book?: LeaseBook;
  fs_ops?: MutationFsOps;
  previous_receipt_hash?: string;
  before_commit?: (context: MutationHookContext) => void | Promise<void>;
}

export interface ExecutedMutation {
  result: ToolResult;
  receipts: Receipt[];
}

interface ExpectedSpec {
  exists: boolean;
  sha256?: string;
}

interface PreparedMutation {
  toolId: string;
  surfaces: string[];
  intent: Record<string, unknown>;
  output: Record<string, unknown>;
  mutate(): Promise<void>;
  assertPreState(): Promise<void>;
  reconcile(): Promise<"pre" | "post" | "unknown">;
}

function pathArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `${key} must be a non-empty string`, "denied");
  }
  return value;
}

function parseExpected(value: unknown, label: string): ExpectedSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label} expected state is required`, "denied");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.exists !== "boolean") {
    throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label}.exists must be boolean`, "denied");
  }
  if (raw.exists) {
    if (typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) {
      throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label}.sha256 is required for existing files`, "denied");
    }
    return {exists: true, sha256: raw.sha256};
  }
  if (raw.sha256 !== undefined && raw.sha256 !== null) {
    throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label}.sha256 must be absent when exists=false`, "denied");
  }
  return {exists: false};
}

function assertExpected(actual: FileState, expected: ExpectedSpec, label: string): void {
  if (actual.exists !== expected.exists) {
    throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", `${label} existence changed`, "denied");
  }
  if (expected.exists && actual.sha256 !== expected.sha256) {
    throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", `${label} digest changed`, "denied");
  }
}

function result(
  callId: string,
  status: ResultStatus,
  output: unknown,
  error: ToolResult["error"],
  started: Date,
  diagnostics: Array<Record<string, unknown>> = [],
): ToolResult {
  const finished = new Date();
  return {
    schema: "resonarch.toolfabric.result/v1",
    call_id: callId,
    status,
    output,
    artifacts: [],
    diagnostics,
    timing: {
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: Math.max(0, finished.getTime() - started.getTime()),
    },
    error,
  };
}

export class WritePlaneRuntime {
  private readonly tools: Map<string, ToolDescriptor>;
  private readonly authority: MutationAuthority;
  private readonly workerId: string;
  private readonly leases: LeaseBook;
  private readonly fsOps: MutationFsOps;
  private readonly initialReceiptHash: string;
  private readonly receiptTails = new Map<string, string>();
  private readonly beforeCommit?: WritePlaneOptions["before_commit"];

  private constructor(registry: ToolDescriptor[], options: WritePlaneOptions) {
    this.tools = new Map(registry.map(tool => [tool.id, tool]));
    this.authority = options.authority;
    this.workerId = options.worker_id ?? "toolfabric-write-plane";
    this.leases = options.lease_book ?? new LeaseBook();
    this.fsOps = options.fs_ops ?? defaultMutationFsOps;
    this.initialReceiptHash = options.previous_receipt_hash ?? "sha256:GENESIS";
    this.beforeCommit = options.before_commit;
  }

  static async create(options: WritePlaneOptions): Promise<WritePlaneRuntime> {
    return new WritePlaneRuntime(await loadRegistry("contracts/tools"), options);
  }

  async execute(call: ToolCall): Promise<ExecutedMutation> {
    const started = new Date();
    let descriptor: ToolDescriptor | undefined;
    let intentReceipt: Receipt | undefined;
    let prepared: PreparedMutation | undefined;
    let heldLeases: Lease[] = [];

    try {
      if (call.schema !== "resonarch.toolfabric.call/v1") {
        throw new RuntimeExecutionError("INVALID_CALL_SCHEMA", "invalid call schema", "denied");
      }
      descriptor = this.tools.get(call.tool?.id);
      if (!descriptor) throw new RuntimeExecutionError("TOOL_NOT_FOUND", "unknown tool", "denied");
      if (call.tool.version !== descriptor.version) {
        throw new RuntimeExecutionError("TOOL_VERSION_MISMATCH", "tool version does not match registry", "denied");
      }
      if (!P2A_TOOLS.has(descriptor.id)) {
        throw new RuntimeExecutionError("P2A_TOOL_NOT_IMPLEMENTED", `${descriptor.id} is outside the P2A filesystem slice`, "denied");
      }
      if (descriptor.side_effect !== "filesystem") {
        throw new RuntimeExecutionError("CONTRACT_SIDE_EFFECT_MISMATCH", "P2A requires filesystem side effects", "denied");
      }
      this.assertAuthority(descriptor, call);

      const boundary = await WorkspaceBoundary.create(call.scope.workspace_root);
      prepared = await this.prepare(call, boundary);

      heldLeases = prepared.surfaces
        .slice()
        .sort()
        .map(surface => this.leases.claim(surface, this.workerId));

      const previous = this.receiptTails.get(call.task_id) ?? this.initialReceiptHash;
      intentReceipt = createReceipt({
        schema: "resonarch.toolfabric.receipt/v1",
        receipt_id: `${call.call_id}:intent`,
        trace_id: call.trace_id,
        task_id: call.task_id,
        call_id: call.call_id,
        tool_id: descriptor.id,
        tool_version: descriptor.version,
        request_digest: canonicalDigest(call),
        result_digest: canonicalDigest(prepared.intent),
        side_effect: descriptor.side_effect,
        status: "intent",
        previous_receipt_hash: previous,
        artifact_refs: [],
        phase: "intent",
        plan_digest: canonicalDigest(prepared.intent),
        fencing_tokens: heldLeases.map(lease => lease.fencing_token),
      });

      if (this.beforeCommit) {
        await this.beforeCommit({tool_id: descriptor.id, surfaces: prepared.surfaces, leases: heldLeases});
      }
      for (const lease of heldLeases) this.assertLease(lease);
      await prepared.assertPreState();

      try {
        await prepared.mutate();
        const reconciliation = await prepared.reconcile();
        if (reconciliation !== "post") {
          throw new Error("POST_STATE_MISMATCH");
        }
        const succeeded = result(call.call_id, "succeeded", {...prepared.output, reconciled: false}, null, started);
        return this.finish(call, descriptor, succeeded, intentReceipt);
      } catch (mutationError) {
        const reconciliation = await prepared.reconcile().catch(() => "unknown" as const);
        if (reconciliation === "post") {
          const succeeded = result(
            call.call_id,
            "succeeded",
            {...prepared.output, reconciled: true},
            null,
            started,
            [{code: "RECONCILED_AFTER_MUTATION_ERROR", message: mutationError instanceof Error ? mutationError.message : String(mutationError)}],
          );
          return this.finish(call, descriptor, succeeded, intentReceipt);
        }
        if (reconciliation === "pre") {
          const known = mutationError instanceof RuntimeExecutionError
            ? mutationError
            : new RuntimeExecutionError("MUTATION_FAILED", mutationError instanceof Error ? mutationError.message : String(mutationError));
          const failed = result(call.call_id, known.status, null, {code: known.code, message: known.message}, started);
          return this.finish(call, descriptor, failed, intentReceipt);
        }
        const uncertain = result(
          call.call_id,
          "uncertain",
          null,
          {code: "MUTATION_OUTCOME_UNCERTAIN", message: mutationError instanceof Error ? mutationError.message : String(mutationError)},
          started,
        );
        return this.finish(call, descriptor, uncertain, intentReceipt);
      }
    } catch (error) {
      const known = error instanceof RuntimeExecutionError
        ? error
        : new RuntimeExecutionError("EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
      const failed = result(call.call_id, known.status, null, {code: known.code, message: known.message}, started);
      if (descriptor && intentReceipt) return this.finish(call, descriptor, failed, intentReceipt);
      return this.finishWithoutIntent(call, descriptor, failed);
    }
  }

  private assertAuthority(descriptor: ToolDescriptor, call: ToolCall): void {
    const granted = new Set(this.authority.capabilities);
    for (const capability of descriptor.capabilities) {
      if (!granted.has(capability)) {
        throw new RuntimeExecutionError("CAPABILITY_DENIED", `missing capability: ${capability}`, "denied");
      }
    }

    const requireApproval = this.authority.require_approval ?? true;
    if (!requireApproval) return;
    if (typeof call.approval_ref !== "string" || !call.approval_ref) {
      throw new RuntimeExecutionError("APPROVAL_REQUIRED", "filesystem mutation requires an approval_ref", "denied");
    }
    if (!new Set(this.authority.approved_refs ?? []).has(call.approval_ref)) {
      throw new RuntimeExecutionError("APPROVAL_DENIED", "approval_ref is not authorized by the host", "denied");
    }
  }

  private assertLease(lease: Lease): void {
    try {
      this.leases.assertCurrent(lease);
    } catch {
      throw new RuntimeExecutionError("STALE_FENCING_TOKEN", "filesystem mutation lease is stale", "denied");
    }
  }

  private async prepare(call: ToolCall, boundary: WorkspaceBoundary): Promise<PreparedMutation> {
    if (call.tool.id === "fs.write") return this.prepareWrite(call, boundary);
    if (call.tool.id === "fs.patch") return this.preparePatch(call, boundary);
    if (call.tool.id === "fs.move") return this.prepareMove(call, boundary);
    throw new RuntimeExecutionError("P2A_TOOL_NOT_IMPLEMENTED", "unsupported filesystem mutation", "denied");
  }

  private async prepareWrite(call: ToolCall, boundary: WorkspaceBoundary): Promise<PreparedMutation> {
    const path = pathArg(call.arguments, "path");
    const content = utf8Bytes(call.arguments.content, "content");
    const before = await probeFile(boundary, path);
    assertExpected(before.state, parseExpected(call.expected_state, "expected_state"), "target");
    const post: FileState = {exists: true, sha256: sha256(content), bytes: content.byteLength};

    return {
      toolId: "fs.write",
      surfaces: [`fs/${before.relative}`],
      intent: {operation: "fs.write", path: before.relative, pre_state: before.state, post_state: post},
      output: {path: before.relative, pre_state: before.state, post_state: post},
      mutate: () => atomicWrite(before.target, content, this.fsOps),
      assertPreState: async () => {
        const current = await probeFile(boundary, path);
        if (!stateMatches(current.state, before.state)) {
          throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "target changed after intent receipt", "denied");
        }
      },
      reconcile: async () => {
        const current = await probeFile(boundary, path);
        if (stateMatches(current.state, post)) return "post";
        if (stateMatches(current.state, before.state)) return "pre";
        return "unknown";
      },
    };
  }

  private async preparePatch(call: ToolCall, boundary: WorkspaceBoundary): Promise<PreparedMutation> {
    const path = pathArg(call.arguments, "path");
    const before = await probeFile(boundary, path);
    if (!before.state.exists) throw new RuntimeExecutionError("PATH_NOT_FOUND", "fs.patch target does not exist", "denied");
    assertExpected(before.state, parseExpected(call.expected_state, "expected_state"), "target");

    const currentBytes = await readFile(before.target);
    if (sha256(currentBytes) !== before.state.sha256) {
      throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "target changed while preparing patch", "denied");
    }
    const source = new TextDecoder("utf-8", {fatal: true}).decode(currentBytes);
    const patched = exactReplacement(source, call.arguments.old_text, call.arguments.new_text, call.arguments.expected_replacements);
    const content = new TextEncoder().encode(patched);
    const post: FileState = {exists: true, sha256: sha256(content), bytes: content.byteLength};

    return {
      toolId: "fs.patch",
      surfaces: [`fs/${before.relative}`],
      intent: {operation: "fs.patch", path: before.relative, pre_state: before.state, post_state: post},
      output: {path: before.relative, pre_state: before.state, post_state: post},
      mutate: () => atomicWrite(before.target, content, this.fsOps),
      assertPreState: async () => {
        const current = await probeFile(boundary, path);
        if (!stateMatches(current.state, before.state)) {
          throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "target changed after intent receipt", "denied");
        }
      },
      reconcile: async () => {
        const current = await probeFile(boundary, path);
        if (stateMatches(current.state, post)) return "post";
        if (stateMatches(current.state, before.state)) return "pre";
        return "unknown";
      },
    };
  }

  private async prepareMove(call: ToolCall, boundary: WorkspaceBoundary): Promise<PreparedMutation> {
    const sourcePath = pathArg(call.arguments, "source");
    const destinationPath = pathArg(call.arguments, "destination");
    const source = await probeFile(boundary, sourcePath);
    const destination = await probeFile(boundary, destinationPath);
    if (source.target === destination.target) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", "source and destination must differ", "denied");
    }

    const rawExpected = call.expected_state;
    if (!rawExpected || typeof rawExpected !== "object" || Array.isArray(rawExpected)) {
      throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", "fs.move requires source and destination expected state", "denied");
    }
    const expected = rawExpected as Record<string, unknown>;
    assertExpected(source.state, parseExpected(expected.source, "expected_state.source"), "source");
    assertExpected(destination.state, parseExpected(expected.destination, "expected_state.destination"), "destination");
    if (!source.state.exists) throw new RuntimeExecutionError("PATH_NOT_FOUND", "fs.move source does not exist", "denied");
    if (destination.state.exists) throw new RuntimeExecutionError("DESTINATION_EXISTS", "fs.move destination must not exist", "denied");

    const sourcePost: FileState = {exists: false, sha256: null, bytes: 0};
    const destinationPost: FileState = {...source.state};

    return {
      toolId: "fs.move",
      surfaces: [`fs/${source.relative}`, `fs/${destination.relative}`],
      intent: {
        operation: "fs.move",
        source: source.relative,
        destination: destination.relative,
        pre_state: {source: source.state, destination: destination.state},
        post_state: {source: sourcePost, destination: destinationPost},
      },
      output: {
        source: source.relative,
        destination: destination.relative,
        pre_state: {source: source.state, destination: destination.state},
        post_state: {source: sourcePost, destination: destinationPost},
      },
      mutate: () => atomicMove(source.target, destination.target, this.fsOps),
      assertPreState: async () => {
        const currentSource = await probeFile(boundary, sourcePath);
        const currentDestination = await probeFile(boundary, destinationPath);
        if (!stateMatches(currentSource.state, source.state) || !stateMatches(currentDestination.state, destination.state)) {
          throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "move surfaces changed after intent receipt", "denied");
        }
      },
      reconcile: async () => {
        const currentSource = await probeFile(boundary, sourcePath);
        const currentDestination = await probeFile(boundary, destinationPath);
        const post = stateMatches(currentSource.state, sourcePost) && stateMatches(currentDestination.state, destinationPost);
        if (post) return "post";
        const pre = stateMatches(currentSource.state, source.state) && stateMatches(currentDestination.state, destination.state);
        if (pre) return "pre";
        return "unknown";
      },
    };
  }

  private finish(call: ToolCall, descriptor: ToolDescriptor, mutationResult: ToolResult, intent: Receipt): ExecutedMutation {
    const completion = createReceipt({
      schema: "resonarch.toolfabric.receipt/v1",
      receipt_id: `${call.call_id}:completion`,
      trace_id: call.trace_id,
      task_id: call.task_id,
      call_id: call.call_id,
      tool_id: descriptor.id,
      tool_version: descriptor.version,
      request_digest: canonicalDigest(call),
      result_digest: canonicalDigest(mutationResult),
      side_effect: descriptor.side_effect,
      status: mutationResult.status,
      previous_receipt_hash: intent.receipt_hash,
      artifact_refs: mutationResult.artifacts,
      phase: "completion",
      intent_receipt_hash: intent.receipt_hash,
    });
    this.receiptTails.set(call.task_id, completion.receipt_hash);
    return {result: mutationResult, receipts: [intent, completion]};
  }

  private finishWithoutIntent(call: ToolCall, descriptor: ToolDescriptor | undefined, mutationResult: ToolResult): ExecutedMutation {
    const previous = this.receiptTails.get(call.task_id) ?? this.initialReceiptHash;
    const completion = createReceipt({
      schema: "resonarch.toolfabric.receipt/v1",
      receipt_id: `${call.call_id}:completion`,
      trace_id: call.trace_id,
      task_id: call.task_id,
      call_id: call.call_id,
      tool_id: descriptor?.id ?? call.tool?.id ?? "unknown",
      tool_version: descriptor?.version ?? call.tool?.version ?? "unknown",
      request_digest: canonicalDigest(call),
      result_digest: canonicalDigest(mutationResult),
      side_effect: descriptor?.side_effect ?? "filesystem",
      status: mutationResult.status,
      previous_receipt_hash: previous,
      artifact_refs: mutationResult.artifacts,
      phase: "completion",
      intent_emitted: false,
    });
    this.receiptTails.set(call.task_id, completion.receipt_hash);
    return {result: mutationResult, receipts: [completion]};
  }
}
