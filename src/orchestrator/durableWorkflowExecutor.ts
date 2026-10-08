import {randomUUID} from "node:crypto";
import {reconcileFileEvidence,assertEvidence,type StepEvidence} from "./stepReconciliation.js";
import {canonicalDigest,canonicalJson} from "../contracts/canonical.js";
import {OperationJournal} from "../evidence/operationJournal.js";
import type {Receipt} from "../evidence/receipt.js";
import {RuntimeExecutionError} from "../runtime/errors.js";
import type {ToolCall,ToolResult} from "../runtime/readPlane.js";

export interface WorkflowStep {id:string;call:ToolCall;depends_on:string[];reconciliation?:StepEvidence;}
export interface WorkflowDefinition {id:string;steps:WorkflowStep[];}
export interface WorkflowExecution {workflow_id:string;state:"completed"|"blocked"|"uncertain";completed:string[];blocked_step?:string;results:Record<string,ToolResult>;receipts:Record<string,Receipt[]>;}
export type WorkflowStepHandler=(call:ToolCall)=>Promise<{result:ToolResult;receipts:Receipt[]}>;
export type WorkflowPhase="before_dispatch"|"after_dispatch"|"after_publish";
export interface WorkflowExecutorOptions {
  journal:OperationJournal;
  handlers:Readonly<Record<string,WorkflowStepHandler>>;
  on_phase?:(phase:WorkflowPhase,step:WorkflowStep)=>void|Promise<void>;
}
const MUTATING=new Set(["fs.write","fs.patch","fs.move","git.branch","git.worktree","git.commit","process.start","process.input","process.stop","test.run"]);
function validate(def:WorkflowDefinition):void {
  if(!def.id||def.id.length>100||!Array.isArray(def.steps)||def.steps.length<1||def.steps.length>128)throw new RuntimeExecutionError("INVALID_WORKFLOW","workflow requires bounded id and steps","denied");
  const seen=new Set<string>();let task:string|undefined;
  for(const step of def.steps){
    if(!step.id||step.id.length>100||seen.has(step.id)||!Array.isArray(step.depends_on)||step.depends_on.some(x=>!seen.has(x)))throw new RuntimeExecutionError("INVALID_WORKFLOW_DAG","steps must have unique ids and earlier dependencies","denied");
    seen.add(step.id);
    if(step.reconciliation)assertEvidence(step.reconciliation);
    const c=step.call;
    if(c?.schema!=="resonarch.toolfabric.call/v1"||!c.task_id||!c.trace_id||!c.call_id||!c.scope?.workspace_root||!c.tool?.version||!c.tool.id)throw new RuntimeExecutionError("INVALID_WORKFLOW_CALL","all calls must be fully bound","denied");
    if(task===undefined)task=c.task_id;
    if(c.task_id!==task)throw new RuntimeExecutionError("WORKFLOW_TASK_MISMATCH","all steps must share one task","denied");
  }
}
export class DurableWorkflowExecutor {
  private readonly owner=randomUUID();
  private readonly running=new Set<string>();
  constructor(private readonly options:WorkflowExecutorOptions){}
  private operation(id:string,step:string):string{return "workflow:"+canonicalDigest({id,step}).slice(7);}
  async execute(def:WorkflowDefinition):Promise<WorkflowExecution> {
    validate(def);
    if(this.running.has(def.id))throw new RuntimeExecutionError("WORKFLOW_BUSY","this executor already runs workflow","denied");
    this.running.add(def.id);
    try {return await this.executeOne(def);}finally{this.running.delete(def.id);}
  }
  private async executeOne(def:WorkflowDefinition):Promise<WorkflowExecution>{
    const digest=canonicalDigest(def);
    const root=this.operation(def.id,"manifest");
    const existing=this.options.journal.reserve(root,digest,{workflow_id:def.id,definition:def});
    if(existing.record.state!=="published"){
      if(!existing.created)throw new RuntimeExecutionError("WORKFLOW_MANIFEST_UNCERTAIN","manifest admission was interrupted","denied");
      const lease=this.options.journal.claim(root,this.owner,120000);
      this.options.journal.publish(root,lease,{digest});
    }
    const completed:string[]=[];const results:Record<string,ToolResult>={};const receipts:Record<string,Receipt[]>={};
    for(const step of def.steps){
      for(const dep of step.depends_on)if(!completed.includes(dep))throw new RuntimeExecutionError("UNSATISFIED_DEPENDENCY","dependency has not succeeded","denied");
      const op=this.operation(def.id,step.id);
      const semantic=canonicalDigest({manifest:digest,step});
      const reservation=this.options.journal.reserve(op,semantic,{workflow_id:def.id,step_id:step.id,call:step.call});
      if(reservation.record.state==="published"){
        const prior=reservation.record.result as {result:ToolResult;receipts:Receipt[]};
        if(!prior?.result||!Array.isArray(prior.receipts))throw new RuntimeExecutionError("INVALID_WORKFLOW_RESULT","published result is incomplete","denied");
        results[step.id]=prior.result;receipts[step.id]=prior.receipts;
        if(prior.result.status!=="succeeded")return {workflow_id:def.id,state:prior.result.status==="uncertain"?"uncertain":"blocked",completed,blocked_step:step.id,results,receipts};
        completed.push(step.id);continue;
      }
      // Never redispatch an admitted mutation without independently proven reconciliation.
      if(!reservation.created){
        if(reservation.record.state==="started"&&step.reconciliation){
          await reconcileFileEvidence(step.call,step.reconciliation);
          // Evidence alone cannot replace the runtime result/receipt: remain uncertain.
          return {workflow_id:def.id,state:"uncertain",completed,blocked_step:step.id,results,receipts};
        }
        return {workflow_id:def.id,state:"uncertain",completed,blocked_step:step.id,results,receipts};
      }
      const handler=this.options.handlers[step.call.tool.id];
      if(!handler)throw new RuntimeExecutionError("WORKFLOW_TOOL_UNAVAILABLE","missing host-registered handler for "+step.call.tool.id,"denied");
      const lease=this.options.journal.claim(op,this.owner,120000);
      this.options.journal.update(op,lease,"prepared",{tool:step.call.tool.id,call_digest:canonicalDigest(step.call)});
      await this.options.on_phase?.("before_dispatch",step);
      this.options.journal.update(op,lease,"started",{dispatch_started:true});
      let outcome:{result:ToolResult;receipts:Receipt[]};
      try{outcome=await handler(step.call);}
      catch(error){this.options.journal.update(op,lease,"uncertain",{dispatch_error:error instanceof Error?error.message:String(error)});return {workflow_id:def.id,state:"uncertain",completed,blocked_step:step.id,results,receipts};}
      if(!outcome?.result||outcome.result.call_id!==step.call.call_id||!Array.isArray(outcome.receipts)||outcome.receipts.length===0||outcome.receipts.some((r,i)=>r.call_id!==step.call.call_id||r.receipt_hash!==canonicalDigest(Object.fromEntries(Object.entries(r).filter(([k])=>k!=="receipt_hash"))))) {
        this.options.journal.update(op,lease,"uncertain",{reason:"invalid_result_or_receipt"});
        return {workflow_id:def.id,state:"uncertain",completed,blocked_step:step.id,results,receipts};
      }
      await this.options.on_phase?.("after_dispatch",step);
      const published=this.options.journal.publish(op,lease,{result:outcome.result,receipts:outcome.receipts});
      await this.options.on_phase?.("after_publish",step);
      const saved=published.result as {result:ToolResult;receipts:Receipt[]};
      results[step.id]=saved.result;receipts[step.id]=saved.receipts;
      if(saved.result.status!=="succeeded")return {workflow_id:def.id,state:saved.result.status==="uncertain"?"uncertain":"blocked",completed,blocked_step:step.id,results,receipts};
      completed.push(step.id);
    }
    return {workflow_id:def.id,state:"completed",completed,results,receipts};
  }
}
