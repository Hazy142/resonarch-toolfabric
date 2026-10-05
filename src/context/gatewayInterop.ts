import type {Receipt} from "../evidence/receipt.js";
import type {ToolHistory} from "./compaction.js";

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
