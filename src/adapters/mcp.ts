import type {ToolDescriptor,ResultStatus} from "../contracts/types.js";
import type {CanonicalAdapter} from "./base.js";
import {canonicalFunctionShape,normalizeStatus} from "./base.js";
export class McpAdapter implements CanonicalAdapter{
 readonly id="mcp";readonly version="0.1.0";
 project(tool:ToolDescriptor):unknown{return canonicalFunctionShape(tool);}
 normalize(result:unknown):{status:ResultStatus;output:unknown}{const value=(result??{}) as Record<string,unknown>;return {status:normalizeStatus(value.status),output:value.output??result};}
}
