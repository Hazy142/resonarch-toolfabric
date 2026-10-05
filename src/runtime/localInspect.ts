import {lstat, readFile, readdir, stat} from "node:fs/promises";
import {basename, extname, join} from "node:path";
import ts from "typescript";
import {canonicalDigest, canonicalJson, sha256} from "../contracts/canonical.js";
import {
  mayActAsInstruction,
  resolveInstructionOrder,
  type InstructionSource,
  type InstructionTier,
} from "../core/instructions.js";
import {RuntimeExecutionError} from "./errors.js";
import {WorkspaceBoundary} from "./workspace.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

const PARSEABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([
  ...PARSEABLE_EXTENSIONS,
  ".py", ".rs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt",
]);

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

async function walkFiles(
  boundary: WorkspaceBoundary,
  root: string,
  options: {maxFiles?: number; include?: (relativePath: string) => boolean} = {},
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 5000;
  const output: string[] = [];
  let seen = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > maxFiles) throw new RuntimeExecutionError("FILE_SCAN_LIMIT", `file scan exceeded max_files=${maxFiles}`);
      const full = join(directory, entry.name);
      const relativePath = boundary.relative(full);
      if (!options.include || options.include(relativePath)) output.push(full);
    }
  }

  await walk(root);
  return output;
}

const INSTRUCTION_TIERS = new Set<InstructionTier>([
  "user",
  "task_contract",
  "repo",
  "path",
  "role",
  "tool",
  "retrieved_data",
]);

export function instructionsResolve(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 256) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "instructions.resolve requires 1..256 sources", "denied");
  }

  const normalized: InstructionSource[] = input.sources.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `instruction source ${index} must be an object`, "denied");
    }
    const source = raw as Record<string, unknown>;
    if (typeof source.tier !== "string" || !INSTRUCTION_TIERS.has(source.tier as InstructionTier)) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `instruction source ${index} has invalid tier`, "denied");
    }
    if (typeof source.content !== "string") {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `instruction source ${index} requires content`, "denied");
    }
    const id = typeof source.id === "string"
      ? source.id
      : typeof source.path === "string"
        ? source.path
        : `source-${index}`;
    const contentDigest = sha256(new TextEncoder().encode(source.content));
    if (source.digest !== undefined && source.digest !== contentDigest) {
      throw new RuntimeExecutionError("INSTRUCTION_DIGEST_MISMATCH", id, "denied");
    }
    const digest = contentDigest;
    const scope = typeof source.scope === "string"
      ? source.scope
      : typeof source.path === "string"
        ? source.path
        : "workspace";
    return {
      id,
      tier: source.tier as InstructionTier,
      digest,
      scope,
      content: source.content,
    };
  });

  const ids = new Set<string>();
  for (const source of normalized) {
    if (ids.has(source.id)) throw new RuntimeExecutionError("DUPLICATE_INSTRUCTION_ID", source.id, "denied");
    ids.add(source.id);
  }

  const ordered = resolveInstructionOrder(normalized).map(source => ({
    ...source,
    actionable: mayActAsInstruction(source),
  }));
  return {
    ordered,
    actionable_ids: ordered.filter(source => source.actionable).map(source => source.id),
    data_only_ids: ordered.filter(source => !source.actionable).map(source => source.id),
    digest: canonicalDigest(ordered),
  };
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function exported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export async function codeSymbols(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await boundary.resolveExisting(pathArgument(input));
  if (!(await stat(root)).isDirectory()) throw new RuntimeExecutionError("NOT_A_DIRECTORY", "code.symbols path must be a directory");
  const maxFiles = integer(input.max_files, 5000, 1, 10000);
  const files = await walkFiles(boundary, root, {
    maxFiles,
    include: relativePath => SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase()),
  });

  const symbols: Array<{name: string; kind: string; path: string; line: number; exported: boolean}> = [];
  const unsupportedFiles: string[] = [];

  for (const full of files) {
    const extension = extname(full).toLowerCase();
    const relativePath = boundary.relative(full);
    if (!PARSEABLE_EXTENSIONS.has(extension)) {
      unsupportedFiles.push(relativePath);
      continue;
    }
    const info = await stat(full);
    if (info.size > 2 * 1024 * 1024) {
      unsupportedFiles.push(relativePath);
      continue;
    }
    const content = await readFile(full, "utf8");
    const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          symbols.push({
            name: declaration.name.text,
            kind: "variable",
            path: relativePath,
            line: lineOf(source, declaration),
            exported: exported(statement),
          });
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        symbols.push({name: statement.name.text, kind: "function", path: relativePath, line: lineOf(source, statement), exported: exported(statement)});
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        symbols.push({name: statement.name.text, kind: "class", path: relativePath, line: lineOf(source, statement), exported: exported(statement)});
      } else if (ts.isInterfaceDeclaration(statement)) {
        symbols.push({name: statement.name.text, kind: "interface", path: relativePath, line: lineOf(source, statement), exported: exported(statement)});
      } else if (ts.isTypeAliasDeclaration(statement)) {
        symbols.push({name: statement.name.text, kind: "type", path: relativePath, line: lineOf(source, statement), exported: exported(statement)});
      } else if (ts.isEnumDeclaration(statement)) {
        symbols.push({name: statement.name.text, kind: "enum", path: relativePath, line: lineOf(source, statement), exported: exported(statement)});
      }
    }
  }

  return {
    path: boundary.relative(root),
    parser: "typescript-compiler-api",
    symbols,
    unsupported_files: unsupportedFiles.sort(),
  };
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}

async function readPackageManifest(boundary: WorkspaceBoundary, input: Record<string, unknown>): Promise<{path: string; manifest: PackageManifest; directory: string}> {
  const target = await boundary.resolveExisting(pathArgument(input));
  const info = await stat(target);
  const candidate = info.isDirectory() ? join(target, "package.json") : target;
  if (basename(candidate) !== "package.json") {
    throw new RuntimeExecutionError("UNSUPPORTED_MANIFEST", "code.dependencies currently supports package.json only");
  }
  const manifestPath = await boundary.resolveExisting(boundary.relative(candidate));
  const manifestStat = await stat(manifestPath);
  if (manifestStat.size > 1024 * 1024) {
    throw new RuntimeExecutionError("MANIFEST_TOO_LARGE", "package.json exceeds 1 MiB");
  }
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  } catch (error) {
    throw new RuntimeExecutionError("MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RuntimeExecutionError("MANIFEST_INVALID", "package.json must contain an object");
  }
  return {path: boundary.relative(manifestPath), manifest, directory: info.isDirectory() ? target : join(target, "..")};
}

function dependencyEntries(manifest: PackageManifest): Array<{name: string; spec: string; section: string}> {
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
  const entries: Array<{name: string; spec: string; section: string}> = [];
  for (const section of sections) {
    const value = manifest[section];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RuntimeExecutionError("MANIFEST_INVALID", `${section} must be an object`);
    }
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      if (typeof spec !== "string") throw new RuntimeExecutionError("MANIFEST_INVALID", `${section}.${name} must be a string`);
      entries.push({name, spec, section});
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
}

async function packageManager(directory: string): Promise<string> {
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    try {
      const info = await lstat(join(directory, file));
      if (info.isFile()) return manager;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "npm";
}

export async function codeDependencies(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const {path, manifest, directory} = await readPackageManifest(boundary, input);
  const scripts = manifest.scripts === undefined
    ? []
    : manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
      ? Object.entries(manifest.scripts as Record<string, unknown>)
          .map(([name, command]) => {
            if (typeof command !== "string") throw new RuntimeExecutionError("MANIFEST_INVALID", `scripts.${name} must be a string`);
            return name;
          })
          .sort()
      : (() => { throw new RuntimeExecutionError("MANIFEST_INVALID", "scripts must be an object"); })();

  return {
    ecosystem: "npm",
    manifest: path,
    package_name: typeof manifest.name === "string" ? manifest.name : null,
    package_version: typeof manifest.version === "string" ? manifest.version : null,
    package_manager: await packageManager(directory),
    dependencies: dependencyEntries(manifest),
    scripts,
  };
}

function isTestFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const name = basename(normalized).toLowerCase();
  return (
    /(^|\/)(tests?|__tests__)(\/|$)/i.test(normalized) ||
    /\.(test|spec)\.[^.]+$/i.test(name)
  );
}

export async function testDiscover(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await boundary.resolveExisting(pathArgument(input));
  if (!(await stat(root)).isDirectory()) throw new RuntimeExecutionError("NOT_A_DIRECTORY", "test.discover path must be a directory");
  const maxFiles = integer(input.max_files, 5000, 1, 10000);
  const files = (await walkFiles(boundary, root, {maxFiles, include: isTestFile}))
    .map(path => boundary.relative(path))
    .sort();

  let scripts: Array<{name: string; command: string}> = [];
  try {
    const packagePath = await boundary.resolveExisting(boundary.relative(join(root, "package.json")));
    const packageStat = await stat(packagePath);
    if (packageStat.size > 1024 * 1024) throw new RuntimeExecutionError("MANIFEST_TOO_LARGE", "package.json exceeds 1 MiB");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as PackageManifest;
    if (manifest.scripts !== undefined) {
      if (!manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) {
        throw new RuntimeExecutionError("MANIFEST_INVALID", "scripts must be an object");
      }
      scripts = Object.entries(manifest.scripts as Record<string, unknown>)
        .filter(([name, command]) => /^test(?::|$)/.test(name) && typeof command === "string")
        .map(([name, command]) => ({name, command: command as string}))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch (error) {
    if (!(error instanceof RuntimeExecutionError && error.code === "PATH_NOT_FOUND")) throw error;
  }

  return {path: boundary.relative(root), files, scripts};
}

interface ContextItem {
  id: string;
  priority: number;
  kind: string;
  content: unknown;
}

export function contextPack(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.items) || input.items.length > 256) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "context.pack items must be an array of at most 256 entries", "denied");
  }
  const maxBytes = integer(input.max_bytes, 64 * 1024, 128, 1024 * 1024);
  const normalized: ContextItem[] = input.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `context item ${index} must be an object`, "denied");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `context item ${index} requires id`, "denied");
    }
    if (typeof item.kind !== "string" || item.kind.length === 0) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `context item ${index} requires kind`, "denied");
    }
    const priority = integer(item.priority, 0, -1000, 1000);
    return {id: item.id, priority, kind: item.kind, content: item.content ?? null};
  });
  const seen = new Set<string>();
  for (const item of normalized) {
    if (seen.has(item.id)) throw new RuntimeExecutionError("DUPLICATE_CONTEXT_ID", item.id, "denied");
    seen.add(item.id);
  }
  normalized.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const encoder = new TextEncoder();
  const included: ContextItem[] = [];
  const omittedIds: string[] = [];
  let bytes = 0;
  for (const item of normalized) {
    const size = encoder.encode(canonicalJson(item)).byteLength;
    if (bytes + size > maxBytes) {
      omittedIds.push(item.id);
      continue;
    }
    included.push(item);
    bytes += size;
  }

  return {
    items: included,
    omitted_ids: omittedIds,
    bytes,
    max_bytes: maxBytes,
    digest: canonicalDigest(included),
  };
}
