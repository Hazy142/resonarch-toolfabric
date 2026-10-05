import type {Receipt} from "../evidence/receipt.js";
import type {ToolHistory} from "./compaction.js";
import type {ReadMemoryRecord} from "./retrieval.js";

const ARTIFACT_REF = /^artifact:\/\/sha256:[0-9a-f]{64}$/;

export function assertGatewayArtifactRef(ref:string):string{
  if(!ARTIFACT_REF.test(ref)) throw new Error("INVALID_GATEWAY_ARTIFACT_REF");
  return ref;
}

export function receiptToToolHistory(receipt:Receipt):ToolHistory{
  const artifact_refs=receipt.artifact_refs.map(assertGatewayArtifactRef);
  return {
    call_id:receipt.call_id,
    tool:receipt.tool_id,
    state:"closed",
    args_digest:receipt.request_digest,
    result_digest:receipt.result_digest,
    artifact_refs,
  };
}

export function receiptsToToolHistory(receipts:readonly Receipt[]):ToolHistory[]{
  return receipts.map(receiptToToolHistory);
}

export function toolHistoryToMemoryRecords(items:readonly ToolHistory[]):ReadMemoryRecord[]{
  const records:ReadMemoryRecord[]=[];
  for(const item of items){
    if(item.state!=="closed"||!item.result_digest) continue;
    const artifact_refs=item.artifact_refs.map(assertGatewayArtifactRef);
    const keys=[item.call_id,item.tool,item.args_digest,item.result_digest,...artifact_refs]
      .filter((value,index,all)=>all.indexOf(value)===index);
    records.push({
      id:`call:${item.call_id}`,
      kind:"tool_history",
      keys,
      text:[
        `tool=${item.tool}`,
        "state=closed",
        `args_digest=${item.args_digest}`,
        `result_digest=${item.result_digest}`,
        ...artifact_refs.map(ref=>`artifact_ref=${ref}`),
      ].join("\n"),
      metadata:{
        call_id:item.call_id,
        tool:item.tool,
        state:"closed",
        artifact_refs,
      },
    });
  }
  return records;
}
