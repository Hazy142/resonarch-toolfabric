import {lstat, readFile, readdir, stat} from "node:fs/promises";
import {dirname, join} from "node:path";
import {sha256} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";
import {WorkspaceBoundary} from "./workspace.js";

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `expected integer in range ${min}..${max}`, "denied");
  }
  return Number(value);
}

function pathArgument(input: Record<string, unknown>, fallback = "."): string {
  if (input.path === undefined) return fallback;
  if (typeof input.path !== "string") throw new RuntimeExecutionError("INVALID_ARGUMENT", "path must be a string", "denied");
  return input.path;
}

export async function fsRead(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const path = pathArgument(input);
  const target = await boundary.resolveExisting(path);
  const info = await stat(target);
  if (!info.isFile()) throw new RuntimeExecutionError("NOT_A_FILE", "fs.read target is not a regular file");
  const maxBytes = integer(input.max_bytes, DEFAULT_MAX_FILE_BYTES, 1, 64 * 1024 * 1024);
  if (info.size > maxBytes) throw new RuntimeExecutionError("FILE_TOO_LARGE", `file exceeds max_bytes (${info.size} > ${maxBytes})`);
  const bytes = await readFile(target);
  return {
    path: boundary.relative(target),
    encoding: "utf8",
    bytes: bytes.byteLength,
    digest: sha256(bytes),
    content: bytes.toString("utf8"),
  };
}

export async function fsReadMany(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(input.paths) || input.paths.some(path => typeof path !== "string")) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "fs.read_many requires string[] paths", "denied");
  }
  if (input.paths.length > 128) throw new RuntimeExecutionError("INVALID_ARGUMENT", "fs.read_many accepts at most 128 paths", "denied");
  const files = [];
  for (const path of input.paths) files.push(await fsRead(boundary, {...input, path}));
  return {files};
}

export async function fsStat(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await boundary.resolveExisting(pathArgument(input));
  const info = await stat(target);
  return {
    path: boundary.relative(target),
    type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
    size: info.size,
    mode: info.mode,
    mtime: info.mtime.toISOString(),
  };
}

export async function fsList(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await boundary.resolveExisting(pathArgument(input));
  const info = await stat(target);
  if (!info.isDirectory()) throw new RuntimeExecutionError("NOT_A_DIRECTORY", "fs.list target is not a directory");
  const limit = integer(input.limit, 5000, 1, 5000);
  const entries = await readdir(target, {withFileTypes: true});
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > limit) throw new RuntimeExecutionError("LIST_LIMIT_EXCEEDED", `directory has more than ${limit} entries`);
  const output = [];
  for (const entry of entries) {
    const full = join(target, entry.name);
    const info = await lstat(full);
    output.push({
      name: entry.name,
      path: boundary.relative(full),
      type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
    });
  }
  return {path: boundary.relative(target), entries: output};
}

export async function fsSearch(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "fs.search requires a non-empty query", "denied");
  }
  const root = await boundary.resolveExisting(pathArgument(input));
  if (!(await stat(root)).isDirectory()) throw new RuntimeExecutionError("NOT_A_DIRECTORY", "fs.search path must be a directory");
  const maxResults = integer(input.max_results, 100, 1, 1000);
  const maxFiles = integer(input.max_files, 5000, 1, 10000);
  const maxFileBytes = integer(input.max_file_bytes, 1024 * 1024, 1, 8 * 1024 * 1024);
  const matches: Array<{path: string; occurrences: number; lines: number[]}> = [];
  let scannedFiles = 0;

  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;
    const entries = await readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles += 1;
      if (scannedFiles > maxFiles) throw new RuntimeExecutionError("SEARCH_FILE_LIMIT", `fs.search exceeded max_files=${maxFiles}`);
      const info = await stat(full);
      if (info.size > maxFileBytes) continue;
      const bytes = await readFile(full);
      if (bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      let offset = 0;
      let occurrences = 0;
      const lines = new Set<number>();
      while (true) {
        const found = content.indexOf(input.query as string, offset);
        if (found < 0) break;
        occurrences += 1;
        lines.add(content.slice(0, found).split("\n").length);
        offset = found + Math.max(1, (input.query as string).length);
      }
      if (occurrences > 0) matches.push({path: boundary.relative(full), occurrences, lines: [...lines]});
    }
  }

  await walk(root);
  return {query: input.query, path: boundary.relative(root), scanned_files: scannedFiles, matches};
}

const INSTRUCTION_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md"];

export async function discoverInstructions(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await boundary.resolveExisting(pathArgument(input));
  const targetStat = await stat(target);
  let current = targetStat.isDirectory() ? target : dirname(target);
  const dirs: string[] = [];
  while (true) {
    dirs.push(current);
    if (current === boundary.root) break;
    current = dirname(current);
  }
  dirs.reverse();

  const instructions: Array<{path: string; tier: "repo" | "path"; digest: string; content: string}> = [];
  for (const dir of dirs) {
    for (const name of INSTRUCTION_NAMES) {
      const candidate = join(dir, name);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const canonical = await boundary.resolveExisting(boundary.relative(candidate));
        const bytes = await readFile(canonical);
        instructions.push({
          path: boundary.relative(canonical),
          tier: dir === boundary.root ? "repo" : "path",
          digest: sha256(bytes),
          content: bytes.toString("utf8"),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof RuntimeExecutionError && error.code === "PATH_NOT_FOUND") continue;
        throw error;
      }
    }
  }
  return {target: boundary.relative(target), instructions};
}
