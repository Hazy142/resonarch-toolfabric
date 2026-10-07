import {access, realpath} from "node:fs/promises";
import {constants} from "node:fs";
import {basename, delimiter, dirname, extname, join, resolve} from "node:path";
import {platform, arch} from "node:os";
import {canonicalDigest, canonicalJson, sha256} from "../contracts/canonical.js";
import type {ResultStatus, ToolDescriptor} from "../contracts/types.js";
import {ArtifactStore} from "../evidence/artifacts.js";
import {createReceipt, type Receipt} from "../evidence/receipt.js";
import {redact} from "../evidence/redact.js";
import {loadRegistry} from "../registry/load.js";
import {RuntimeExecutionError} from "./errors.js";
import {discoverInstructions, fsList, fsRead, fsReadMany, fsSearch, fsStat} from "./fsRead.js";
import {gitDiff, gitLog, gitStatus} from "./gitRead.js";
import type {ReadMemoryRecord} from "../context/retrieval.js";
import {ExactMemorySnapshot} from "./exactMemory.js";
import {codeDependencies, codeSymbols, contextPack, instructionsResolve, testDiscover} from "./localInspect.js";
import {
  isInlineTextContentType,
  NetworkReadBroker,
  type NetworkReadPolicy,
  type NetworkReadTransport,
} from "./networkRead.js";
import {
  claimClassify,
  codeAstQuery,
  codeDiagnostics,
  codeReferences,
  codeSearch,
  licenseInspect,
  policyCompile,
  providerHealth,
  receiptVerify,
  reportRender,
  researchBundle,
  sandboxBoundary,
  secretScan,
  sourceCompare,
  vulnerabilitySearch,
  webSearch,
} from "./readExtensions.js";
import {isWithinPath, WorkspaceBoundary} from "./workspace.js";

export interface ToolCall {
  schema: "resonarch.toolfabric.call/v1";
  call_id: string;
  task_id: string;
  trace_id: string;
  tool: {id: string; version: string};
  arguments: Record<string, unknown>;
  scope: {workspace_root: string; [key: string]: unknown};
  deadline: string;
  expected_state?: Record<string, unknown>;
  approval_ref?: unknown;
  idempotency_key?: unknown;
}

export interface ToolResult {
  schema: "resonarch.toolfabric.result/v1";
  call_id: string;
  status: ResultStatus;
  output: unknown;
  artifacts: string[];
  diagnostics: Array<Record<string, unknown>>;
  timing: {started_at: string; finished_at: string; duration_ms: number};
  error: null | {code: string; message: string};
}

export interface ExecutedReadCall {
  result: ToolResult;
  receipt: Receipt;
}

export interface ReadPlaneOptions {
  artifactRoot: string;
  registryRoot?: string;
  inlineOutputLimitBytes?: number;
  previousReceiptHash?: string;
  memoryRecords?: readonly ReadMemoryRecord[];
  networkReadPolicy?: NetworkReadPolicy;
  networkTransport?: NetworkReadTransport;
}

const IMPLEMENTED = new Set([
  "registry.list",
  "registry.describe",
  "capability.snapshot",
  "capability.resolve",
  "provider.list",
  "provider.health",
  "model.catalog",
  "model.route",
  "instructions.discover",
  "instructions.resolve",
  "policy.compile",
  "context.capture",
  "context.canonicalize",
  "context.budget",
  "context.pack",
  "context.diff",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.read_many",
  "fs.search",
  "process.output",
  "process.list",
  "env.snapshot",
  "command.which",
  "port.probe",
  "git.status",
  "git.diff",
  "git.log",
  "forge.repo",
  "ci.status",
  "ci.logs",
  "code.symbols",
  "code.search",
  "code.references",
  "code.dependencies",
  "code.ast_query",
  "code.diagnostics",
  "test.discover",
  "gate.evaluate",
  "web.search",
  "web.fetch",
  "docs.resolve",
  "package.resolve",
  "license.inspect",
  "vulnerability.search",
  "source.compare",
  "research.bundle",
  "task.decompose",
  "task.graph",
  "task.status",
  "task.handoff",
  "escalation.route",
  "memory.get",
  "memory.search_exact",
  "memory.search_semantic",
  "policy.check",
  "capability.request",
  "approval.request",
  "secret.scan",
  "network.authorize",
  "action.classify",
  "sandbox.boundary",
  "hash.compute",
  "manifest.create",
  "receipt.verify",
  "attestation.verify",
  "claim.classify",
  "json.validate",
  "schema.validate",
  "structured.diff",
  "artifact.fetch",
  "report.render"
]);

function deadlineBudget(deadline: string, defaultMs: number): number {
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) throw new RuntimeExecutionError("INVALID_DEADLINE", "deadline must be an ISO date", "denied");
  const remaining = parsed - Date.now();
  if (remaining <= 0) throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "call deadline has elapsed", "cancelled");
  return Math.max(1, Math.min(defaultMs, remaining));
}

function safeEnv(input: Record<string, unknown>): Record<string, unknown> {
  const defaults = ["CI", "PATH", "SHELL", "COMSPEC", "TERM"];
  const keys = input.keys === undefined ? defaults : input.keys;
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string") || keys.length > 64) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "env.snapshot keys must be a string[] of at most 64 items", "denied");
  }
  const variables = Object.fromEntries((keys as string[]).map(key => [key, process.env[key] ?? ""]));
  return redact({
    platform: platform(),
    arch: arch(),
    node: process.version,
    cwd: process.cwd(),
    variables,
  }) as Record<string, unknown>;
}

async function resolveProspectivePath(inputPath: string): Promise<string> {
  let current = resolve(inputPath);
  const tail: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact root cannot be resolved safely", "denied");
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact root has no resolvable ancestor", "denied");
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertArtifactStoreOutsideWorkspace(workspaceRoot: string, artifactRoot: string): Promise<void> {
  if (!artifactRoot || artifactRoot.includes("\0")) {
    throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact root is invalid", "denied");
  }
  const lexical = resolve(artifactRoot);
  if (isWithinPath(workspaceRoot, lexical)) {
    throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact root must be outside the workspace", "denied");
  }
  const prospective = await resolveProspectivePath(lexical);
  if (isWithinPath(workspaceRoot, prospective)) {
    throw new RuntimeExecutionError("ARTIFACT_STORE_SCOPE", "artifact root resolves inside the workspace", "denied");
  }
}

async function commandWhich(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof input.command !== "string" || !/^[A-Za-z0-9_.+-]+$/.test(input.command)) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "command.which requires a bare command name", "denied");
  }
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const pathext = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = extname(input.command).length > 0;
  for (const directory of pathEntries) {
    for (const suffix of hasExt ? [""] : pathext) {
      const candidate = join(directory.replace(/^"|"$/g, ""), input.command + suffix);
      try {
        await access(candidate, constants.X_OK);
        return {command: input.command, path: candidate};
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new RuntimeExecutionError("COMMAND_NOT_FOUND", `command not found: ${input.command}`);
}

export class ReadPlaneRuntime {
  readonly artifactStore: ArtifactStore;
  private readonly tools: Map<string, ToolDescriptor>;
  private readonly inlineOutputLimitBytes: number;
  private readonly initialReceiptHash: string;
  private readonly receiptTails = new Map<string, string>();
  private readonly memory: ExactMemorySnapshot;
  private readonly network: NetworkReadBroker;

  private constructor(registry: ToolDescriptor[], options: ReadPlaneOptions) {
    this.tools = new Map(registry.map(tool => [tool.id, tool]));
    this.artifactStore = new ArtifactStore(options.artifactRoot);
    this.inlineOutputLimitBytes = options.inlineOutputLimitBytes ?? 64 * 1024;
    if (!Number.isInteger(this.inlineOutputLimitBytes) || this.inlineOutputLimitBytes < 64) {
      throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", "inlineOutputLimitBytes must be an integer >= 64", "denied");
    }
    this.initialReceiptHash = options.previousReceiptHash ?? "sha256:GENESIS";
    this.memory = new ExactMemorySnapshot(options.memoryRecords ?? []);
    this.network = new NetworkReadBroker(options.networkReadPolicy, options.networkTransport);
  }

  static async create(options: ReadPlaneOptions): Promise<ReadPlaneRuntime> {
    return new ReadPlaneRuntime(await loadRegistry(options.registryRoot ?? "contracts/tools"), options);
  }

  async execute(call: ToolCall): Promise<ExecutedReadCall> {
    const started = new Date();
    let descriptor: ToolDescriptor | undefined;
    let result: ToolResult;
    try {
      if (call.schema !== "resonarch.toolfabric.call/v1") throw new RuntimeExecutionError("INVALID_CALL_SCHEMA", "invalid call schema", "denied");
      descriptor = this.tools.get(call.tool?.id);
      if (!descriptor) throw new RuntimeExecutionError("TOOL_NOT_FOUND", `unknown tool: ${call.tool?.id ?? ""}`, "denied");
      if (call.tool.version !== descriptor.version) throw new RuntimeExecutionError("TOOL_VERSION_MISMATCH", "tool version does not match registry", "denied");
      const timeoutMs = deadlineBudget(call.deadline, descriptor.default_timeout_ms);
      if (descriptor.side_effect !== "none") {
        throw new RuntimeExecutionError("P1_WRITE_FORBIDDEN", `${descriptor.id} is not permitted by the P1 read plane`, "denied");
      }
      if (!IMPLEMENTED.has(descriptor.id)) {
        throw new RuntimeExecutionError("P1_TOOL_NOT_IMPLEMENTED", `${descriptor.id} is not implemented in this P1 slice`);
      }

      const boundary = await WorkspaceBoundary.create(call.scope.workspace_root);
      await assertArtifactStoreOutsideWorkspace(boundary.root, this.artifactStore.root);
      const artifacts: string[] = [];
      let output: unknown;
      switch (descriptor.id) {
        case "registry.list":
          output = {tools: [...this.tools.values()]};
          break;
        case "registry.describe": {
          if (typeof call.arguments.id !== "string") throw new RuntimeExecutionError("INVALID_ARGUMENT", "registry.describe requires id", "denied");
          const tool = this.tools.get(call.arguments.id);
          if (!tool) throw new RuntimeExecutionError("TOOL_NOT_FOUND", `unknown tool: ${call.arguments.id}`);
          output = {tool};
          break;
        }
        case "instructions.discover":
          output = await discoverInstructions(boundary, call.arguments);
          break;
        case "instructions.resolve":
          output = instructionsResolve(call.arguments);
          break;
        case "context.pack":
          output = contextPack(call.arguments);
          break;
        case "memory.get":
          output = this.memory.get(call.arguments);
          break;
        case "memory.search_exact":
          output = this.memory.search(call.arguments);
          break;
        case "network.authorize":
          output = this.network.authorize(call.task_id, call.arguments);
          break;
        case "web.fetch": {
          const fetched = await this.network.fetch(call.task_id, call.arguments, timeoutMs);
          const artifactRef = await this.artifactStore.put(fetched.body);
          artifacts.push(artifactRef);
          const digest = sha256(fetched.body);
          if (artifactRef !== "artifact://" + digest) {
            throw new RuntimeExecutionError("ARTIFACT_DIGEST_MISMATCH", "network body artifact digest mismatch");
          }
          const source = {
            url: fetched.requested_url,
            final_url: fetched.final_url,
            status: fetched.status,
            content_type: fetched.content_type,
            etag: fetched.etag,
            last_modified: fetched.last_modified,
            redirect_location: fetched.redirect_location,
            retrieved_at: fetched.retrieved_at,
            bytes: fetched.body.byteLength,
            sha256: digest,
            artifact_ref: artifactRef,
          };
          const inlineText = isInlineTextContentType(fetched.content_type)
            && fetched.body.byteLength <= Math.min(this.inlineOutputLimitBytes, 64 * 1024)
            ? new TextDecoder().decode(fetched.body)
            : null;
          output = inlineText === null ? {source} : {source, text: inlineText};
          break;
        }
        case "report.render":
          output = reportRender(call.arguments);
          break;
        case "provider.health":
          output = providerHealth(call.arguments, this.network);
          break;
        case "web.search":
          output = webSearch(call.arguments, this.network);
          break;
        case "source.compare":
          output = sourceCompare(call.arguments);
          break;
        case "research.bundle":
          output = researchBundle(call.arguments);
          break;
        case "claim.classify":
          output = claimClassify(call.arguments);
          break;
        case "policy.compile":
          output = policyCompile(call.arguments);
          break;
        case "secret.scan":
          output = await secretScan(boundary, call.arguments);
          break;
        case "license.inspect":
          output = await licenseInspect(boundary, call.arguments);
          break;
        case "vulnerability.search":
          output = await vulnerabilitySearch(boundary, call.arguments);
          break;
        case "sandbox.boundary":
          output = sandboxBoundary(boundary);
          break;
        case "receipt.verify":
          output = receiptVerify(call.arguments);
          break;
        case "code.symbols":
          output = await codeSymbols(boundary, call.arguments);
          break;
        case "code.dependencies":
          output = await codeDependencies(boundary, call.arguments);
          break;
        case "code.ast_query":
          output = await codeAstQuery(boundary, call.arguments);
          break;
        case "code.diagnostics":
          output = await codeDiagnostics(boundary, call.arguments);
          break;
        case "code.references":
          output = await codeReferences(boundary, call.arguments);
          break;
        case "code.search":
          output = await codeSearch(boundary, call.arguments);
          break;
        case "test.discover":
          output = await testDiscover(boundary, call.arguments);
          break;
        case "fs.read":
          output = await fsRead(boundary, call.arguments);
          break;
        case "fs.read_many":
          output = await fsReadMany(boundary, call.arguments);
          break;
        case "fs.list":
          output = await fsList(boundary, call.arguments);
          break;
        case "fs.stat":
          output = await fsStat(boundary, call.arguments);
          break;
        case "fs.search":
          output = await fsSearch(boundary, call.arguments);
          break;
        case "git.status": {
          const cwd = await boundary.resolveExisting(typeof call.arguments.path === "string" ? call.arguments.path : ".");
          output = await gitStatus(cwd, boundary.root, timeoutMs);
          break;
        }
        case "git.log": {
          const cwd = await boundary.resolveExisting(typeof call.arguments.path === "string" ? call.arguments.path : ".");
          output = await gitLog(cwd, boundary.root, call.arguments, timeoutMs);
          break;
        }
        case "git.diff": {
          const cwd = await boundary.resolveExisting(typeof call.arguments.path === "string" ? call.arguments.path : ".");
          output = await gitDiff(cwd, boundary.root, call.arguments, timeoutMs);
          break;
        }
        case "env.snapshot":
          output = safeEnv(call.arguments);
          break;
        case "command.which":
          output = await commandWhich(call.arguments);
          break;
        default:
          throw new RuntimeExecutionError("UNSUPPORTED", `${descriptor.id} is declared but its executor is unsupported or incomplete in this environment`);
      }

      const canonicalBytes = new TextEncoder().encode(canonicalJson(output));
      const limit = Math.min(this.inlineOutputLimitBytes, descriptor.max_output_bytes);
      if (canonicalBytes.byteLength > limit) {
        artifacts.push(await this.artifactStore.put(canonicalBytes));
        output = {artifactized: true, bytes: canonicalBytes.byteLength};
      }
      result = this.makeResult(call.call_id, "succeeded", output, artifacts, null, started);
    } catch (error) {
      const known = error instanceof RuntimeExecutionError
        ? error
        : new RuntimeExecutionError("EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
      result = this.makeResult(call.call_id, known.status, null, [], {code: known.code, message: known.message}, started);
    }

    const previousReceiptHash = this.receiptTails.get(call.task_id) ?? this.initialReceiptHash;
    const receipt = createReceipt({
      schema: "resonarch.toolfabric.receipt/v1",
      receipt_id: `${call.call_id}:receipt`,
      trace_id: call.trace_id,
      task_id: call.task_id,
      call_id: call.call_id,
      tool_id: call.tool?.id ?? "unknown",
      tool_version: descriptor?.version ?? call.tool?.version ?? "unknown",
      request_digest: canonicalDigest(call),
      result_digest: canonicalDigest(result),
      side_effect: descriptor?.side_effect ?? "none",
      status: result.status,
      previous_receipt_hash: previousReceiptHash,
      artifact_refs: result.artifacts,
    });
    this.receiptTails.set(call.task_id, receipt.receipt_hash);
    return {result, receipt};
  }

  private makeResult(
    callId: string,
    status: ResultStatus,
    output: unknown,
    artifacts: string[],
    error: ToolResult["error"],
    started: Date,
  ): ToolResult {
    const finished = new Date();
    return {
      schema: "resonarch.toolfabric.result/v1",
      call_id: callId,
      status,
      output,
      artifacts,
      diagnostics: [],
      timing: {
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        duration_ms: Math.max(0, finished.getTime() - started.getTime()),
      },
      error,
    };
  }
}
