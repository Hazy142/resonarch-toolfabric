import type {ToolDescriptor} from "./types.js";
const RISKS=new Set(["R0","R1","R2","R3","R4"]);
const EFFECTS=new Set(["none","local","process","filesystem","repository","external","release","projection"]);
const IDEMPOTENCY=new Set(["pure","idempotent","conditional","non_idempotent"]);
const NETWORK=new Set(["forbidden","optional","required"]);
const RECEIPT=new Set(["required","optional","forbidden"]);

export function assertToolDescriptor(value:unknown):asserts value is ToolDescriptor{
 if(!value||typeof value!=="object") throw new TypeError("INVALID_TOOL_DESCRIPTOR: object required");
 const v=value as Record<string,unknown>;
 if(v.schema!=="resonarch.toolfabric.tool/v1") throw new TypeError("INVALID_TOOL_DESCRIPTOR: schema");
 if(typeof v.id!=="string"||v.id.length<3||!v.id.includes(".")) throw new TypeError("INVALID_TOOL_DESCRIPTOR: id");
 if(typeof v.version!=="string") throw new TypeError("INVALID_TOOL_DESCRIPTOR: version");
 if(typeof v.title!=="string"||typeof v.summary!=="string") throw new TypeError("INVALID_TOOL_DESCRIPTOR: text");
 if(!Array.isArray(v.capabilities)||!Array.isArray(v.authority_scope)) throw new TypeError("INVALID_TOOL_DESCRIPTOR: scope");
 if(!RISKS.has(String(v.risk_class))) throw new TypeError("INVALID_TOOL_DESCRIPTOR: risk");
 if(!EFFECTS.has(String(v.side_effect))||!IDEMPOTENCY.has(String(v.idempotency))) throw new TypeError("INVALID_TOOL_DESCRIPTOR: effect");
 if(!NETWORK.has(String(v.network))||!RECEIPT.has(String(v.receipt))) throw new TypeError("INVALID_TOOL_DESCRIPTOR: policy");
 if(typeof v.default_timeout_ms!=="number"||v.default_timeout_ms<=0) throw new TypeError("INVALID_TOOL_DESCRIPTOR: timeout");
 if(typeof v.max_output_bytes!=="number"||v.max_output_bytes<0) throw new TypeError("INVALID_TOOL_DESCRIPTOR: output limit");
}
