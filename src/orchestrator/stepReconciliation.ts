import {readFile,stat} from "node:fs/promises";
import {sha256} from "../contracts/canonical.js";
import {WorkspaceBoundary} from "../runtime/workspace.js";
import {RuntimeExecutionError} from "../runtime/errors.js";
import type {ToolCall} from "../runtime/readPlane.js";

export interface SurfaceIdentity {kind:"file";path:string;exists:boolean;sha256?:string;}
export interface StepEvidence {before:SurfaceIdentity[];after:SurfaceIdentity[];}
export type ReconcileVerdict="post"|"pre"|"uncertain";

function valid(spec:SurfaceIdentity):boolean {
 return spec.kind==="file"&&typeof spec.path==="string"&&spec.path.length>0
 &&typeof spec.exists==="boolean"&&(!spec.exists ? spec.sha256===undefined : /^sha256:[0-9a-f]{64}$/.test(spec.sha256??""));
}
export function assertEvidence(value:StepEvidence):void{
 if(!value||!Array.isArray(value.before)||!Array.isArray(value.after)||!value.before.length||value.before.length!==value.after.length
 ||value.before.some(x=>!valid(x))||value.after.some(x=>!valid(x))
 ||value.before.some((x,i)=>x.path!==value.after[i].path))throw new RuntimeExecutionError("INVALID_RECONCILIATION_EVIDENCE","explicit matching pre/post file identities required","denied");
}
export async function captureFileEvidence(call:ToolCall,paths:readonly string[],before:readonly SurfaceIdentity[],after:readonly SurfaceIdentity[]):Promise<StepEvidence>{
 const evidence={before:[...before],after:[...after]};assertEvidence(evidence);
 if(paths.length!==evidence.before.length||paths.some((p,i)=>p!==evidence.before[i].path))throw new RuntimeExecutionError("EVIDENCE_PATH_MISMATCH","evidence paths differ","denied");
 await reconcileFileEvidence(call,evidence);return evidence;
}
async function current(call:ToolCall,path:string):Promise<SurfaceIdentity>{
 const boundary=await WorkspaceBoundary.create(call.scope.workspace_root);
 try{const target=await boundary.resolveExisting(path);const info=await stat(target);
 if(!info.isFile())throw new RuntimeExecutionError("RECONCILIATION_NON_FILE","only regular files can be reconciled","denied");
 return {kind:"file",path,exists:true,sha256:sha256(await readFile(target))};}
 catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {kind:"file",path,exists:false};throw e;}
}
export async function reconcileFileEvidence(call:ToolCall,evidence:StepEvidence):Promise<ReconcileVerdict>{
 assertEvidence(evidence);
 const now=await Promise.all(evidence.before.map(x=>current(call,x.path)));
 const match=(identities:SurfaceIdentity[])=>identities.every((x,i)=>x.exists===now[i].exists&&(!x.exists||x.sha256===now[i].sha256));
 const pre=match(evidence.before);const post=match(evidence.after);
 // Equal or ambiguous pre/post states never prove that a mutation happened.
 if(pre&&post)return "uncertain";
 if(post)return "post";if(pre)return "pre";return "uncertain";
}
