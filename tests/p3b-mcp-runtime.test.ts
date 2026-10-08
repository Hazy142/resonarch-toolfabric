import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {sha256} from "../src/contracts/canonical.js";
import {ToolFabricMcpRuntime} from "../src/mcp/runtime.js";
import {serveToolFabricHttp} from "../src/mcp/server.js";

const registryRoot = resolve("contracts/tools");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p3b-mcp-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(workspace);
  await mkdir(artifacts);
  return {root, workspace, artifacts};
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as {
    result: {status: string; output: unknown; error: null | {code: string; message: string}};
    receipts: Array<Record<string, unknown>>;
  };
}

test("P3B external stdio MCP client discovers only authorized real tools and executes guarded mutation", async () => {
  const f = await fixture();
  const configPath = join(f.root, "mcp.json");
  const target = join(f.workspace, "sample.txt");
  const original = new TextEncoder().encode("old value\n");
  await writeFile(target, original);
  await writeFile(configPath, JSON.stringify({
    workspace_root: f.workspace,
    artifact_root: f.artifacts,
    registry_root: registryRoot,
    authority: {
      capabilities: ["fs:read", "fs:write", "code:write"],
      approved_refs: ["approval:test"],
      require_approval: true,
    },
    allow_tools: ["fs.read", "fs.patch", "code.edit"],
  }));

  const client = new Client(
    {name: "toolfabric-p3b-test-client", version: "1.0.0"},
    {versionNegotiation: {mode: {pin: "2026-07-28"}}},
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/cli.js"), "mcp", "stdio", "--config", configPath],
    cwd: process.cwd(),
  });

  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ["fs.patch", "fs.read"]);
    const patchSchema = listed.tools.find(tool => tool.name === "fs.patch")!.inputSchema as Record<string, unknown>;
    assert.ok((patchSchema.properties as Record<string, unknown>)._toolfabric);

    const denied = await client.callTool({
      name: "fs.patch",
      arguments: {path: "sample.txt", old_text: "old", new_text: "new"},
    });
    assert.equal(denied.isError, true);
    assert.equal(structured(denied).result.status, "denied");
    assert.deepEqual(await readFile(target), Buffer.from(original));

    const fakeApproval = await client.callTool({
      name: "fs.patch",
      arguments: {
        path: "sample.txt",
        old_text: "old",
        new_text: "new",
        _toolfabric: {
          approval_ref: "approval:self-granted",
          expected_state: {exists: true, sha256: sha256(original)},
        },
      },
    });
    assert.equal(fakeApproval.isError, true);
    assert.equal(structured(fakeApproval).result.error?.code, "APPROVAL_DENIED");
    assert.deepEqual(await readFile(target), Buffer.from(original));

    const succeeded = await client.callTool({
      name: "fs.patch",
      arguments: {
        path: "sample.txt",
        old_text: "old",
        new_text: "new",
        _toolfabric: {
          approval_ref: "approval:test",
          expected_state: {exists: true, sha256: sha256(original)},
        },
      },
    });
    const envelope = structured(succeeded);
    assert.equal(succeeded.isError, undefined);
    assert.equal(envelope.result.status, "succeeded");
    assert.equal(envelope.receipts.length, 2);
    assert.match(String(envelope.receipts[1].receipt_hash), /^sha256:[0-9a-f]{64}$/);
    assert.equal(await readFile(target, "utf8"), "new value\n");

    const read = await client.callTool({name: "fs.read", arguments: {path: "sample.txt"}});
    assert.equal(structured(read).result.status, "succeeded");
    assert.equal(structured(read).receipts.length, 1);
  } finally {
    await client.close().catch(() => {});
    await rm(f.root, {recursive: true, force: true});
  }
});

test("P3B Streamable HTTP speaks modern MCP on loopback and preserves ToolFabric receipts", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "note.txt"), "hello");
  const runtime = await ToolFabricMcpRuntime.create({
    workspace_root: f.workspace,
    artifact_root: f.artifacts,
    registry_root: registryRoot,
    authority: {capabilities: ["fs:read"], require_approval: true},
    allow_tools: ["fs.read"],
  });
  const handle = await serveToolFabricHttp(runtime, {port: 0});
  const client = new Client(
    {name: "toolfabric-http-test-client", version: "1.0.0"},
    {versionNegotiation: {mode: {pin: "2026-07-28"}}},
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["fs.read"]);
    const result = structured(await client.callTool({name: "fs.read", arguments: {path: "note.txt"}}));
    assert.equal(result.result.status, "succeeded");
    assert.equal(result.receipts.length, 1);
    assert.match(String(result.receipts[0].receipt_hash), /^sha256:[0-9a-f]{64}$/);
  } finally {
    await client.close().catch(() => {});
    await handle.close().catch(() => {});
    await rm(f.root, {recursive: true, force: true});
  }
});

test("P3B HTTP refuses non-loopback exposure before authenticated remote serving exists", async () => {
  const f = await fixture();
  try {
    const runtime = await ToolFabricMcpRuntime.create({
      workspace_root: f.workspace,
      artifact_root: f.artifacts,
      registry_root: registryRoot,
      authority: {capabilities: ["fs:read"], require_approval: true},
      allow_tools: ["fs.read"],
    });
    await assert.rejects(
      serveToolFabricHttp(runtime, {host: "0.0.0.0", port: 0}),
      /loopback-only/,
    );
  } finally {
    await rm(f.root, {recursive: true, force: true});
  }
});
