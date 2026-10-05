import {canonicalDigest} from "../contracts/canonical.js";
export interface ReceiptInput{schema:"resonarch.toolfabric.receipt/v1";receipt_id:string;trace_id:string;task_id:string;call_id:string;tool_id:string;tool_version:string;request_digest:string;result_digest:string;side_effect:string;status:string;previous_receipt_hash:string;artifact_refs:string[];[key:string]:unknown;}
export interface Receipt extends ReceiptInput{receipt_hash:string;}
export function createReceipt(input:ReceiptInput):Receipt{const receipt_hash=canonicalDigest(input);return {...input,receipt_hash};}
export function verifyChain(receipts:readonly Receipt[]):boolean{
 let previous="sha256:GENESIS";
 for(const receipt of receipts){if(receipt.previous_receipt_hash!==previous)return false;const {receipt_hash,...rest}=receipt;if(canonicalDigest(rest)!==receipt_hash)return false;previous=receipt_hash;}
 return true;
}
export function sideEffectOutcome(state:{committed:boolean;knownFailure:boolean}):"succeeded"|"failed"|"uncertain"{if(state.committed)return "succeeded";if(state.knownFailure)return "failed";return "uncertain";}
