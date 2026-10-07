import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../src/contracts/canonical.js";
import { verifyChain, type Receipt } from "../src/evidence/receipt.js";
import { ReadPlaneRuntime, type ToolCall } from "../src/runtime/readPlane.js";
import { compileWorkflow, loadUserTool } from "../src/workflows/compiler.js";

const execFile = promisify(execFileCallback);

async function makeFixture(): Promise<{ workspace: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p1-pass-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "# root rules\n", "utf8");
  await writeFile(join(workspace, "LICENSE"), "Apache-2.0\n", "utf8");
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "fixture-app",
    version: "1.0.0",
    license: "Apache-2.0",
    scripts: { test: "node --test", "test:coverage": "c8 node --test" },
    dependencies: { typescript: "^5.9.0" },
  }), "utf8");
  await writeFile(join(workspace, "src", "index.ts"), "export function hello(): string { return 'world'; }\n", "utf8");
  await writeFile(join(workspace, "src", "index.test.ts"), "import { hello } from './index.js'; test('hello', () => hello());\n", "utf8");

  await execFile("git", ["init"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "ToolFabric Fixture"], { cwd: workspace });
  await execFile("git", ["add", "."], { cwd: workspace });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: workspace });
  return { workspace, artifacts };
}

function call(toolId: string, args: Record<string, unknown>, workspace: string, taskId = "task-p1-pass"): ToolCall {
  const version2Tools = new Set(["web.fetch", "web.search", "docs.resolve", "package.resolve", "vulnerability.search", "network.authorize"]);
  const version = version2Tools.has(toolId) ? "2.0.0" : "1.0.0";
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: `call-${toolId}-${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    trace_id: "trace-p1-pass",
    tool: { id: toolId, version },
    arguments: args,
    scope: { workspace_root: workspace },
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("P1 read-plane extensions execute cleanly and produce valid receipts", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });

  const ast = await runtime.execute(call("code.ast_query", { path: "src/index.ts", kind: "function" }, workspace));
  assert.equal(ast.result.status, "succeeded");
  assert.equal((ast.result.output as { matches: unknown[] }).matches.length, 1);

  const diag = await runtime.execute(call("code.diagnostics", { path: "src" }, workspace));
  assert.equal(diag.result.status, "succeeded");
  assert.equal((diag.result.output as { clean: boolean }).clean, true);

  const refs = await runtime.execute(call("code.references", { path: "src", symbol: "hello" }, workspace));
  assert.equal(refs.result.status, "succeeded");
  assert.equal((refs.result.output as { references_count: number }).references_count, 2);

  const search = await runtime.execute(call("code.search", { path: "src", query: "export function" }, workspace));
  assert.equal(search.result.status, "succeeded");
  assert.equal((search.result.output as { matches_count: number }).matches_count, 1);

  const secrets = await runtime.execute(call("secret.scan", { path: "." }, workspace));
  assert.equal(secrets.result.status, "succeeded");
  assert.equal((secrets.result.output as { findings_count: number }).findings_count, 0);

  const lic = await runtime.execute(call("license.inspect", { path: "." }, workspace));
  assert.equal(lic.result.status, "succeeded");
  assert.equal((lic.result.output as { compliant: boolean }).compliant, true);

  const vulns = await runtime.execute(call("vulnerability.search", { path: "." }, workspace));
  assert.equal(vulns.result.status, "succeeded");

  const sandbox = await runtime.execute(call("sandbox.boundary", {}, workspace));
  assert.equal(sandbox.result.status, "succeeded");
  assert.equal((sandbox.result.output as { isolated: boolean }).isolated, true);
});

test("E2E User-Tool inspect DAG executes cleanly", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });
  const spec = await loadUserTool("inspect");
  const compiled = compileWorkflow(spec);

  const receipts: Receipt[] = [];
  for (const node of compiled.nodes) {
    let args: Record<string, unknown> = { path: "." };
    if (node.tool === "instructions.resolve") {
      args = { sources: [{ id: "agents", tier: "repo", content: "# root rules", path: "AGENTS.md" }] };
    } else if (node.tool === "fs.search") {
      args = { path: "src", query: "hello" };
    } else if (node.tool === "context.pack") {
      args = { items: [{ id: "1", priority: 10, kind: "code", content: "hello" }] };
    } else if (node.tool === "report.render") {
      args = { title: "Inspect Report", sections: [{ title: "Overview", content: "All checks passed." }] };
    }

    const executed = await runtime.execute(call(node.tool, args, workspace, "task-inspect-dag"));
    assert.equal(executed.result.status, "succeeded", `Node ${node.tool} failed: ${JSON.stringify(executed.result.error)}`);
    receipts.push(executed.receipt);
  }

  assert.equal(receipts.length, compiled.nodes.length);
  assert.equal(verifyChain(receipts), true);
});

test("E2E User-Tool research DAG executes cleanly", async () => {
  const { workspace, artifacts } = await makeFixture();
  const networkReadPolicy = {
    allowed_hosts: ["example.com"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    max_requests: 10,
    max_response_bytes: 1024 * 1024,
    data_locality: "public" as const,
  };
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts, networkReadPolicy });
  const spec = await loadUserTool("research");
  const compiled = compileWorkflow(spec);

  const receipts: Receipt[] = [];
  for (const node of compiled.nodes) {
    let args: Record<string, unknown> = {};
    if (node.tool === "web.search") {
      args = { query: "ToolFabric specification" };
    } else if (node.tool === "web.fetch") {
      const auth = await runtime.execute(call("network.authorize", { url: "https://example.com/docs" }, workspace, "task-research-dag"));
      receipts.push(auth.receipt);
      args = { authorization_ref: (auth.result.output as { authorization_ref: string }).authorization_ref, url: "https://example.com/docs" };
    } else if (node.tool === "source.compare") {
      args = { sources: ["doc alpha", "doc beta"] };
    } else if (node.tool === "research.bundle") {
      args = { topic: "ToolFabric", findings: [{ claim: "Open execution infrastructure" }] };
    } else if (node.tool === "claim.classify") {
      args = { claims: [{ text: "ToolFabric provides verified receipts" }] };
    }

    const executed = await runtime.execute(call(node.tool, args, workspace, "task-research-dag"));
    assert.equal(executed.result.status, "succeeded", `Node ${node.tool} failed: ${JSON.stringify(executed.result.error)}`);
    receipts.push(executed.receipt);
  }

  assert.equal(receipts.length, compiled.nodes.length + 1);
  assert.equal(verifyChain(receipts), true);
});

test("E2E User-Tool audit DAG executes cleanly", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });
  const spec = await loadUserTool("audit");
  const compiled = compileWorkflow(spec);

  const receipts: Receipt[] = [];
  for (const node of compiled.nodes) {
    let args: Record<string, unknown> = { path: "." };
    if (node.tool === "policy.compile") {
      args = { name: "security-policy", rules: ["deny-unauthorized-writes"] };
    } else if (node.tool === "receipt.verify") {
      args = { receipts: [receipts[0]!] };
    } else if (node.tool === "report.render") {
      args = { title: "Audit Report", sections: [{ title: "Compliance", content: "No issues." }] };
    }

    const executed = await runtime.execute(call(node.tool, args, workspace, "task-audit-dag"));
    assert.equal(executed.result.status, "succeeded", `Node ${node.tool} failed: ${JSON.stringify(executed.result.error)}`);
    receipts.push(executed.receipt);
  }

  assert.equal(receipts.length, compiled.nodes.length);
  assert.equal(verifyChain(receipts), true);
});

test("P1_READ_PLANE_PASS gate claim verification", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });

  const mut = await runtime.execute(call("fs.patch", { path: "src/index.ts", patch: "" }, workspace, "gate-check"));
  assert.equal(mut.result.status, "denied");
  assert.equal((mut.result.error as { code: string }).code, "P1_WRITE_FORBIDDEN");

  const read = await runtime.execute(call("fs.read", { path: "src/index.ts" }, workspace, "gate-check"));
  assert.equal(read.result.status, "succeeded");
  assert.equal(verifyChain([mut.receipt, read.receipt]), true);
});
