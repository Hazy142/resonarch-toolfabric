import {resolve} from "node:path";
import {canonicalDigest} from "../contracts/canonical.js";
import type {ResultStatus, ToolDescriptor} from "../contracts/types.js";
import {createReceipt, type Receipt} from "../evidence/receipt.js";
import {LeaseBook} from "../orchestrator/leases.js";
import type {Lease} from "../orchestrator/types.js";
import {loadRegistry} from "../registry/load.js";
import {RuntimeExecutionError} from "./errors.js";
import {
  addWorktree,
  assertSafeRepositoryConfig,
  createBranchRef,
  createCommit,
  deadlineBudget,
  findWorktree,
  listWorktrees,
  pathExists,
  readRef,
  relativeToWorkspace,
  repairIndexToHead,
  repositoryHead,
  resolveRepository,
  runGit,
  safeRelativeGitPath,
  selectionSnapshot,
  surfaceForRepo,
  validateBranchName,
  validateCommitMessage,
  validateCommitPaths,
  validateGitIdentity,
  validateOid,
  type GitCommandContext,
  type GitIdentity,
  type GitRepositoryState,
  type SelectionSnapshot,
} from "./gitMutation.js";
import type {ToolCall, ToolResult} from "./readPlane.js";
import type {MutationAuthority} from "./writePlane.js";
import {WorkspaceBoundary, isWithinPath} from "./workspace.js";

export const GIT_ISOLATION_TOOL_IDS: ReadonlySet<string> = new Set(["git.branch", "git.worktree", "git.commit"]);
const P2B_TOOLS: ReadonlySet<string> = GIT_ISOLATION_TOOL_IDS;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface GitMutationHookContext {
  tool_id: string;
  surfaces: string[];
  leases: Lease[];
}

export interface GitIsolationOptions {
  authority: MutationAuthority;
  registry_root?: string;
  identity?: GitIdentity;
  worker_id?: string;
  lease_book?: LeaseBook;
  previous_receipt_hash?: string;
  before_mutation?: (context: GitMutationHookContext) => void | Promise<void>;
  after_mutation?: (context: GitMutationHookContext) => void | Promise<void>;
}

export interface ExecutedGitMutation {
  result: ToolResult;
  receipts: Receipt[];
}

interface PreparedGitMutation {
  surfaces: string[];
  intent: Record<string, unknown>;
  output(): Record<string, unknown>;
  assertPreState(): Promise<void>;
  mutate(): Promise<void>;
  reconcile(): Promise<"pre" | "post" | "unknown">;
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

function expectedObject(call: ToolCall): Record<string, unknown> {
  if (!call.expected_state || typeof call.expected_state !== "object" || Array.isArray(call.expected_state)) {
    throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", "Git mutations require expected_state", "denied");
  }
  return call.expected_state;
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `${key} must be a non-empty string without NUL bytes`, "denied");
  }
  return value;
}

function booleanExpected(value: unknown, label: string): true {
  if (value !== true) throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label} must be true`, "denied");
  return true;
}

export class GitIsolationRuntime {
  private readonly tools: Map<string, ToolDescriptor>;
  private readonly authority: MutationAuthority;
  private readonly identity?: GitIdentity;
  private readonly workerId: string;
  private readonly leases: LeaseBook;
  private readonly initialReceiptHash: string;
  private readonly receiptTails = new Map<string, string>();
  private readonly beforeMutation?: GitIsolationOptions["before_mutation"];
  private readonly afterMutation?: GitIsolationOptions["after_mutation"];

  private constructor(registry: ToolDescriptor[], options: GitIsolationOptions) {
    this.tools = new Map(registry.map(tool => [tool.id, tool]));
    this.authority = options.authority;
    this.identity = options.identity;
    this.workerId = options.worker_id ?? "toolfabric-git-isolation";
    this.leases = options.lease_book ?? new LeaseBook();
    this.initialReceiptHash = options.previous_receipt_hash ?? "sha256:GENESIS";
    this.beforeMutation = options.before_mutation;
    this.afterMutation = options.after_mutation;
  }

  static async create(options: GitIsolationOptions): Promise<GitIsolationRuntime> {
    return new GitIsolationRuntime(await loadRegistry(options.registry_root ?? "contracts/tools"), options);
  }

  async execute(call: ToolCall): Promise<ExecutedGitMutation> {
    const started = new Date();
    let descriptor: ToolDescriptor | undefined;
    let prepared: PreparedGitMutation | undefined;
    let intent: Receipt | undefined;
    let heldLeases: Lease[] = [];

    try {
      if (call.schema !== "resonarch.toolfabric.call/v1") {
        throw new RuntimeExecutionError("INVALID_CALL_SCHEMA", "invalid call schema", "denied");
      }
      descriptor = this.tools.get(call.tool?.id);
      if (!descriptor) throw new RuntimeExecutionError("TOOL_NOT_FOUND", "unknown tool", "denied");
      deadlineBudget(call.deadline, descriptor.default_timeout_ms);
      if (call.tool.version !== descriptor.version) {
        throw new RuntimeExecutionError("TOOL_VERSION_MISMATCH", "tool version does not match registry", "denied");
      }
      if (!P2B_TOOLS.has(descriptor.id)) {
        throw new RuntimeExecutionError("P2B_TOOL_NOT_IMPLEMENTED", `${descriptor.id} is outside the P2B Git isolation slice`, "denied");
      }
      if (descriptor.side_effect !== "repository") {
        throw new RuntimeExecutionError("CONTRACT_SIDE_EFFECT_MISMATCH", "P2B requires repository side effects", "denied");
      }
      this.assertAuthority(descriptor, call);

      const boundary = await WorkspaceBoundary.create(call.scope.workspace_root);
      const context: GitCommandContext = {
        workspaceRoot: boundary.root,
        deadline: call.deadline,
        defaultTimeoutMs: descriptor.default_timeout_ms,
        identity: this.identity,
      };
      prepared = await this.prepare(call, boundary, context);

      heldLeases = prepared.surfaces
        .slice()
        .sort()
        .map(surface => this.leases.claim(surface, this.workerId));

      const previous = this.receiptTails.get(call.task_id) ?? this.initialReceiptHash;
      intent = createReceipt({
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
        approval_ref: typeof call.approval_ref === "string" ? call.approval_ref : null,
      });

      if (this.beforeMutation) {
        await this.beforeMutation({tool_id: descriptor.id, surfaces: prepared.surfaces, leases: heldLeases});
      }
      deadlineBudget(call.deadline, descriptor.default_timeout_ms);
      for (const lease of heldLeases) this.assertLease(lease);
      await prepared.assertPreState();
      deadlineBudget(call.deadline, descriptor.default_timeout_ms);
      for (const lease of heldLeases) this.assertLease(lease);

      try {
        await prepared.mutate();
        if (this.afterMutation) {
          await this.afterMutation({tool_id: descriptor.id, surfaces: prepared.surfaces, leases: heldLeases});
        }
        const state = await prepared.reconcile();
        if (state !== "post") throw new Error("POST_STATE_MISMATCH");
        const succeeded = result(call.call_id, "succeeded", {...prepared.output(), reconciled: false}, null, started);
        return this.finish(call, descriptor, succeeded, intent);
      } catch (mutationError) {
        const state = await prepared.reconcile().catch(() => "unknown" as const);
        if (state === "post") {
          const succeeded = result(
            call.call_id,
            "succeeded",
            {...prepared.output(), reconciled: true},
            null,
            started,
            [{
              code: "RECONCILED_AFTER_MUTATION_ERROR",
              message: mutationError instanceof Error ? mutationError.message : String(mutationError),
            }],
          );
          return this.finish(call, descriptor, succeeded, intent);
        }
        if (state === "pre") {
          const known = mutationError instanceof RuntimeExecutionError
            ? mutationError
            : new RuntimeExecutionError(
                "GIT_MUTATION_FAILED",
                mutationError instanceof Error ? mutationError.message : String(mutationError),
              );
          const failed = result(call.call_id, known.status, null, {code: known.code, message: known.message}, started);
          return this.finish(call, descriptor, failed, intent);
        }
        const uncertain = result(
          call.call_id,
          "uncertain",
          null,
          {
            code: "GIT_MUTATION_OUTCOME_UNCERTAIN",
            message: mutationError instanceof Error ? mutationError.message : String(mutationError),
          },
          started,
        );
        return this.finish(call, descriptor, uncertain, intent);
      }
    } catch (error) {
      const known = error instanceof RuntimeExecutionError
        ? error
        : new RuntimeExecutionError("EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
      const failed = result(call.call_id, known.status, null, {code: known.code, message: known.message}, started);
      if (descriptor && intent) return this.finish(call, descriptor, failed, intent);
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
      throw new RuntimeExecutionError("APPROVAL_REQUIRED", "Git mutation requires an approval_ref", "denied");
    }
    if (!new Set(this.authority.approved_refs ?? []).has(call.approval_ref)) {
      throw new RuntimeExecutionError("APPROVAL_DENIED", "approval_ref is not authorized by the host", "denied");
    }
  }

  private assertLease(lease: Lease): void {
    try {
      this.leases.assertCurrent(lease);
    } catch {
      throw new RuntimeExecutionError("STALE_FENCING_TOKEN", "Git mutation lease is stale", "denied");
    }
  }

  private async prepare(
    call: ToolCall,
    boundary: WorkspaceBoundary,
    context: GitCommandContext,
  ): Promise<PreparedGitMutation> {
    if (call.tool.id === "git.branch") return this.prepareBranch(call, boundary, context);
    if (call.tool.id === "git.worktree") return this.prepareWorktree(call, boundary, context);
    if (call.tool.id === "git.commit") return this.prepareCommit(call, boundary, context);
    throw new RuntimeExecutionError("P2B_TOOL_NOT_IMPLEMENTED", "unsupported Git mutation", "denied");
  }

  private async prepareBranch(
    call: ToolCall,
    boundary: WorkspaceBoundary,
    context: GitCommandContext,
  ): Promise<PreparedGitMutation> {
    const repo = await resolveRepository(boundary, call.arguments.repo_path, context);
    const expected = expectedObject(call);
    const expectedHead = validateOid(expected.head, "expected_state.head");
    booleanExpected(expected.branch_absent, "expected_state.branch_absent");
    if (repo.head !== expectedHead) {
      throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "repository HEAD differs from expected_state.head", "denied");
    }
    const name = await validateBranchName(repo.root, context, call.arguments.name);
    const branchRef = `refs/heads/${name}`;
    if (await readRef(repo.root, context, branchRef)) {
      throw new RuntimeExecutionError("BRANCH_ALREADY_EXISTS", "target branch already exists", "denied");
    }

    const surfaces = [surfaceForRepo(repo, `ref/${branchRef}`)];
    return {
      surfaces,
      intent: {
        operation: "git.branch",
        repo: relativeToWorkspace(boundary, repo.root),
        branch_ref: branchRef,
        pre_state: {head: repo.head, branch: null},
        post_state: {head: repo.head, branch: expectedHead},
      },
      output: () => ({
        repo: relativeToWorkspace(boundary, repo.root),
        branch: name,
        branch_ref: branchRef,
        head: expectedHead,
      }),
      assertPreState: async () => {
        const currentHead = await repositoryHead(repo.root, context);
        const branch = await readRef(repo.root, context, branchRef);
        if (currentHead !== expectedHead || branch !== null) {
          throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "branch creation pre-state changed after intent", "denied");
        }
      },
      mutate: () => createBranchRef(repo, context, name, expectedHead),
      reconcile: async () => {
        const branch = await readRef(repo.root, context, branchRef);
        if (branch === expectedHead) return "post";
        const currentHead = await repositoryHead(repo.root, context);
        if (branch === null && currentHead === expectedHead) return "pre";
        return "unknown";
      },
    };
  }

  private async prepareWorktree(
    call: ToolCall,
    boundary: WorkspaceBoundary,
    context: GitCommandContext,
  ): Promise<PreparedGitMutation> {
    const repo = await resolveRepository(boundary, call.arguments.repo_path, context);
    await assertSafeRepositoryConfig(repo, context);
    const branch = await validateBranchName(repo.root, context, call.arguments.branch);
    const branchRef = `refs/heads/${branch}`;
    const expected = expectedObject(call);
    const expectedHead = validateOid(expected.branch_head, "expected_state.branch_head");
    booleanExpected(expected.target_absent, "expected_state.target_absent");

    const actualBranchHead = await readRef(repo.root, context, branchRef);
    if (actualBranchHead !== expectedHead) {
      throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "branch head differs from expected_state.branch_head", "denied");
    }

    const targetInput = stringArg(call.arguments, "path");
    const target = await boundary.resolveProspective(targetInput);
    if (isWithinPath(repo.root, target)) {
      throw new RuntimeExecutionError(
        "WORKTREE_TARGET_INSIDE_REPOSITORY",
        "linked worktrees must be isolated outside the source worktree",
        "denied",
      );
    }
    if (await pathExists(target)) {
      throw new RuntimeExecutionError("WORKTREE_TARGET_EXISTS", "worktree target already exists", "denied");
    }
    if (await findWorktree(repo.root, context, target)) {
      throw new RuntimeExecutionError("WORKTREE_ALREADY_REGISTERED", "worktree target is already registered", "denied");
    }
    const attached = await listWorktrees(repo.root, context);
    if (attached.some(record => record.branch_ref === branchRef)) {
      throw new RuntimeExecutionError("BRANCH_ALREADY_CHECKED_OUT", "branch is already checked out in another worktree", "denied");
    }

    const targetRelative = relativeToWorkspace(boundary, target);
    const surfaces = [
      surfaceForRepo(repo, `ref/${branchRef}`),
      surfaceForRepo(repo, `worktree/${targetRelative}`),
    ];
    return {
      surfaces,
      intent: {
        operation: "git.worktree",
        repo: relativeToWorkspace(boundary, repo.root),
        branch_ref: branchRef,
        target: targetRelative,
        pre_state: {branch_head: expectedHead, target_exists: false},
        post_state: {branch_head: expectedHead, target_exists: true},
      },
      output: () => ({
        repo: relativeToWorkspace(boundary, repo.root),
        branch,
        branch_ref: branchRef,
        path: targetRelative,
        head: expectedHead,
      }),
      assertPreState: async () => {
        await assertSafeRepositoryConfig(repo, context);
        const head = await readRef(repo.root, context, branchRef);
        const record = await findWorktree(repo.root, context, target);
        if (head !== expectedHead || record !== null || await pathExists(target)) {
          throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "worktree pre-state changed after intent", "denied");
        }
      },
      mutate: () => addWorktree(repo, context, target, branch),
      reconcile: async () => {
        const record = await findWorktree(repo.root, context, target);
        if (
          record
          && record.head === expectedHead
          && record.branch_ref === branchRef
          && await pathExists(target)
        ) {
          return "post";
        }
        if (!record && !(await pathExists(target)) && await readRef(repo.root, context, branchRef) === expectedHead) {
          return "pre";
        }
        return "unknown";
      },
    };
  }

  private async prepareCommit(
    call: ToolCall,
    boundary: WorkspaceBoundary,
    context: GitCommandContext,
  ): Promise<PreparedGitMutation> {
    validateGitIdentity(this.identity);
    const repo = await resolveRepository(boundary, call.arguments.repo_path, context);
    await assertSafeRepositoryConfig(repo, context);
    if (!repo.linked_worktree) {
      throw new RuntimeExecutionError(
        "PRIMARY_WORKTREE_COMMIT_FORBIDDEN",
        "git.commit is restricted to an isolated linked worktree in P2B",
        "denied",
      );
    }
    if (!repo.branch_ref) {
      throw new RuntimeExecutionError("DETACHED_HEAD_FORBIDDEN", "git.commit requires a symbolic local branch", "denied");
    }

    const expected = expectedObject(call);
    const expectedHead = validateOid(expected.head, "expected_state.head");
    if (repo.head !== expectedHead) {
      throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "worktree HEAD differs from expected_state.head", "denied");
    }

    const paths = validateCommitPaths(repo.root, call.arguments.paths);
    const message = validateCommitMessage(call.arguments.message);
    const snapshot = await selectionSnapshot(repo.root, context, paths);
    if (expected.selection_digest !== undefined) {
      if (typeof expected.selection_digest !== "string" || !SHA256.test(expected.selection_digest)) {
        throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", "expected_state.selection_digest must be sha256:<64 hex>", "denied");
      }
      if (expected.selection_digest !== snapshot.digest) {
        throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "selected worktree state differs from expected digest", "denied");
      }
    }

    let committed: {commit: string; tree: string} | null = null;
    const pathSurfaces = paths.map(path => {
      const absolute = resolve(repo.root, safeRelativeGitPath(repo.root, path));
      return `fs/${relativeToWorkspace(boundary, absolute)}`;
    });
    const surfaces = [
      surfaceForRepo(repo, `ref/${repo.branch_ref}`),
      surfaceForRepo(repo, `index/${relativeToWorkspace(boundary, repo.root)}`),
      ...pathSurfaces,
    ];

    const assertSnapshot = async (): Promise<SelectionSnapshot> => {
      await assertSafeRepositoryConfig(repo, context);
      const head = await repositoryHead(repo.root, context);
      const branch = (await runGit(repo.root, context, ["symbolic-ref", "-q", "HEAD"], {allowExitCodes: [1]}));
      const now = await selectionSnapshot(repo.root, context, paths);
      if (head !== expectedHead || branch.exitCode !== 0 || branch.stdout.trim() !== repo.branch_ref || now.digest !== snapshot.digest) {
        throw new RuntimeExecutionError("EXPECTED_STATE_DRIFT", "commit pre-state changed after intent", "denied");
      }
      return now;
    };

    return {
      surfaces,
      intent: {
        operation: "git.commit",
        repo: relativeToWorkspace(boundary, repo.root),
        branch_ref: repo.branch_ref,
        paths,
        message_digest: canonicalDigest(message),
        pre_state: {
          head: expectedHead,
          selection_digest: snapshot.digest,
          status_digest: snapshot.status_digest,
          diff_digest: snapshot.diff_digest,
        },
      },
      output: () => ({
        repo: relativeToWorkspace(boundary, repo.root),
        branch_ref: repo.branch_ref,
        previous_head: expectedHead,
        commit: committed?.commit ?? null,
        tree: committed?.tree ?? null,
        paths,
        selection_digest: snapshot.digest,
      }),
      assertPreState: async () => {
        await assertSnapshot();
      },
      mutate: async () => {
        committed = await createCommit(
          repo,
          context,
          repo.branch_ref!,
          expectedHead,
          paths,
          message,
          prepared => { committed = prepared; },
        );
      },
      reconcile: async () => {
        const current = await readRef(repo.root, context, repo.branch_ref!);
        if (committed && current === committed.commit) {
          await repairIndexToHead(repo.root, context, committed.commit, paths);
          return "post";
        }
        if (current === expectedHead) {
          try {
            const now = await selectionSnapshot(repo.root, context, paths);
            if (now.digest === snapshot.digest) return "pre";
          } catch {
            return "unknown";
          }
        }
        return "unknown";
      },
    };
  }

  private finish(
    call: ToolCall,
    descriptor: ToolDescriptor,
    mutationResult: ToolResult,
    intent: Receipt,
  ): ExecutedGitMutation {
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
      approval_ref: typeof call.approval_ref === "string" ? call.approval_ref : null,
    });
    this.receiptTails.set(call.task_id, completion.receipt_hash);
    return {result: mutationResult, receipts: [intent, completion]};
  }

  private finishWithoutIntent(
    call: ToolCall,
    descriptor: ToolDescriptor | undefined,
    mutationResult: ToolResult,
  ): ExecutedGitMutation {
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
      side_effect: descriptor?.side_effect ?? "repository",
      status: mutationResult.status,
      previous_receipt_hash: previous,
      artifact_refs: mutationResult.artifacts,
      phase: "completion",
      intent_emitted: false,
      approval_ref: typeof call.approval_ref === "string" ? call.approval_ref : null,
    });
    this.receiptTails.set(call.task_id, completion.receipt_hash);
    return {result: mutationResult, receipts: [completion]};
  }
}
