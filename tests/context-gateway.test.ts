import test from "node:test";
import assert from "node:assert/strict";
import {compactClosedTools} from "../src/context/compaction.js";
import {createReceipt} from "../src/evidence/receipt.js";
import {receiptToToolHistory, toolHistoryToMemoryRecords} from "../src/context/gatewayInterop.js";
import {ExactMemorySnapshot} from "../src/runtime/exactMemory.js";

test("gateway bridge projects canonical receipt evidence into WARM history",()=>{
  const artifact="artifact://sha256:"+"a".repeat(64);
  const receipt=createReceipt({
    schema:"resonarch.toolfabric.receipt/v1",
    receipt_id:"r1",
    trace_id:"trace",
    task_id:"task",
    call_id:"call-1",
    tool_id:"fs.read",
    tool_version:"1.0.0",
    request_digest:"sha256:req",
    result_digest:"sha256:result",
    side_effect:"none",
    status:"succeeded",
    previous_receipt_hash:"sha256:GENESIS",
    artifact_refs:[artifact],
  });
  const history=receiptToToolHistory(receipt);
  const compacted=compactClosedTools([history]);
  assert.equal(compacted.hot.length,0);
  assert.deepEqual(compacted.warm,[{
    call_id:"call-1",
    tool:"fs.read",
    args_digest:"sha256:req",
    result_digest:"sha256:result",
    artifact_refs:[artifact],
  }]);
});

test("gateway bridge rejects non-canonical artifact references",()=>{
  const receipt=createReceipt({
    schema:"resonarch.toolfabric.receipt/v1",
    receipt_id:"r2",
    trace_id:"trace",
    task_id:"task",
    call_id:"call-2",
    tool_id:"fs.read",
    tool_version:"1.0.0",
    request_digest:"sha256:req",
    result_digest:"sha256:result",
    side_effect:"none",
    status:"succeeded",
    previous_receipt_hash:"sha256:GENESIS",
    artifact_refs:["artifact://../../outside"],
  });
  assert.throws(()=>receiptToToolHistory(receipt),/INVALID_GATEWAY_ARTIFACT_REF/);
});

test("gateway bridge projects WARM history into canonical P1 memory records",()=>{
  const artifact="artifact://sha256:"+"b".repeat(64);
  const receipt=createReceipt({
    schema:"resonarch.toolfabric.receipt/v1",
    receipt_id:"r3",
    trace_id:"trace",
    task_id:"task",
    call_id:"call-memory",
    tool_id:"git.status",
    tool_version:"1.0.0",
    request_digest:"sha256:req-memory",
    result_digest:"sha256:result-memory",
    side_effect:"none",
    status:"succeeded",
    previous_receipt_hash:"sha256:GENESIS",
    artifact_refs:[artifact],
  });
  const history=receiptToToolHistory(receipt);
  const [record]=toolHistoryToMemoryRecords([history]);
  assert.deepEqual(record,{
    id:"call:call-memory",
    kind:"tool_history",
    keys:["call-memory","git.status","sha256:req-memory","sha256:result-memory",artifact],
    text:[
      "tool=git.status",
      "state=closed",
      "args_digest=sha256:req-memory",
      "result_digest=sha256:result-memory",
      "artifact_ref="+artifact,
    ].join("\n"),
    metadata:{
      call_id:"call-memory",
      tool:"git.status",
      state:"closed",
      artifact_refs:[artifact],
    },
  });
});

test("gateway retrieval projection excludes open or incomplete calls and validates closed artifact refs",()=>{
  assert.deepEqual(toolHistoryToMemoryRecords([
    {call_id:"open",tool:"process.start",state:"open",args_digest:"sha256:open",artifact_refs:["artifact://../../ignored"]},
    {call_id:"incomplete",tool:"fs.read",state:"closed",args_digest:"sha256:args",artifact_refs:[]},
  ]),[]);
  assert.throws(()=>toolHistoryToMemoryRecords([{
    call_id:"closed",
    tool:"fs.read",
    state:"closed",
    args_digest:"sha256:args",
    result_digest:"sha256:result",
    artifact_refs:["artifact://../../outside"],
  }]),/INVALID_GATEWAY_ARTIFACT_REF/);
});

test("gateway-projected memory records are retrievable by artifact ref and lexical tool id",()=>{
  const artifact="artifact://sha256:"+"c".repeat(64);
  const records=toolHistoryToMemoryRecords([{
    call_id:"call-searchable",
    tool:"git.status",
    state:"closed",
    args_digest:"sha256:args-searchable",
    result_digest:"sha256:result-searchable",
    artifact_refs:[artifact],
  }]);
  const snapshot=new ExactMemorySnapshot(records);
  const exact=snapshot.search({query:artifact,mode:"exact"}) as {hits:Array<{id:string;match:string}>};
  const lexical=snapshot.search({query:"git.status",mode:"lexical"}) as {hits:Array<{id:string}>};
  assert.deepEqual(exact.hits.map(hit=>[hit.id,hit.match]),[["call:call-searchable","key"]]);
  assert.deepEqual(lexical.hits.map(hit=>hit.id),["call:call-searchable"]);
});
