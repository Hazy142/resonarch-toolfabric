import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {dirname} from "node:path";
import {RuntimeExecutionError} from "./errors.js";

const execFile = promisify(execFileCallback);

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `expected integer in range ${min}..${max}`, "denied");
  }
  return Number(value);
}

function safeGitEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  const blocked = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_CONFIG_COUNT",
  ];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (blocked.includes(upper) || upper.startsWith("GIT_CONFIG_KEY_") || upper.startsWith("GIT_CONFIG_VALUE_")) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_CEILING_DIRECTORIES = dirname(workspaceRoot);
  return env;
}

async function git(cwd: string, workspaceRoot: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const {stdout} = await execFile("git", [
      "-c", "core.quotepath=false",
      "-c", "core.fsmonitor=false",
      ...args,
    ], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: safeGitEnvironment(workspaceRoot),
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {stderr?: string; killed?: boolean};
    if (err.killed || err.code === "ETIMEDOUT") throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "git command exceeded deadline", "cancelled");
    throw new RuntimeExecutionError("GIT_COMMAND_FAILED", (err.stderr || err.message || "git command failed").trim());
  }
}

export async function gitStatus(cwd: string, workspaceRoot: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const raw = await git(cwd, workspaceRoot, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], timeoutMs);
  const records = raw.split("\0").filter(Boolean);
  const branchRecord = records[0]?.startsWith("## ") ? records.shift() : undefined;
  return {branch: branchRecord?.slice(3) ?? null, clean: records.length === 0, entries: records};
}

export async function gitLog(cwd: string, workspaceRoot: string, input: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const limit = integer(input.limit, 20, 1, 200);
  const raw = await git(cwd, workspaceRoot, ["log", "-n", String(limit), "--format=%H%n%P%n%an%n%aI%n%s%x00"], timeoutMs);
  const commits = raw.split("\0").filter(record => record.trim().length > 0).map(record => {
    const lines = record.replace(/^\r?\n/, "").split(/\r?\n/);
    const [sha, parents, author, authored_at, ...subjectParts] = lines;
    return {sha, parents: (parents ?? "").split(" ").filter(Boolean), author, authored_at, subject: subjectParts.join("\n")};
  });
  return {commits};
}

export async function gitDiff(cwd: string, workspaceRoot: string, input: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  if (input.staged === true) args.push("--cached");
  if (input.revision !== undefined) {
    if (
      typeof input.revision !== "string" ||
      input.revision.includes("\0") ||
      input.revision.startsWith("-")
    ) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", "revision must be a non-option string", "denied");
    }
    args.push(input.revision);
  }
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.some(path => typeof path !== "string" || path.includes("\0"))) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", "paths must be string[]", "denied");
    }
    args.push("--", ...(input.paths as string[]));
  }
  return {diff: await git(cwd, workspaceRoot, args, timeoutMs)};
}
