import {readFile} from "node:fs/promises";
import {dirname, isAbsolute, resolve} from "node:path";
import type {BoundProcessPlan} from "../runtime/processPlan.js";
import {RuntimeExecutionError} from "../runtime/errors.js";
import type {ToolFabricMcpOptions} from "./runtime.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", `${label} must be an object`, "denied");
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || item.includes("\0"))) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", `${label} must be a non-empty-string array`, "denied");
  }
  return [...new Set(value as string[])];
}

function pathValue(value: unknown, label: string, base: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", `${label} must be a path string`, "denied");
  }
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export async function loadMcpConfig(path: string): Promise<ToolFabricMcpOptions> {
  const absolute = resolve(path);
  const base = dirname(absolute);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new RuntimeExecutionError(
      "INVALID_MCP_CONFIG",
      `cannot read MCP config: ${error instanceof Error ? error.message : String(error)}`,
      "denied",
    );
  }
  const raw = record(parsed, "config");
  const known = new Set([
    "workspace_root",
    "artifact_root",
    "registry_root",
    "authority",
    "allow_tools",
    "git_identity",
    "process_plans",
    "windows_process_host_path",
  ]);
  if (Object.keys(raw).some(key => !known.has(key))) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "unknown MCP config field", "denied");
  }
  const authorityRaw = record(raw.authority, "authority");
  const authorityKnown = new Set(["capabilities", "approved_refs", "require_approval"]);
  if (Object.keys(authorityRaw).some(key => !authorityKnown.has(key))) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "unknown authority field", "denied");
  }
  const capabilities = stringArray(authorityRaw.capabilities, "authority.capabilities");
  const approvedRefs = authorityRaw.approved_refs === undefined
    ? []
    : stringArray(authorityRaw.approved_refs, "authority.approved_refs");
  if (authorityRaw.require_approval !== undefined && typeof authorityRaw.require_approval !== "boolean") {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "authority.require_approval must be boolean", "denied");
  }

  let gitIdentity: {name: string; email: string} | undefined;
  if (raw.git_identity !== undefined) {
    const identity = record(raw.git_identity, "git_identity");
    if (
      Object.keys(identity).some(key => !["name", "email"].includes(key))
      || typeof identity.name !== "string"
      || typeof identity.email !== "string"
      || !identity.name
      || !identity.email
    ) {
      throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "git_identity requires name and email", "denied");
    }
    gitIdentity = {name: identity.name, email: identity.email};
  }

  if (raw.process_plans !== undefined && !Array.isArray(raw.process_plans)) {
    throw new RuntimeExecutionError("INVALID_MCP_CONFIG", "process_plans must be an array", "denied");
  }

  return {
    workspace_root: pathValue(raw.workspace_root, "workspace_root", base),
    artifact_root: pathValue(raw.artifact_root, "artifact_root", base),
    ...(raw.registry_root === undefined ? {} : {registry_root: pathValue(raw.registry_root, "registry_root", base)}),
    authority: {
      capabilities,
      approved_refs: approvedRefs,
      require_approval: authorityRaw.require_approval ?? true,
    },
    ...(raw.allow_tools === undefined ? {} : {allow_tools: stringArray(raw.allow_tools, "allow_tools")}),
    ...(gitIdentity ? {git_identity: gitIdentity} : {}),
    process_plans: (raw.process_plans ?? []) as BoundProcessPlan[],
    ...(raw.windows_process_host_path === undefined
      ? {}
      : {windows_process_host_path: pathValue(raw.windows_process_host_path, "windows_process_host_path", base)}),
  };
}
