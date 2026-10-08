import {randomUUID} from "node:crypto";
import type {ToolDescriptor} from "../contracts/types.js";
import type {Receipt} from "../evidence/receipt.js";
import {loadRegistry} from "../registry/load.js";
import {GitIsolationRuntime, GIT_ISOLATION_TOOL_IDS} from "../runtime/gitIsolation.js";
import type {GitIdentity} from "../runtime/gitMutation.js";
import {ProcessLifecycleRuntime, PROCESS_LIFECYCLE_TOOL_IDS} from "../runtime/processLifecycle.js";
import type {BoundProcessPlan} from "../runtime/processPlan.js";
import {ReadPlaneRuntime, READ_PLANE_TOOL_IDS, type ToolCall, type ToolResult} from "../runtime/readPlane.js";
import {WritePlaneRuntime, WRITE_PLANE_TOOL_IDS, type MutationAuthority} from "../runtime/writePlane.js";
import {RuntimeExecutionError} from "../runtime/errors.js";

export interface ToolFabricMcpOptions {
  workspace_root: string;
  artifact_root: string;
  registry_root?: string;
  authority: MutationAuthority;
  allow_tools?: readonly string[];
  git_identity?: GitIdentity;
  process_plans?: readonly BoundProcessPlan[];
  windows_process_host_path?: string;
}

export interface McpCallMetadata {
  task_id?: string;
  trace_id?: string;
  expected_state?: Record<string, unknown>;
  approval_ref?: string;
  idempotency_key?: string;
  deadline_ms?: number;
}

export interface McpExecution {
  result: ToolResult;
  receipts: Receipt[];
}

const IMPLEMENTED_TOOL_IDS: ReadonlySet<string> = new Set([
  ...READ_PLANE_TOOL_IDS,
  ...WRITE_PLANE_TOOL_IDS,
  ...GIT_ISOLATION_TOOL_IDS,
  ...PROCESS_LIFECYCLE_TOOL_IDS,
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validIdentity(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_MCP_METADATA", `${label} must be a non-empty NUL-free string <=128 chars`, "denied");
  }
  return value;
}

export function splitMcpArguments(input: unknown): {arguments: Record<string, unknown>; metadata: McpCallMetadata} {
  if (!plainRecord(input)) throw new RuntimeExecutionError("INVALID_MCP_ARGUMENTS", "tool arguments must be an object", "denied");
  const args = structuredClone(input);
  const rawMeta = args._toolfabric;
  delete args._toolfabric;
  if (rawMeta === undefined) return {arguments: args, metadata: {}};
  if (!plainRecord(rawMeta)) throw new RuntimeExecutionError("INVALID_MCP_METADATA", "_toolfabric must be an object", "denied");
  const allowed = new Set(["task_id", "trace_id", "expected_state", "approval_ref", "idempotency_key", "deadline_ms"]);
  if (Object.keys(rawMeta).some(key => !allowed.has(key))) {
    throw new RuntimeExecutionError("INVALID_MCP_METADATA", "unknown _toolfabric metadata field", "denied");
  }
  if (rawMeta.expected_state !== undefined && !plainRecord(rawMeta.expected_state)) {
    throw new RuntimeExecutionError("INVALID_MCP_METADATA", "expected_state must be an object", "denied");
  }
  if (rawMeta.deadline_ms !== undefined && (!Number.isInteger(rawMeta.deadline_ms) || Number(rawMeta.deadline_ms) < 1)) {
    throw new RuntimeExecutionError("INVALID_MCP_METADATA", "deadline_ms must be a positive integer", "denied");
  }
  return {
    arguments: args,
    metadata: {
      task_id: validIdentity(rawMeta.task_id, "task_id"),
      trace_id: validIdentity(rawMeta.trace_id, "trace_id"),
      approval_ref: validIdentity(rawMeta.approval_ref, "approval_ref"),
      idempotency_key: validIdentity(rawMeta.idempotency_key, "idempotency_key"),
      expected_state: rawMeta.expected_state as Record<string, unknown> | undefined,
      deadline_ms: rawMeta.deadline_ms as number | undefined,
    },
  };
}

export class ToolFabricMcpRuntime {
  private readonly tools: Map<string, ToolDescriptor>;
  private readonly allowed: Set<string> | null;
  private readonly capabilities: Set<string>;
  private readonly read: ReadPlaneRuntime | null;
  private readonly write: WritePlaneRuntime | null;
  private readonly git: GitIsolationRuntime | null;
  private readonly processRuntime: ProcessLifecycleRuntime | null;

  private constructor(
    private readonly options: ToolFabricMcpOptions,
    registry: ToolDescriptor[],
    runtimes: {
      read: ReadPlaneRuntime | null;
      write: WritePlaneRuntime | null;
      git: GitIsolationRuntime | null;
      processRuntime: ProcessLifecycleRuntime | null;
    },
  ) {
    this.tools = new Map(registry.map(tool => [tool.id, tool]));
    this.allowed = options.allow_tools ? new Set(options.allow_tools) : null;
    this.capabilities = new Set(options.authority.capabilities);
    this.read = runtimes.read;
    this.write = runtimes.write;
    this.git = runtimes.git;
    this.processRuntime = runtimes.processRuntime;
  }

  static async create(options: ToolFabricMcpOptions): Promise<ToolFabricMcpRuntime> {
    if (!options.authority || !Array.isArray(options.authority.capabilities)) {
      throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "authority.capabilities is required", "denied");
    }
    const registryRoot = options.registry_root ?? "contracts/tools";
    const registry = await loadRegistry(registryRoot);
    const allowed = options.allow_tools ? new Set(options.allow_tools) : null;
    const capabilities = new Set(options.authority.capabilities);
    const eligible = (tool: ToolDescriptor) =>
      IMPLEMENTED_TOOL_IDS.has(tool.id)
      && (!allowed || allowed.has(tool.id))
      && tool.capabilities.every(capability => capabilities.has(capability));

    const wantsRead = registry.some(tool => eligible(tool) && READ_PLANE_TOOL_IDS.has(tool.id));
    const wantsWrite = registry.some(tool => eligible(tool) && WRITE_PLANE_TOOL_IDS.has(tool.id));
    const wantsGit = registry.some(tool => eligible(tool) && GIT_ISOLATION_TOOL_IDS.has(tool.id));
    const wantsProcess = registry.some(tool => eligible(tool) && PROCESS_LIFECYCLE_TOOL_IDS.has(tool.id));

    const [read, write, git, processRuntime] = await Promise.all([
      wantsRead ? ReadPlaneRuntime.create({artifactRoot: options.artifact_root, registryRoot}) : Promise.resolve(null),
      wantsWrite ? WritePlaneRuntime.create({authority: options.authority, registry_root: registryRoot}) : Promise.resolve(null),
      wantsGit ? GitIsolationRuntime.create({
        authority: options.authority,
        registry_root: registryRoot,
        identity: options.git_identity,
      }) : Promise.resolve(null),
      wantsProcess ? ProcessLifecycleRuntime.create({
        workspace_root: options.workspace_root,
        artifact_root: options.artifact_root,
        registry_root: registryRoot,
        plans: options.process_plans ?? [],
        authority: options.authority,
        windows_host_path: options.windows_process_host_path,
      }) : Promise.resolve(null),
    ]);
    return new ToolFabricMcpRuntime(options, registry, {read, write, git, processRuntime});
  }

  listDescriptors(): ToolDescriptor[] {
    return [...this.tools.values()]
      .filter(tool => this.isExposed(tool))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  descriptor(id: string): ToolDescriptor | undefined {
    const tool = this.tools.get(id);
    return tool && this.isExposed(tool) ? tool : undefined;
  }

  private isExposed(tool: ToolDescriptor): boolean {
    if (!IMPLEMENTED_TOOL_IDS.has(tool.id)) return false;
    if (this.allowed && !this.allowed.has(tool.id)) return false;
    if (!tool.capabilities.every(capability => this.capabilities.has(capability))) return false;
    if (READ_PLANE_TOOL_IDS.has(tool.id)) return this.read !== null;
    if (WRITE_PLANE_TOOL_IDS.has(tool.id)) return this.write !== null;
    if (GIT_ISOLATION_TOOL_IDS.has(tool.id)) return this.git !== null;
    if (PROCESS_LIFECYCLE_TOOL_IDS.has(tool.id)) return this.processRuntime !== null;
    return false;
  }

  async execute(toolId: string, input: unknown): Promise<McpExecution> {
    const descriptor = this.descriptor(toolId);
    if (!descriptor) throw new RuntimeExecutionError("MCP_TOOL_DENIED", `tool is unsupported or not authorized: ${toolId}`, "denied");
    // Re-check authority at dispatch time; listing is not an authorization token.
    for (const capability of descriptor.capabilities) {
      if (!this.capabilities.has(capability)) throw new RuntimeExecutionError("CAPABILITY_DENIED", `missing capability: ${capability}`, "denied");
    }
    const {arguments: args, metadata} = splitMcpArguments(input);
    const budget = Math.min(metadata.deadline_ms ?? descriptor.default_timeout_ms, descriptor.default_timeout_ms);
    const taskId = metadata.task_id ?? randomUUID();
    const call: ToolCall = {
      schema: "resonarch.toolfabric.call/v1",
      call_id: randomUUID(),
      task_id: taskId,
      trace_id: metadata.trace_id ?? taskId,
      tool: {id: descriptor.id, version: descriptor.version},
      arguments: args,
      scope: {workspace_root: this.options.workspace_root},
      deadline: new Date(Date.now() + budget).toISOString(),
      ...(metadata.expected_state ? {expected_state: metadata.expected_state} : {}),
      ...(metadata.approval_ref ? {approval_ref: metadata.approval_ref} : {}),
      ...(metadata.idempotency_key ? {idempotency_key: metadata.idempotency_key} : {}),
    };

    if (READ_PLANE_TOOL_IDS.has(toolId) && this.read) {
      const executed = await this.read.execute(call);
      return {result: executed.result, receipts: [executed.receipt]};
    }
    if (WRITE_PLANE_TOOL_IDS.has(toolId) && this.write) return this.write.execute(call);
    if (GIT_ISOLATION_TOOL_IDS.has(toolId) && this.git) return this.git.execute(call);
    if (PROCESS_LIFECYCLE_TOOL_IDS.has(toolId) && this.processRuntime) return this.processRuntime.execute(call);
    throw new RuntimeExecutionError("MCP_TOOL_UNAVAILABLE", `runtime unavailable for ${toolId}`, "denied");
  }
}
