import {realpath, stat} from "node:fs/promises";
import {isAbsolute, relative, resolve, sep} from "node:path";
import {RuntimeExecutionError} from "./errors.js";

function inside(root: string, target: string): boolean {
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

  async resolveExisting(inputPath = "."): Promise<string> {
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new RuntimeExecutionError("INVALID_PATH", "path must be a string without NUL bytes", "denied");
    }
    if (isAbsolute(inputPath)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "absolute paths are outside the workspace contract", "denied");
    const lexical = resolve(this.root, inputPath || ".");
    if (!inside(this.root, lexical)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "path escapes workspace", "denied");
    const canonical = await realpath(lexical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new RuntimeExecutionError("PATH_NOT_FOUND", "path does not exist");
      throw new RuntimeExecutionError("PATH_RESOLUTION_FAILED", error.message);
    });
    if (!inside(this.root, canonical)) throw new RuntimeExecutionError("WORKSPACE_ESCAPE", "resolved path escapes workspace", "denied");
    return canonical;
  }

  relative(target: string): string {
    const rel = relative(this.root, target).replaceAll("\\", "/");
    return rel || ".";
  }
}
