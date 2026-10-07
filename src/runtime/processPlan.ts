import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {lstat, realpath, stat} from "node:fs/promises";
import {extname, isAbsolute} from "node:path";
import {canonicalDigest} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";
import {WorkspaceBoundary} from "./workspace.js";
import {resolveRepository} from "./gitMutation.js";

export interface HostProcessPlanInput {
  id: string;
  workspace_root: string;
  cwd: string;
  executable: string;
  argv: readonly string[];
  input_paths: readonly string[];
  environment?: Readonly<Record<string, string>>;
  grant: "host-user";
  purpose: "command" | "test";
  allow_input?: boolean;
  max_runtime_ms?: number;
  max_output_bytes?: number;
  repo_path?: string;
  expected_head?: string;
}

export interface BoundProcessPlan {
  readonly id: string;
  readonly workspace_root: string;
  readonly cwd: string;
  readonly cwd_absolute: string;
  readonly executable: string;
  readonly executable_digest: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly input_files: readonly {path: string; canonical_path: string; digest: string}[];
  readonly grant: "host-user";
  readonly purpose: "command" | "test";
  readonly allow_input: boolean;
  readonly max_runtime_ms: number;
  readonly max_output_bytes: number;
  readonly repository: {path: string; head: string} | null;
  readonly digest: string;
}

export async function processFileDigest(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) {
    throw new RuntimeExecutionError("INVALID_PROCESS_FILE", "bound process files must be regular files <=512 MiB", "denied");
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return "sha256:" + hash.digest("hex");
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new RuntimeExecutionError("INVALID_PROCESS_LIMIT", "process limit is outside the supported bounds", "denied");
  }
  return selected;
}

// Host API only. No canonical tool can register or widen a plan/grant.
export async function bindProcessPlan(input: HostProcessPlanInput): Promise<BoundProcessPlan> {
  if (input.grant !== "host-user") throw new RuntimeExecutionError("HOST_EXECUTION_GRANT_REQUIRED", "host-user execution must be explicitly granted by the host", "denied");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(input.id) || !["command", "test"].includes(input.purpose)) {
    throw new RuntimeExecutionError("INVALID_PROCESS_PLAN", "invalid host plan identity or purpose", "denied");
  }
  if (typeof input.executable !== "string" || !isAbsolute(input.executable) || input.executable.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_EXECUTABLE", "host executable must be an absolute path", "denied");
  }
  if (!Array.isArray(input.argv) || input.argv.length > 256 || input.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || Buffer.byteLength(input.argv.join("\0")) > 32 * 1024) {
    throw new RuntimeExecutionError("INVALID_PROCESS_ARGUMENTS", "host argv must be <=256 NUL-free strings and <=32 KiB", "denied");
  }
  if (!Array.isArray(input.input_paths) || input.input_paths.length > 256 || input.input_paths.some(path => typeof path !== "string")) {
    throw new RuntimeExecutionError("INVALID_PROCESS_INPUTS", "host input_paths must be <=256 workspace-relative paths", "denied");
  }
  const boundary = await WorkspaceBoundary.create(input.workspace_root);
  const cwd = await boundary.resolveExisting(input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new RuntimeExecutionError("INVALID_PROCESS_CWD", "cwd must be a directory", "denied");
  const executable = await realpath(input.executable);
  if (process.platform === "win32" && extname(executable).toLowerCase() !== ".exe") {
    throw new RuntimeExecutionError("INVALID_EXECUTABLE", "Windows requires a real executable; shell scripts need an explicit host-owned interpreter plan", "denied");
  }
  const environment: Record<string, string> = {};
  if (process.platform === "win32") environment.SystemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const entries = Object.entries(input.environment ?? {});
  if (entries.length > 64) throw new RuntimeExecutionError("INVALID_PROCESS_ENV", "host environment is limited to 64 entries", "denied");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 8192) {
      throw new RuntimeExecutionError("INVALID_PROCESS_ENV", "invalid host environment", "denied");
    }
    environment[key] = value;
  }
  const files = [];
  for (const path of input.input_paths) {
    const canonical = await boundary.resolveExisting(path);
    if ((await lstat(canonical)).isSymbolicLink()) throw new RuntimeExecutionError("INVALID_PROCESS_INPUT", "process input must be a regular file", "denied");
    files.push(Object.freeze({path, canonical_path: canonical, digest: await processFileDigest(canonical)}));
  }
  let repository: BoundProcessPlan["repository"] = null;
  if (input.repo_path !== undefined || input.expected_head !== undefined) {
    const repo = await resolveRepository(boundary, input.repo_path, {workspaceRoot: boundary.root, deadline: new Date(Date.now() + 30_000).toISOString(), defaultTimeoutMs: 30_000});
    if (repo.head !== input.expected_head) throw new RuntimeExecutionError("PLAN_REPOSITORY_MISMATCH", "host expected HEAD does not match repository", "denied");
    repository = Object.freeze({path: input.repo_path!, head: repo.head});
  }
  const plan = {
    id: input.id, workspace_root: boundary.root, cwd: boundary.relative(cwd), cwd_absolute: cwd,
    executable, executable_digest: await processFileDigest(executable), argv: Object.freeze([...input.argv]),
    environment: Object.freeze(environment), input_files: Object.freeze(files), grant: "host-user" as const,
    purpose: input.purpose, allow_input: input.allow_input ?? false,
    max_runtime_ms: bounded(input.max_runtime_ms, 30_000, 100, 120_000),
    max_output_bytes: bounded(input.max_output_bytes, 64 * 1024, 1, 1024 * 1024), repository,
  };
  return Object.freeze({...plan, digest: canonicalDigest(plan)});
}

export async function verifyProcessPlan(plan: BoundProcessPlan, deadline: string): Promise<void> {
  const {digest, ...body} = plan;
  if (canonicalDigest(body) !== digest) throw new RuntimeExecutionError("PLAN_CONFIG_DRIFT", "host plan configuration changed", "denied");
  const boundary = await WorkspaceBoundary.create(plan.workspace_root);
  if (await boundary.resolveExisting(plan.cwd) !== plan.cwd_absolute) throw new RuntimeExecutionError("PLAN_CWD_DRIFT", "plan cwd changed", "denied");
  if (await realpath(plan.executable) !== plan.executable || await processFileDigest(plan.executable) !== plan.executable_digest) {
    throw new RuntimeExecutionError("PLAN_EXECUTABLE_DRIFT", "executable identity changed", "denied");
  }
  for (const file of plan.input_files) {
    if (await boundary.resolveExisting(file.path) !== file.canonical_path || await processFileDigest(file.canonical_path) !== file.digest) {
      throw new RuntimeExecutionError("PLAN_INPUT_DRIFT", "declared process input identity changed", "denied");
    }
  }
  if (plan.repository) {
    const repo = await resolveRepository(boundary, plan.repository.path, {workspaceRoot: boundary.root, deadline, defaultTimeoutMs: 30_000});
    if (repo.head !== plan.repository.head) throw new RuntimeExecutionError("PLAN_REPOSITORY_DRIFT", "repository HEAD changed", "denied");
  }
}
