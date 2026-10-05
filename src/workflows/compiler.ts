import {readFile} from "node:fs/promises";
import YAML from "yaml";
export interface UserToolSpec{schema:"resonarch.toolfabric.user-tool/v1";id:string;version:string;intent:string;preflight:string[];required_capabilities:string[];graph:string[];required_gates:string[];failure_routes:string[];default_budget:{tool_calls:number;wall_seconds:number};completion:{require:string[]};}
export interface CompiledNode{index:number;tool:string;depends_on:number[];}
export interface CompiledWorkflow{id:string;nodes:CompiledNode[];gates:string[];}
export async function loadUserTool(id:string):Promise<UserToolSpec>{
 const value=YAML.parse(await readFile("user-tools/"+id+".yaml","utf8"));
 if(value?.schema!=="resonarch.toolfabric.user-tool/v1"||value?.id!==id)throw new Error("INVALID_USER_TOOL");
 if(!Array.isArray(value.graph)||value.graph.length===0)throw new Error("EMPTY_USER_TOOL_GRAPH");
 return value as UserToolSpec;
}
export function compileWorkflow(spec:UserToolSpec):CompiledWorkflow{
 const steps=[...spec.preflight,...spec.graph];
 return {id:spec.id,nodes:steps.map((tool,index)=>({index,tool,depends_on:index?[index-1]:[]})),gates:[...spec.required_gates]};
}
