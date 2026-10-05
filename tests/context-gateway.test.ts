import test from "node:test";
import assert from "node:assert/strict";
import {compactClosedTools} from "../src/context/compaction.js";
import {createReceipt} from "../src/evidence/receipt.js";
import {receiptToToolHistory} from "../src/context/gatewayInterop.js";

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
