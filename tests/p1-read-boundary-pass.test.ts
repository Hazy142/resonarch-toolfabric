import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain, type Receipt } from "../src/evidence/receipt.js";
import { ReadPlaneRuntime, type ToolCall } from "../src/runtime/readPlane.js";
import type { NetworkReadTransport, NetworkFetchRequest, NetworkFetchResponse } from "../src/runtime/networkRead.js";
import { loadUserTool, compileWorkflow } from "../src/workflows/compiler.js";

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

function call(toolId: string, toolVersion: string, args: Record<string, unknown>, workspace: string, taskId = "task-p1-pass"): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: `call-${toolId}-${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    trace_id: "trace-p1-pass",
    tool: { id: toolId, version: toolVersion },
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

test("Exhaustive Registry Gate - all 112 tools are correctly classified and gated", async () => {
  const { workspace, artifacts } = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({ artifactRoot: artifacts });
  const sourceRaw = await readFile("contracts/tools/registry.source.json", "utf8");
  const source = JSON.parse(sourceRaw);

  const tools = [];
  for (const [family, ids] of Object.entries(source.families)) {
    for (const id of ids as string[]) {
      const toolRaw = await readFile(`contracts/tools/${family}/${id}.json`, "utf8");
      tools.push(JSON.parse(toolRaw));
    }
  }
  assert.equal(tools.length, 112);

  for (const tool of tools) {
    const isP1 = tool.side_effect === "none";
    
    // Provide some safe dummy arguments so we don't fail argument validation
    const args = { path: ".", query: "foo", url: "https://example.com" };
    const executed = await runtime.execute(call(tool.id, tool.version, args, workspace));

    if (!isP1) {
      assert.equal(executed.result.status, "denied", `Tool ${tool.id} should be denied`);
      assert.equal((executed.result.error as any).code, "P1_WRITE_FORBIDDEN", `Tool ${tool.id} should throw P1_WRITE_FORBIDDEN`);
    } else {
      // P1 tools should either succeed, throw UNSUPPORTED, or fail due to dummy arguments (but NOT throw P1_WRITE_FORBIDDEN)
      if (executed.result.status === "denied") {
        assert.notEqual((executed.result.error as any).code, "P1_WRITE_FORBIDDEN", `P1 Tool ${tool.id} should NOT throw P1_WRITE_FORBIDDEN`);
      }
    }
  }
});

test("Canonical User-Tools compile to valid DAGs", async () => {
  for (const name of ["inspect", "research", "audit"]) {
    const spec = await loadUserTool(name as any);
    const compiled = compileWorkflow(spec);
    assert.ok(compiled.nodes.length > 0, `${name} DAG should have nodes`);
  }
});


