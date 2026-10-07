import {open, readFile, rename as fsRename, stat, unlink} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import {randomUUID} from "node:crypto";
import {sha256} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";
import {WorkspaceBoundary} from "./workspace.js";

export interface FileState {
  exists: boolean;
  sha256: string | null;
  bytes: number;
}

export interface ProbedFile {
  target: string;
  relative: string;
  state: FileState;
  mode: number | null;
}

export interface MutationFsOps {
  rename(source: string, destination: string): Promise<void>;
}

export const defaultMutationFsOps: MutationFsOps = {
  rename: fsRename,
};

export async function probeFile(boundary: WorkspaceBoundary, inputPath: string): Promise<ProbedFile> {
  const target = await boundary.resolveProspective(inputPath);
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new RuntimeExecutionError("NOT_A_FILE", "filesystem mutation target must be a regular file", "denied");
    const bytes = await readFile(target);
    return {
      target,
      relative: boundary.relative(target),
      state: {exists: true, sha256: sha256(bytes), bytes: bytes.byteLength},
      mode: info.mode & 0o7777,
    };
  } catch (error) {
    if (error instanceof RuntimeExecutionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {target, relative: boundary.relative(target), state: {exists: false, sha256: null, bytes: 0}, mode: null};
    }
    throw new RuntimeExecutionError("FILE_STATE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export function stateMatches(actual: FileState, expected: FileState): boolean {
  return actual.exists === expected.exists
    && actual.sha256 === expected.sha256
    && actual.bytes === expected.bytes;
}

export async function atomicWrite(
  target: string,
  content: Uint8Array,
  ops: MutationFsOps,
  preserveMode: number | null = null,
): Promise<void> {
  const parent = dirname(target);
  const parentInfo = await stat(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RuntimeExecutionError("PARENT_NOT_FOUND", "target parent directory does not exist", "denied");
    throw error;
  });
  if (!parentInfo.isDirectory()) throw new RuntimeExecutionError("PARENT_NOT_DIRECTORY", "target parent is not a directory", "denied");

  const temporary = join(parent, `.${basename(target)}.toolfabric-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    if (preserveMode !== null) await handle.chmod(preserveMode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = null;
    await ops.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function atomicMove(source: string, destination: string, ops: MutationFsOps): Promise<void> {
  await ops.rename(source, destination);
}

export function utf8Bytes(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new RuntimeExecutionError("INVALID_ARGUMENT", `${field} must be a string`, "denied");
  return new TextEncoder().encode(value);
}

export function exactReplacement(source: string, oldText: unknown, newText: unknown, expectedReplacements: unknown): string {
  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "old_text must be a non-empty string", "denied");
  }
  if (typeof newText !== "string") throw new RuntimeExecutionError("INVALID_ARGUMENT", "new_text must be a string", "denied");
  const expected = expectedReplacements === undefined ? 1 : expectedReplacements;
  if (!Number.isInteger(expected) || Number(expected) < 1 || Number(expected) > 1000) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "expected_replacements must be an integer between 1 and 1000", "denied");
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(oldText, offset);
    if (index < 0) break;
    count += 1;
    offset = index + oldText.length;
  }
  if (count !== expected) {
    throw new RuntimeExecutionError(
      "PATCH_PRECONDITION_FAILED",
      `expected ${expected} replacement(s), observed ${count}`,
      "denied",
    );
  }
  return source.split(oldText).join(newText);
}
