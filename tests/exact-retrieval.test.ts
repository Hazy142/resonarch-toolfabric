import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyChain} from "../src/evidence/receipt.js";
import {ReadPlaneRuntime, type ToolCall} from "../src/runtime/readPlane.js";

async function fixture(): Promise<{workspace: string; artifacts: string}> {
  const root = await mkdtemp(join(tmpdir(), "toolfabric-p1c-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  await mkdir(workspace, {recursive: true});
  return {workspace, artifacts};
}

function call(toolId: string, args: Record<string, unknown>, workspace: string, suffix: string): ToolCall {
  return {
    schema: "resonarch.toolfabric.call/v1",
    call_id: "p1c-" + suffix,
    task_id: "p1c-task",
    trace_id: "p1c-trace",
    tool: {id: toolId, version: "1.0.0"},
    arguments: args,
    scope: {workspace_root: workspace},
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

const records = [
  {
    id: "call:alpha",
    kind: "call",
    keys: ["src/math.ts", "abc123"],
    text: "Closed fs.read call for alpha beta evidence.",
    metadata: {status: "succeeded"},
  },
  {
    id: "call:beta",
    kind: "call",
    keys: ["src/other.ts", "def456"],
    text: "Beta alpha verification record.",
    metadata: {status: "succeeded"},
  },
  {
    id: "artifact:gamma",
    kind: "artifact",
    keys: ["artifact://sha256:gamma"],
    text: "Raw gamma evidence only.",
    metadata: {status: "observed"},
  },
] as const;

test("P1C memory.get returns an exact record from the immutable read snapshot", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const executed = await runtime.execute(call("memory.get", {id: "call:alpha"}, workspace, "get"));
  assert.equal(executed.result.status, "succeeded");
  const output = executed.result.output as {
    record: {id: string; kind: string; text: string};
    snapshot_digest: string;
  };
  assert.equal(output.record.id, "call:alpha");
  assert.equal(output.record.kind, "call");
  assert.match(output.snapshot_digest, /^sha256:[0-9a-f]{64}$/);
});

test("P1C exact retrieval is case-sensitive and matches only declared ids or keys", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const exact = await runtime.execute(call("memory.search_exact", {query: "abc123", mode: "exact"}, workspace, "exact"));
  const differentCase = await runtime.execute(call("memory.search_exact", {query: "ABC123", mode: "exact"}, workspace, "case"));
  assert.equal(exact.result.status, "succeeded");
  assert.deepEqual(
    (exact.result.output as {hits: Array<{id: string; match: string}>}).hits.map(hit => [hit.id, hit.match]),
    [["call:alpha", "key"]],
  );
  assert.deepEqual((differentCase.result.output as {hits: unknown[]}).hits, []);
});

test("P1C lexical retrieval requires whole query terms and ranks phrase hits deterministically", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const first = await runtime.execute(call("memory.search_exact", {query: "alpha beta", mode: "lexical"}, workspace, "lexical-1"));
  const second = await runtime.execute(call("memory.search_exact", {query: "ALPHA BETA", mode: "lexical"}, workspace, "lexical-2"));
  const prefix = await runtime.execute(call("memory.search_exact", {query: "alph", mode: "lexical"}, workspace, "lexical-prefix"));
  assert.equal(first.result.status, "succeeded");
  const a = first.result.output as {hits: Array<{id: string; match: string; score: number}>; snapshot_digest: string};
  const b = second.result.output as typeof a;
  assert.deepEqual(a.hits.map(hit => [hit.id, hit.match]), [
    ["call:alpha", "phrase"],
    ["call:beta", "all_terms"],
  ]);
  assert.deepEqual(a.hits, b.hits);
  assert.equal(a.snapshot_digest, b.snapshot_digest);
  assert.deepEqual((prefix.result.output as {hits: unknown[]}).hits, []);
});

test("P1C exact retrieval validates query mode and limit fail-closed", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const blank = await runtime.execute(call("memory.search_exact", {query: "   "}, workspace, "blank"));
  const mode = await runtime.execute(call("memory.search_exact", {query: "alpha", mode: "semantic"}, workspace, "mode"));
  const limit = await runtime.execute(call("memory.search_exact", {query: "alpha", limit: 0}, workspace, "limit"));
  for (const executed of [blank, mode, limit]) {
    assert.equal(executed.result.status, "denied");
    assert.equal((executed.result.error as {code: string}).code, "INVALID_ARGUMENT");
  }
  assert.equal(verifyChain([blank.receipt, mode.receipt, limit.receipt]), true);
});

test("P1C result mutation cannot alter the immutable memory snapshot", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const first = await runtime.execute(call("memory.get", {id: "call:alpha"}, workspace, "immutability-1"));
  const firstOutput = first.result.output as {
    record: {keys: string[]; metadata: {status: string}};
    snapshot_digest: string;
  };
  firstOutput.record.keys.push("poison");
  firstOutput.record.metadata.status = "tampered";

  const second = await runtime.execute(call("memory.get", {id: "call:alpha"}, workspace, "immutability-2"));
  const secondOutput = second.result.output as typeof firstOutput;
  assert.deepEqual(secondOutput.record.keys, ["src/math.ts", "abc123"]);
  assert.equal(secondOutput.record.metadata.status, "succeeded");
  assert.equal(secondOutput.snapshot_digest, firstOutput.snapshot_digest);
});

test("P1C snapshot digest and hit ordering do not depend on seed order", async () => {
  const {workspace, artifacts} = await fixture();
  const forward = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const reverse = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: [...records].reverse()});
  const a = await forward.execute(call("memory.search_exact", {query: "alpha", mode: "lexical"}, workspace, "order-a"));
  const b = await reverse.execute(call("memory.search_exact", {query: "alpha", mode: "lexical"}, workspace, "order-b"));
  assert.deepEqual(a.result.output, b.result.output);
});

test("P1C lexical retrieval supports explicit kind filters and bounded result windows", async () => {
  const {workspace, artifacts} = await fixture();
  const runtime = await ReadPlaneRuntime.create({artifactRoot: artifacts, memoryRecords: records});
  const calls = await runtime.execute(call(
    "memory.search_exact",
    {query: "alpha", mode: "lexical", kind: "call", limit: 1},
    workspace,
    "filter-calls",
  ));
  const artifactsOnly = await runtime.execute(call(
    "memory.search_exact",
    {query: "alpha", mode: "lexical", kind: "artifact"},
    workspace,
    "filter-artifacts",
  ));
  const output = calls.result.output as {hits: Array<{id: string}>; total_hits: number; kind: string};
  assert.equal(output.kind, "call");
  assert.equal(output.total_hits, 2);
  assert.deepEqual(output.hits.map(hit => hit.id), ["call:alpha"]);
  assert.deepEqual((artifactsOnly.result.output as {hits: unknown[]}).hits, []);
});

test("P1C rejects duplicate memory ids before serving calls", async () => {
  const {artifacts} = await fixture();
  await assert.rejects(
    () => ReadPlaneRuntime.create({
      artifactRoot: artifacts,
      memoryRecords: [
        {id: "duplicate", kind: "call", text: "one"},
        {id: "duplicate", kind: "call", text: "two"},
      ],
    }),
    /DUPLICATE_MEMORY_ID/,
  );
});
