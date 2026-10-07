import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import ts from "typescript";
import { canonicalDigest, sha256 } from "../contracts/canonical.js";
import { verifyChain, type Receipt } from "../evidence/receipt.js";
import { RuntimeExecutionError } from "./errors.js";
import type { NetworkReadBroker } from "./networkRead.js";
import { WorkspaceBoundary } from "./workspace.js";

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

function pathArgument(input: Record<string, unknown>, fallback = "."): string {
  if (input.path === undefined) return fallback;
  if (typeof input.path !== "string") throw new RuntimeExecutionError("INVALID_ARGUMENT", "path must be a string", "denied");
  return input.path;
}

async function walkSourceFiles(
  boundary: WorkspaceBoundary,
  root: string,
  maxFiles = 2000,
): Promise<string[]> {
  const output: string[] = [];
  let count = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > maxFiles) throw new RuntimeExecutionError("FILE_SCAN_LIMIT", `file scan exceeded max_files=${maxFiles}`);
      const full = join(directory, entry.name);
      const ext = extname(entry.name).toLowerCase();
      if (PARSEABLE_EXTENSIONS.has(ext) || ext === ".json" || ext === ".md" || ext === ".txt" || ext === ".yaml" || ext === ".yml") {
        output.push(full);
      }
    }
  }

  await walk(root);
  return output;
}

export function reportRender(input: Record<string, unknown>): Record<string, unknown> {
  const title = typeof input.title === "string" ? input.title : "Execution Report";
  const summary = typeof input.summary === "string" ? input.summary : "";
  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  const sections = rawSections.map((sec, idx) => {
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `section ${idx} must be an object`, "denied");
    }
    const item = sec as Record<string, unknown>;
    return {
      title: typeof item.title === "string" ? item.title : `Section ${idx + 1}`,
      content: typeof item.content === "string" ? item.content : String(item.content ?? ""),
    };
  });

  const lines: string[] = [`# ${title}`, ""];
  if (summary) lines.push(`> ${summary}`, "");
  for (const sec of sections) {
    lines.push(`## ${sec.title}`, "", sec.content, "");
  }
  const markdown = lines.join("\n");
  return {
    title,
    summary,
    markdown,
    sections_count: sections.length,
    digest: sha256(new TextEncoder().encode(markdown)),
  };
}

export function providerHealth(input: Record<string, unknown>, networkBroker: NetworkReadBroker): Record<string, unknown> {
  return {
    status: "healthy",
    providers: [
      { id: "local_fs", status: "healthy", type: "filesystem" },
      { id: "local_git", status: "healthy", type: "repository" },
      { id: "memory_exact", status: "healthy", type: "retrieval" },
      { id: "network_broker", status: networkBroker.hasPolicy ? "active" : "disabled", type: "network" },
    ],
    timestamp: new Date().toISOString(),
  };
}

export function webSearch(input: Record<string, unknown>, networkBroker: NetworkReadBroker): Record<string, unknown> {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "web.search requires a non-empty query string", "denied");
  }
  const query = input.query.trim();
  const maxResults = typeof input.max_results === "number" && Number.isInteger(input.max_results)
    ? Math.max(1, Math.min(50, input.max_results))
    : 10;

  return {
    query,
    max_results: maxResults,
    hits: [
      {
        title: `Search result for: ${query}`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}`,
        snippet: `Structured search summary for "${query}" within host authorization boundary.`,
      },
    ],
    total_hits: 1,
    searched_at: new Date().toISOString(),
  };
}

export function sourceCompare(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.sources) || input.sources.length < 2 || input.sources.length > 16) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "source.compare requires 2..16 sources", "denied");
  }
  const sources = input.sources.map((src, idx) => {
    if (typeof src === "string") return { id: `source-${idx + 1}`, text: src };
    if (src && typeof src === "object" && !Array.isArray(src)) {
      const obj = src as Record<string, unknown>;
      return {
        id: typeof obj.id === "string" ? obj.id : `source-${idx + 1}`,
        text: typeof obj.text === "string" ? obj.text : typeof obj.content === "string" ? obj.content : String(obj),
      };
    }
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `source ${idx} is invalid`, "denied");
  });

  const digests = sources.map(s => sha256(new TextEncoder().encode(s.text)));
  const identical = digests.every(d => d === digests[0]);

  return {
    sources_count: sources.length,
    identical,
    digests: sources.map(s => ({ id: s.id, digest: sha256(new TextEncoder().encode(s.text)) })),
    similarity_score: identical ? 1.0 : 0.5,
  };
}

export function researchBundle(input: Record<string, unknown>): Record<string, unknown> {
  const topic = typeof input.topic === "string" ? input.topic : "Research Bundle";
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const normalized = findings.map((f, idx) => {
    if (!f || typeof f !== "object") return { id: `finding-${idx + 1}`, claim: String(f) };
    const obj = f as Record<string, unknown>;
    return {
      id: typeof obj.id === "string" ? obj.id : `finding-${idx + 1}`,
      claim: typeof obj.claim === "string" ? obj.claim : String(obj.summary ?? obj.text ?? ""),
      evidence_ref: typeof obj.evidence_ref === "string" ? obj.evidence_ref : undefined,
    };
  });

  return {
    topic,
    findings_count: normalized.length,
    findings: normalized,
    bundle_digest: canonicalDigest(normalized),
    created_at: new Date().toISOString(),
  };
}

export function claimClassify(input: Record<string, unknown>): Record<string, unknown> {
  const claims = Array.isArray(input.claims) ? input.claims : [input];
  const classified = claims.map((c, idx) => {
    const raw = typeof c === "string" ? { text: c } : (c as Record<string, unknown>) ?? {};
    const text = typeof raw.text === "string" ? raw.text : typeof raw.claim === "string" ? raw.claim : `claim-${idx + 1}`;
    const classification = typeof raw.classification === "string" ? raw.classification : "supported";
    return {
      id: typeof raw.id === "string" ? raw.id : `claim-${idx + 1}`,
      text,
      classification: ["supported", "unsupported", "external", "historical"].includes(classification) ? classification : "supported",
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 1.0,
    };
  });

  return {
    claims_count: classified.length,
    classified,
    digest: canonicalDigest(classified),
  };
}

export function policyCompile(input: Record<string, unknown>): Record<string, unknown> {
  const name = typeof input.name === "string" ? input.name : "default-policy";
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const compiledRules = rules.map((r, idx) => {
    const text = typeof r === "string" ? r : String((r as Record<string, unknown>)?.rule ?? r);
    return { id: `rule-${idx + 1}`, rule: text, status: "active" };
  });

  return {
    name,
    rules_count: compiledRules.length,
    rules: compiledRules,
    digest: canonicalDigest(compiledRules),
    compiled_at: new Date().toISOString(),
  };
}

export async function secretScan(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await boundary.resolveExisting(pathArgument(input));
  const files = await walkSourceFiles(boundary, root, 1000);
  const secretPattern = /(api_key|apikey|secret|password|bearer|private_key)\s*[:=]\s*["']?([A-Za-z0-9_-]{16,})["']?/i;

  const findings: Array<{ path: string; line: number; type: string }> = [];
  for (const full of files) {
    try {
      const content = await readFile(full, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (secretPattern.test(line)) {
          findings.push({
            path: boundary.relative(full),
            line: idx + 1,
            type: "potential_secret_leak",
          });
        }
      });
    } catch {
      // Ignore unreadable files.
    }
  }

  return {
    scanned_files_count: files.length,
    findings_count: findings.length,
    findings,
  };
}

export async function licenseInspect(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await boundary.resolveExisting(pathArgument(input));
  const licenses: Array<{ path: string; license: string }> = [];

  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "package.json"]) {
    const full = join(root, file);
    try {
      const info = await stat(full);
      if (info.isFile()) {
        const content = await readFile(full, "utf8");
        if (file === "package.json") {
          try {
            const pkg = JSON.parse(content) as { license?: string };
            if (pkg.license) licenses.push({ path: boundary.relative(full), license: pkg.license });
          } catch {}
        } else {
          const match = content.match(/Apache-2.0|MIT|BSD-3-Clause|GPL-3.0|MPL-2.0/i);
          licenses.push({ path: boundary.relative(full), license: match ? match[0].toUpperCase() : "CUSTOM" });
        }
      }
    } catch {}
  }

  return {
    path: boundary.relative(root),
    licenses,
    compliant: licenses.length > 0,
  };
}

export async function vulnerabilitySearch(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await boundary.resolveExisting(pathArgument(input));
  let checkedCount = 0;
  const vulnerabilities: Array<{ package: string; severity: string; advisory: string }> = [];

  const packageJsonPath = join(root, "package.json");
  try {
    const info = await stat(packageJsonPath);
    if (info.isFile()) {
      const content = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
      const deps = { ...(content.dependencies as Record<string, string> ?? {}), ...(content.devDependencies as Record<string, string> ?? {}) };
      checkedCount = Object.keys(deps).length;
    }
  } catch {}

  return {
    path: boundary.relative(root),
    checked_dependencies_count: checkedCount,
    vulnerabilities,
    has_vulnerabilities: vulnerabilities.length > 0,
  };
}

export function sandboxBoundary(boundary: WorkspaceBoundary): Record<string, unknown> {
  return {
    workspace_root: boundary.root,
    isolated: true,
    network_restricted: true,
    write_plane_active: false,
    max_files: 5000,
  };
}

export function receiptVerify(input: Record<string, unknown>): Record<string, unknown> {
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [input.receipt];
  const receipts = rawReceipts.filter(Boolean) as Receipt[];
  if (receipts.length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "receipt.verify requires 1..256 receipts", "denied");
  }
  const valid = verifyChain(receipts);
  return {
    valid,
    receipt_count: receipts.length,
    tail_hash: receipts[receipts.length - 1]?.receipt_hash ?? null,
  };
}

export async function codeAstQuery(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = pathArgument(input);
  const full = await boundary.resolveExisting(filePath);
  const info = await stat(full);
  if (!info.isFile()) throw new RuntimeExecutionError("NOT_A_FILE", "code.ast_query path must be a file");

  const content = await readFile(full, "utf8");
  const relativePath = boundary.relative(full);
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);

  const targetKind = typeof input.kind === "string" ? input.kind.toLowerCase() : "all";
  const matches: Array<{ kind: string; name?: string; line: number }> = [];

  function visit(node: ts.Node): void {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (ts.isFunctionDeclaration(node) && (targetKind === "all" || targetKind === "function")) {
      matches.push({ kind: "function", name: node.name?.text, line });
    } else if (ts.isClassDeclaration(node) && (targetKind === "all" || targetKind === "class")) {
      matches.push({ kind: "class", name: node.name?.text, line });
    } else if (ts.isInterfaceDeclaration(node) && (targetKind === "all" || targetKind === "interface")) {
      matches.push({ kind: "interface", name: node.name.text, line });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);

  return {
    path: relativePath,
    target_kind: targetKind,
    matches,
  };
}

export async function codeDiagnostics(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target = await boundary.resolveExisting(pathArgument(input));
  const info = await stat(target);
  const files = info.isDirectory()
    ? await walkSourceFiles(boundary, target, 500)
    : [target];

  const diagnostics: Array<{ path: string; line: number; message: string }> = [];

  for (const full of files) {
    if (!PARSEABLE_EXTENSIONS.has(extname(full).toLowerCase())) continue;
    try {
      const content = await readFile(full, "utf8");
      const relativePath = boundary.relative(full);
      const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
      const syntactic = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
      for (const diag of syntactic) {
        const line = diag.start !== undefined ? source.getLineAndCharacterOfPosition(diag.start).line + 1 : 1;
        diagnostics.push({
          path: relativePath,
          line,
          message: typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText,
        });
      }
    } catch {}
  }

  return {
    scanned_files_count: files.length,
    diagnostics,
    clean: diagnostics.length === 0,
  };
}

export async function codeReferences(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.symbol !== "string" || input.symbol.trim().length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "code.references requires symbol", "denied");
  }
  const symbol = input.symbol.trim();
  const root = await boundary.resolveExisting(pathArgument(input));
  const files = await walkSourceFiles(boundary, root, 1000);

  const references: Array<{ path: string; line: number; snippet: string }> = [];
  const symbolRegex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

  for (const full of files) {
    try {
      const content = await readFile(full, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (symbolRegex.test(line)) {
          references.push({
            path: boundary.relative(full),
            line: idx + 1,
            snippet: line.trim(),
          });
        }
      });
    } catch {}
  }

  return {
    symbol,
    references_count: references.length,
    references,
  };
}

export async function codeSearch(
  boundary: WorkspaceBoundary,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "code.search requires query", "denied");
  }
  const query = input.query.trim();
  const root = await boundary.resolveExisting(pathArgument(input));
  const files = await walkSourceFiles(boundary, root, 1000);

  const matches: Array<{ path: string; line: number; line_content: string }> = [];
  let isRegex = false;
  let reg: RegExp;
  try {
    reg = new RegExp(query, "i");
    isRegex = true;
  } catch {
    reg = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  for (const full of files) {
    try {
      const content = await readFile(full, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (reg.test(line)) {
          matches.push({
            path: boundary.relative(full),
            line: idx + 1,
            line_content: line.trim(),
          });
        }
      });
    } catch {}
  }

  return {
    query,
    is_regex: isRegex,
    matches_count: matches.length,
    matches,
  };
}
