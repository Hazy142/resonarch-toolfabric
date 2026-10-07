import test from "node:test";
import {readFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ReadPlaneRuntime, type ToolCall} from "../src/runtime/readPlane.js";
import {loadUserTool, compileWorkflow} from "../src/workflows/compiler.js";

const execFile = promisify(execFileCallback);

async function makeFixture(): Promise<{workspace: string; artifacts: string}> {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p1-boundary-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(join(workspace, "src"), {recursive: true});
  await writeFile(join(workspace, "AGENTS.md"), "# root rules\n", "utf8");
  await writeFile(join(workspace, "src", "index.ts"), "export function hello(): string { return 'world'; }\n", "utf8");
  await execFile("git", ["init"], {cwd: workspace});
  await execFile("git", ["config", "user.email", "fixture@example.invalid"], {cwd: workspace});
  await execFile("git", ["config", "user.name", "ToolFabric Fixture"], {cwd: workspace});
  await execFile("git", ["add", "."], {cwd: workspace});
  await execFile("git", ["commit", "-m", "fixture"], {cwd: workspace});
  return {workspace, artifacts};
}

function call(toolId: string, toolVersion: string, args: Record<string, unknown>, workspace: string): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: `call-${toolId}-${Math.random().toString(36).slice(2, 7)}`,
    task_id: "task-p1-boundary",
    trace_id: "trace-p1-boundary",
    tool: {id: toolId, version: toolVersion},
    arguments: args,
    scope: {workspace_root: workspace},
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("P1_READ_BOUNDARY_PASS exhaustively partitions and gates all 112 tools", async () => {
  const {workspace, artifacts} = await makeFixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts});
  const source = JSON.parse(await readFile("contracts/tools/registry.source.json", "utf8"));
  const vector = JSON.parse(await readFile("conformance/vectors/p1-read-boundary-pass.json", "utf8"));

  assert.equal(vector.schema, "resonarch.toolfabric.conformance-vector/v1");
  assert.deepEqual(vector.claims, ["P1_READ_BOUNDARY_PASS"]);
  assert.ok(vector.non_claims.includes("P1_READ_PLANE_PASS"));

  const allowed = new Set<string>(vector.p1_allowed_tools);
  const implemented = new Set<string>(vector.implemented_tools);
  const unsupported = new Set<string>(vector.unsupported_tools);

  assert.equal(implemented.size + unsupported.size, allowed.size);
  for (const id of implemented) assert.ok(allowed.has(id), `${id} implemented but not P1-allowed`);
  for (const id of unsupported) {
    assert.ok(allowed.has(id), `${id} unsupported but not P1-allowed`);
    assert.ok(!implemented.has(id), `${id} cannot be both implemented and unsupported`);
  }

  const tools: any[] = [];
  for (const [family, ids] of Object.entries(source.families)) {
    for (const id of ids as string[]) {
      tools.push(JSON.parse(await readFile(`contracts/tools/${family}/${id}.json`, "utf8")));
    }
  }
  assert.equal(tools.length, 112);

  const registryAllowed = new Set(tools.filter(tool => tool.side_effect === "none").map(tool => tool.id));
  assert.deepEqual([...allowed].sort(), [...registryAllowed].sort());

  for (const tool of tools) {
    const args = {path: ".", query: "foo", url: "https://example.com"};
    const executed = await runtime.execute(call(tool.id, tool.version, args, workspace));

    if (tool.side_effect !== "none") {
      assert.equal(executed.result.status, "denied", `${tool.id} must be denied at P1 boundary`);
      assert.equal(executed.result.error?.code, "P1_WRITE_FORBIDDEN", `${tool.id} must fail with P1_WRITE_FORBIDDEN`);
      continue;
    }

    if (unsupported.has(tool.id)) {
      assert.equal(executed.result.error?.code, "UNSUPPORTED", `${tool.id} must explicitly report UNSUPPORTED`);
      continue;
    }

    assert.ok(implemented.has(tool.id), `${tool.id} must be classified as implemented or unsupported`);
    assert.notEqual(executed.result.error?.code, "UNSUPPORTED", `${tool.id} is listed implemented but reports UNSUPPORTED`);
    assert.notEqual(executed.result.error?.code, "P1_WRITE_FORBIDDEN", `${tool.id} is a read and must not hit the write barrier`);
  }
});

test("canonical inspect/research/audit specs compile without claiming E2E execution", async () => {
  for (const name of ["inspect", "research", "audit"]) {
    const spec = await loadUserTool(name);
    const compiled = compileWorkflow(spec);
    assert.ok(compiled.nodes.length > 0, `${name} DAG should have nodes`);
    assert.equal(compiled.id, spec.id);
  }
});
