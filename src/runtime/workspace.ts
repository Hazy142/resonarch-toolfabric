import {lstat, realpath, stat} from "node:fs/promises";
import {isAbsolute, relative, resolve, sep} from "node:path";
import {RuntimeExecutionError} from "./errors.js";

export function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

export class WorkspaceBoundary {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<WorkspaceBoundary> {
    if (!root || root.includes("\0")) throw new RuntimeExecutionError("INVALID_WORKSPACE", "workspace root is invalid", "denied");
    const canonical = await realpath(root).catch(() => {
      throw new RuntimeExecutionError("WORKSPACE_NOT_FOUND", "workspace root does not exist", "denied");
    });
    const rootStat = await stat(canonical);
    if (!rootStat.isDirectory()) throw new RuntimeExecutionError("INVALID_WORKSPACE", "workspace root is not a directory", "denied");
    return new WorkspaceBoundary(canonical);
  }

  private lexical(inputPath: string): string {
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new RuntimeExecutionError("INVALID_PATH", "path must be a string without NUL bytes", "denied");
    }
    if (isAbsolute(inputPath)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "absolute paths are outside the workspace contract", "denied");
    const lexical = resolve(this.root, inputPath || ".");
    if (!isWithinPath(this.root, lexical)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "path escapes workspace", "denied");
    return lexical;
  }

  async resolveExisting(inputPath = "."): Promise<string> {
    const lexical = this.lexical(inputPath);
    const canonical = await realpath(lexical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new RuntimeExecutionError("PATH_NOT_FOUND", "path does not exist");
      throw new RuntimeExecutionError("PATH_RESOLUTION_FAILED", error.message);
    });
    if (!isWithinPath(this.root, canonical)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "resolved path escapes workspace", "denied");
    return canonical;
  }

  async resolveProspective(inputPath: string): Promise<string> {
    const lexical = this.lexical(inputPath);

    try {
      const info = await lstat(lexical);
      if (info.isSymbolicLink()) {
        throw new RuntimeExecutionError("SYMLINK_MUTATION_FORBIDDEN", "mutation targets may not be symbolic links", "denied");
      }
      const canonical = await realpath(lexical);
      if (!isWithinPath(this.root, canonical)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "resolved path escapes workspace", "denied");
      return canonical;
    } catch (error) {
      if (error instanceof RuntimeExecutionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RuntimeExecutionError("PATH_RESOLUTION_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    let probe = lexical;
    const tail: string[] = [];
    while (probe !== this.root) {
      const parent = resolve(probe, "..");
      tail.unshift(relative(parent, probe));
      try {
        const canonicalParent = await realpath(parent);
        if (!isWithinPath(this.root, canonicalParent)) {
          throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "prospective path resolves outside workspace", "denied");
        }
        const resolved = resolve(canonicalParent, ...tail);
        if (!isWithinPath(this.root, resolved)) {
          throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "prospective path escapes workspace", "denied");
        }
        return resolved;
      } catch (error) {
        if (error instanceof RuntimeExecutionError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new RuntimeExecutionError("PATH_RESOLUTION_FAILED", error instanceof Error ? error.message : String(error));
        }
      }
      probe = parent;
    }

    throw new RuntimeExecutionError("PATH_RESOLUTION_FAILED", "no safe workspace ancestor found", "denied");
  }

  relative(target: string): string {
    const rel = relative(this.root, target).replaceAll("\\", "/");
    return rel || ".";
  }
}
