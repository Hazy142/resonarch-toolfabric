import type {ToolDescriptor,ResultStatus} from "../contracts/types.js";
export interface CanonicalAdapter{readonly id:string;readonly version:string;project(tool:ToolDescriptor):unknown;normalize(result:unknown):{status:ResultStatus;output:unknown};}
export function canonicalFunctionShape(tool:ToolDescriptor){return {name:tool.id.replace(/\./g,"__"),description:tool.summary,parameters:tool.input_schema};}
export function normalizeStatus(value:unknown):ResultStatus{const allowed=new Set(["succeeded","failed","denied","cancelled","partial","uncertain"]);return allowed.has(String(value))?value as ResultStatus:"failed";}
