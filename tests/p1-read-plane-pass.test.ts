import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain, type Receipt } from "../src/evidence/receipt.js";
import { ReadPlaneRuntime, type ToolCall } from "../src/runtime/readPlane.js";
import type { NetworkReadTransport, NetworkFetchRequest, NetworkFetchResponse } from "../src/runtime/networkRead.js";

const execFile = promisify(execFileCallback);

async function makeFixture(): Promise<{ workspace: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p1-pass-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "# root rules\n", "utf8");
  await writeFile(join(workspace, "src", "index.ts"), "export function hello(): string { return 'world'; }\n", "utf8");
  await execFile("git", ["init"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "ToolFabric Fixture"], { cwd: workspace });
  await execFile("git", ["add", "."], { cwd: workspace });
  await execFile("git", ["commit", "-m", "fixture"], { cwd: workspace });
  return { workspace, artifacts };
}

function call(toolId: string, args: Record<string, unknown>, workspace: string, taskId = "task-p1-pass"): ToolCall {
  const version2Tools = new Set(["web.fetch", "web.search", "docs.resolve", "package.resolve", "vulnerability.search", "network.authorize"]);
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: `call-${toolId}-${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    trace_id: "trace-p1-pass",
    tool: { id: toolId, version: version2Tools.has(toolId) ? "2.0.0" : "1.0.0" },
    arguments: args,
    scope: { workspace_root: workspace },
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

class MockTransport implements NetworkReadTransport {
  async fetch(req: NetworkFetchRequest): Promise<NetworkFetchResponse> {
    return {
      requested_url: req.url,
      final_url: req.url,
      status: 200,
      content_type: "text/plain",
      etag: null,
      last_modified: null,
      redirect_location: null,
      retrieved_at: new Date().toISOString(),
      body: new Uint8Array(new TextEncoder().encode("mock external document content")),
    };
  }
}

test("Exhaustive Registry Gate - P1 forbidden mutators are blocked, read tools succeed or throw UNSUPPORTED", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });
  
  const fsWrite = await runtime.execute(call("fs.write", { path: "out.txt", content: "foo" }, workspace));
  assert.equal(fsWrite.result.status, "denied");
  assert.equal((fsWrite.result.error as any).code, "P1_WRITE_FORBIDDEN");

  const codeEdit = await runtime.execute(call("code.edit", { path: "src/index.ts", edits: [] }, workspace));
  assert.equal(codeEdit.result.status, "denied");
  assert.equal((codeEdit.result.error as any).code, "P1_WRITE_FORBIDDEN");

  const webSearch = await runtime.execute(call("web.search", { query: "foo" }, workspace));
  assert.equal(webSearch.result.status, "failed");
  assert.equal((webSearch.result.error as any).code, "UNSUPPORTED");

  const astQuery = await runtime.execute(call("code.ast_query", { path: "src/index.ts" }, workspace));
  assert.equal(astQuery.result.status, "succeeded");
});

test("E2E true data propagation DAG (Research -> Compare -> Bundle -> Classify)", async () => {
  const { workspace, artifacts } = await makeFixture();
  const networkReadPolicy = {
    allowed_hosts: ["example.com"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    max_requests: 10,
    max_response_bytes: 1024 * 1024,
    data_locality: "public" as const,
  };
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts, networkReadPolicy, networkTransport: new MockTransport() });
  
  const receipts: Receipt[] = [];
  
  // 1. Authorize network read
  const auth = await runtime.execute(call("network.authorize", { url: "https://example.com/docA" }, workspace));
  assert.equal(auth.result.status, "succeeded");
  receipts.push(auth.receipt);
  const authRef = (auth.result.output as any).authorization_ref;

  // 2. Fetch external doc via MockTransport
  const fetch = await runtime.execute(call("web.fetch", { authorization_ref: authRef, url: "https://example.com/docA" }, workspace));
  assert.equal(fetch.result.status, "succeeded");
  receipts.push(fetch.receipt);
  const externalDocText = (fetch.result.output as any).text;

  // 3. Read internal doc
  const read = await runtime.execute(call("fs.read", { path: "AGENTS.md" }, workspace));
  assert.equal(read.result.status, "succeeded");
  receipts.push(read.receipt);
  const internalDocText = (read.result.output as any).content;

  // 4. Compare the two actual sources
  const compare = await runtime.execute(call("source.compare", { sources: [externalDocText, internalDocText] }, workspace));
  assert.equal(compare.result.status, "succeeded");
  receipts.push(compare.receipt);
  const similarity = (compare.result.output as any).similarity_score;

  // 5. Bundle research findings using the comparison results
  const bundle = await runtime.execute(call("research.bundle", { 
    topic: "Documentation comparison", 
    findings: [{ claim: `Documents have a similarity of ${similarity}` }] 
  }, workspace));
  assert.equal(bundle.result.status, "succeeded");
  receipts.push(bundle.receipt);
  const findingClaim = (bundle.result.output as any).findings[0].claim;

  // 6. Classify the bundled finding
  const classify = await runtime.execute(call("claim.classify", { claims: [findingClaim] }, workspace));
  assert.equal(classify.result.status, "succeeded");
  receipts.push(classify.receipt);

  assert.equal(verifyChain(receipts), true);
});

test("E2E Audit true data propagation DAG", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });
  
  const receipts: Receipt[] = [];

  // 1. Scan for secrets
  const scan = await runtime.execute(call("secret.scan", { path: "." }, workspace));
  assert.equal(scan.result.status, "succeeded");
  receipts.push(scan.receipt);
  const clean = (scan.result.output as any).findings_count === 0;

  // 2. Compile policy rule
  const compile = await runtime.execute(call("policy.compile", { name: "AuditPolicy", rules: ["must be clean of secrets"] }, workspace));
  assert.equal(compile.result.status, "succeeded");
  receipts.push(compile.receipt);

  // 3. Render report based on actual scan result
  const render = await runtime.execute(call("report.render", { 
    title: "Security Audit", 
    sections: [{ title: "Secrets", content: clean ? "No secrets found." : "Secrets detected!" }] 
  }, workspace));
  assert.equal(render.result.status, "succeeded");
  receipts.push(render.receipt);
  
  assert.ok(((render.result.output as any).markdown as string).includes("No secrets found."));
  assert.equal(verifyChain(receipts), true);
});
