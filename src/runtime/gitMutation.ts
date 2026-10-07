import {execFile as execFileCallback} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat, readFile, readlink, realpath, unlink} from "node:fs/promises";
import {isAbsolute, join, relative, resolve} from "node:path";
import {promisify} from "node:util";
import {canonicalDigest, sha256} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";
import {isWithinPath, WorkspaceBoundary} from "./workspace.js";

const execFile = promisify(execFileCallback);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitCommandContext {
  workspaceRoot: string;
  deadline: string;
  defaultTimeoutMs: number;
  identity?: GitIdentity;
}

export interface GitRepositoryState {
  root: string;
  git_dir: string;
  common_git_dir: string;
  linked_worktree: boolean;
  head: string;
  branch_ref: string | null;
  repository_digest: string;
}

export interface GitWorktreeRecord {
  path: string;
  head: string | null;
  branch_ref: string | null;
  bare: boolean;
  detached: boolean;
}

export interface SelectionSnapshot {
  digest: string;
  status_digest: string;
  diff_digest: string;
  untracked: Array<{path: string; sha256: string; bytes: number; kind: "file" | "symlink"}>;
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function normalizeFsPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = nullDevice();
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_LITERAL_PATHSPECS = "1";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.PAGER = "cat";
  return {...env, ...extra};
}

export function deadlineBudget(deadline: string, defaultTimeoutMs: number): number {
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) {
    throw new RuntimeExecutionError("INVALID_DEADLINE", "deadline must be an ISO date", "denied");
  }
  const remaining = parsed - Date.now();
  if (remaining <= 0) {
    throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "call deadline has elapsed", "cancelled");
  }
  return Math.max(1, Math.min(defaultTimeoutMs, remaining));
}

function baseGitArgs(identity?: GitIdentity): string[] {
  const args = [
    "-c", `core.hooksPath=${nullDevice()}`,
    "-c", "core.fsmonitor=false",
    "-c", "submodule.recurse=false",
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    "-c", "commit.gpgSign=false",
  ];
  if (identity) {
    args.push("-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`);
  }
  return args;
}

export async function runGit(
  cwd: string,
  context: GitCommandContext,
  args: string[],
  options: {allowExitCodes?: number[]; env?: NodeJS.ProcessEnv} = {},
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const timeout = deadlineBudget(context.deadline, context.defaultTimeoutMs);
  try {
    const {stdout, stderr} = await execFile("git", [...baseGitArgs(context.identity), ...args], {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: safeGitEnvironment(options.env),
    });
    return {stdout, stderr, exitCode: 0};
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {stderr?: string; stdout?: string; killed?: boolean; code?: string | number};
    if (err.killed || err.code === "ETIMEDOUT") {
      throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "git command exceeded deadline", "cancelled");
    }
    const numeric = typeof err.code === "number" ? err.code : Number.NaN;
    if (Number.isInteger(numeric) && options.allowExitCodes?.includes(numeric)) {
      return {stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: numeric};
    }
    throw new RuntimeExecutionError(
      "GIT_COMMAND_FAILED",
      (err.stderr || err.message || "git command failed").trim(),
    );
  }
}

export function validateOid(value: unknown, label: string): string {
  if (typeof value !== "string" || !OID.test(value)) {
    throw new RuntimeExecutionError("EXPECTED_STATE_REQUIRED", `${label} must be a full Git object id`, "denied");
  }
  return value;
}

export async function validateBranchName(repoRoot: string, context: GitCommandContext, value: unknown): Promise<string> {
  if (
    typeof value !== "string"
    || !SAFE_BRANCH.test(value)
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || value.endsWith(".lock")
    || value.endsWith("/")
    || value.endsWith(".")
  ) {
    throw new RuntimeExecutionError("INVALID_BRANCH_NAME", "branch name is outside the safe subset", "denied");
  }
  const checked = await runGit(repoRoot, context, ["check-ref-format", "--branch", value], {allowExitCodes: [1, 128]});
  if (checked.exitCode !== 0 || checked.stdout.trim() !== value) {
    throw new RuntimeExecutionError("INVALID_BRANCH_NAME", "git rejected the branch name", "denied");
  }
  return value;
}

export function validateGitIdentity(identity: GitIdentity | undefined): GitIdentity {
  if (!identity) throw new RuntimeExecutionError("GIT_IDENTITY_REQUIRED", "host-owned Git identity is required for commits", "denied");
  if (
    typeof identity.name !== "string"
    || identity.name.trim().length === 0
    || identity.name.length > 200
    || /[\0\r\n]/.test(identity.name)
    || typeof identity.email !== "string"
    || identity.email.length > 320
    || /[\0\r\n<>]/.test(identity.email)
    || !identity.email.includes("@")
  ) {
    throw new RuntimeExecutionError("INVALID_GIT_IDENTITY", "host-owned Git identity is invalid", "denied");
  }
  return identity;
}

export async function resolveRepository(
  boundary: WorkspaceBoundary,
  repoPath: unknown,
  context: GitCommandContext,
): Promise<GitRepositoryState> {
  const relativeRepo = repoPath === undefined ? "." : repoPath;
  if (typeof relativeRepo !== "string" || relativeRepo.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "repo_path must be a relative string", "denied");
  }
  const root = await boundary.resolveExisting(relativeRepo);
  const top = (await runGit(root, context, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const canonicalTop = await realpath(top).catch(() => "");
  if (!canonicalTop || normalizeFsPath(canonicalTop) !== normalizeFsPath(root)) {
    throw new RuntimeExecutionError("REPOSITORY_SCOPE_MISMATCH", "repo_path must resolve to the exact Git worktree root", "denied");
  }
  const bare = (await runGit(root, context, ["rev-parse", "--is-bare-repository"])).stdout.trim();
  if (bare !== "false") throw new RuntimeExecutionError("BARE_REPOSITORY_FORBIDDEN", "P2B requires a non-bare worktree", "denied");

  const head = (await runGit(root, context, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  if (!OID.test(head)) throw new RuntimeExecutionError("GIT_STATE_INVALID", "repository HEAD is not a full object id");
  const symbolic = await runGit(root, context, ["symbolic-ref", "-q", "HEAD"], {allowExitCodes: [1]});
  const gitDirRaw = (await runGit(root, context, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const commonRaw = (await runGit(root, context, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const gitDir = await realpath(gitDirRaw);
  const commonCandidate = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
  const commonGitDir = await realpath(commonCandidate);
  if (!isWithinPath(boundary.root, gitDir) || !isWithinPath(boundary.root, commonGitDir)) {
    throw new RuntimeExecutionError(
      "REPOSITORY_METADATA_ESCAPE",
      "Git metadata resolves outside the authorized workspace",
      "denied",
    );
  }
  return {
    root,
    git_dir: gitDir,
    common_git_dir: commonGitDir,
    linked_worktree: normalizeFsPath(gitDir) !== normalizeFsPath(commonGitDir),
    head,
    branch_ref: symbolic.exitCode === 0 ? symbolic.stdout.trim() : null,
    repository_digest: sha256(normalizeFsPath(commonGitDir)),
  };
}

export async function assertSafeRepositoryConfig(repo: GitRepositoryState, context: GitCommandContext): Promise<void> {
  const filters = await runGit(
    repo.root,
    context,
    ["config", "--includes", "--get-regexp", "^filter\..*\.(clean|smudge|process|required)$"],
    {allowExitCodes: [1]},
  );
  if (filters.exitCode === 0 && filters.stdout.trim().length > 0) {
    throw new RuntimeExecutionError(
      "UNSAFE_GIT_FILTER_CONFIG",
      "P2B refuses repositories with configured clean/smudge/process filters",
      "denied",
    );
  }
}

export async function readRef(
  repoRoot: string,
  context: GitCommandContext,
  ref: string,
): Promise<string | null> {
  const result = await runGit(repoRoot, context, ["rev-parse", "--verify", ref], {allowExitCodes: [128]});
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim();
  return OID.test(oid) ? oid : null;
}

export async function repositoryHead(repoRoot: string, context: GitCommandContext): Promise<string | null> {
  return readRef(repoRoot, context, "HEAD^{commit}");
}

export function safeRelativeGitPath(repoRoot: string, input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || isAbsolute(input)) {
    throw new RuntimeExecutionError("INVALID_PATH", "Git paths must be non-empty relative paths", "denied");
  }
  const target = resolve(repoRoot, input);
  if (!isWithinPath(repoRoot, target)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "Git path escapes repository", "denied");
  const rel = relative(repoRoot, target).replaceAll("\\", "/");
  if (rel === ".git" || rel.startsWith(".git/")) {
    throw new RuntimeExecutionError("GIT_METADATA_PATH_FORBIDDEN", "Git metadata cannot be selected as commit content", "denied");
  }
  return rel || ".";
}

export function validateCommitPaths(repoRoot: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "paths must contain 1..256 repository-relative entries", "denied");
  }
  const paths = value.map(item => safeRelativeGitPath(repoRoot, item));
  return [...new Set(paths)].sort();
}

export function validateCommitMessage(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > 8192
    || value.includes("\0")
  ) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "commit message must be a non-empty UTF-8 string of at most 8192 bytes", "denied");
  }
  return value;
}

function parseUntracked(status: string): string[] {
  const records = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (const record of records) {
    if (record.startsWith("?? ")) paths.push(record.slice(3));
  }
  return paths.sort();
}

export async function selectionSnapshot(
  repoRoot: string,
  context: GitCommandContext,
  paths: string[],
): Promise<SelectionSnapshot> {
  const status = (await runGit(
    repoRoot,
    context,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths],
  )).stdout;
  const diff = (await runGit(
    repoRoot,
    context,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...paths],
  )).stdout;

  const untracked: SelectionSnapshot["untracked"] = [];
  for (const path of parseUntracked(status)) {
    const safe = safeRelativeGitPath(repoRoot, path);
    const absolute = resolve(repoRoot, safe);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const bytes = Buffer.from(target, "utf8");
      untracked.push({path: safe, sha256: sha256(bytes), bytes: bytes.byteLength, kind: "symlink"});
    } else if (info.isFile()) {
      const bytes = await readFile(absolute);
      untracked.push({path: safe, sha256: sha256(bytes), bytes: bytes.byteLength, kind: "file"});
    }
  }

  const status_digest = sha256(status);
  const diff_digest = sha256(diff);
  return {
    digest: canonicalDigest({status_digest, diff_digest, untracked}),
    status_digest,
    diff_digest,
    untracked,
  };
}

export async function listWorktrees(
  repoRoot: string,
  context: GitCommandContext,
): Promise<GitWorktreeRecord[]> {
  const raw = (await runGit(repoRoot, context, ["worktree", "list", "--porcelain", "-z"])).stdout;
  const tokens = raw.split("\0").filter(token => token.length > 0);
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;
  for (const token of tokens) {
    if (token.startsWith("worktree ")) {
      if (current) records.push(current);
      current = {path: token.slice(9), head: null, branch_ref: null, bare: false, detached: false};
    } else if (current && token.startsWith("HEAD ")) {
      current.head = token.slice(5);
    } else if (current && token.startsWith("branch ")) {
      current.branch_ref = token.slice(7);
    } else if (current && token === "bare") {
      current.bare = true;
    } else if (current && token === "detached") {
      current.detached = true;
    }
  }
  if (current) records.push(current);
  return records;
}

export async function findWorktree(
  repoRoot: string,
  context: GitCommandContext,
  target: string,
): Promise<GitWorktreeRecord | null> {
  const normalized = normalizeFsPath(target);
  const records = await listWorktrees(repoRoot, context);
  return records.find(record => normalizeFsPath(record.path) === normalized) ?? null;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function zeroOid(oid: string): string {
  return "0".repeat(oid.length);
}

export async function createBranchRef(
  repo: GitRepositoryState,
  context: GitCommandContext,
  name: string,
  expectedHead: string,
): Promise<void> {
  await runGit(repo.root, context, ["update-ref", `refs/heads/${name}`, expectedHead, zeroOid(expectedHead)]);
}

export async function addWorktree(
  repo: GitRepositoryState,
  context: GitCommandContext,
  target: string,
  branch: string,
): Promise<void> {
  await runGit(repo.root, context, ["worktree", "add", "--quiet", target, branch]);
}

export async function createCommit(
  repo: GitRepositoryState,
  context: GitCommandContext,
  branchRef: string,
  expectedHead: string,
  paths: string[],
  message: string,
  onPrepared?: (value: {commit: string; tree: string}) => void,
): Promise<{commit: string; tree: string}> {
  validateGitIdentity(context.identity);
  const gitDir = (await runGit(repo.root, context, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const tempIndex = join(gitDir, `toolfabric-index-${randomUUID()}`);
  const indexEnv: NodeJS.ProcessEnv = {GIT_INDEX_FILE: tempIndex};
  try {
    await runGit(repo.root, context, ["read-tree", expectedHead], {env: indexEnv});
    await runGit(repo.root, context, ["add", "--all", "--", ...paths], {env: indexEnv});
    const tree = (await runGit(repo.root, context, ["write-tree"], {env: indexEnv})).stdout.trim();
    const parentTree = (await runGit(repo.root, context, ["rev-parse", `${expectedHead}^{tree}`])).stdout.trim();
    if (tree === parentTree) throw new RuntimeExecutionError("NOTHING_TO_COMMIT", "selected paths do not change the expected revision", "denied");

    const commit = (await runGit(
      repo.root,
      context,
      ["commit-tree", tree, "-p", expectedHead, "-m", message],
    )).stdout.trim();
    if (!OID.test(commit)) throw new RuntimeExecutionError("GIT_STATE_INVALID", "commit-tree returned an invalid object id");
    onPrepared?.({commit, tree});

    await runGit(repo.root, context, ["update-ref", branchRef, commit, expectedHead]);
    await runGit(repo.root, context, ["reset", "--quiet", commit, "--", ...paths]);
    return {commit, tree};
  } finally {
    await unlink(tempIndex).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function repairIndexToHead(
  repoRoot: string,
  context: GitCommandContext,
  head: string,
  paths: string[],
): Promise<void> {
  await runGit(repoRoot, context, ["reset", "--quiet", head, "--", ...paths]);
}

export function surfaceForRepo(repo: GitRepositoryState, suffix: string): string {
  return `git/${repo.repository_digest.slice("sha256:".length)}/${suffix}`;
}

export function relativeToWorkspace(boundary: WorkspaceBoundary, target: string): string {
  const rel = relative(boundary.root, target).replaceAll("\\", "/");
  if (rel === "" || rel === ".") return ".";
  if (rel === ".." || rel.startsWith("../") || rel.split("/").includes("..")) {
    throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "target escapes workspace", "denied");
  }
  return rel;
}
