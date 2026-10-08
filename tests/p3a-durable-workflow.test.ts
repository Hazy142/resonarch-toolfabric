import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {OperationJournal} from "../src/evidence/operationJournal.js";
import {DurableWorkflowExecutor,type WorkflowDefinition} from "../src/orchestrator/durableWorkflowExecutor.js";
import {createReceipt} from "../src/evidence/receipt.js";
import type {ToolCall,ToolResult} from "../src/runtime/readPlane.js";
const call=(id:string,tool:string):ToolCall=>({schema:"resonarch.toolfabric.call/v1",call_id:id,task_id:"task-1",trace_id:"trace-1",tool:{id:tool,version:"2.0.0"},arguments:{},scope:{workspace_root:"/authorized"},deadline:"2099-01-01T00:00:00.000Z"});
const definition=():WorkflowDefinition=>({id:"workflow-1",steps:[{id:"read",call:call("read","fs.read"),depends_on:[]},{id:"write",call:call("write","fs.patch"),depends_on:["read"]},{id:"test",call:call("test","test.run"),depends_on:["write"]}]});
function output(c:ToolCall,status:ToolResult["status"]="succeeded") {
 const result:ToolResult={schema:"resonarch.toolfabric.result/v1",call_id:c.call_id,status,output:{ok:true},artifacts:[],diagnostics:[],timing:{started_at:"2026-01-01T00:00:00Z",finished_at:"2026-01-01T00:00:00Z",duration_ms:0},error:null};
 const receipt=createReceipt({schema:"resonarch.toolfabric.receipt/v1",receipt_id:c.call_id,trace_id:c.trace_id,task_id:c.task_id,call_id:c.call_id,tool_id:c.tool.id,tool_version:c.tool.version,request_digest:"digest",result_digest:"digest",side_effect:"none",status,previous_receipt_hash:"sha256:GENESIS",artifact_refs:[]});
 return {result,receipts:[receipt]};
}
test("durable workflow publishes step results once and replays after clean restart",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tf-p3a-"));const key=randomBytes(32);let count=0;
 try{
  const handlers=Object.fromEntries(["fs.read","fs.patch","test.run"].map(name=>[name,async(c:ToolCall)=>{count++;return output(c)}]));
  let journal=OperationJournal.open({directory:dir,namespace:"workflow-test",signing_key:key});
  const def=definition();
  assert.equal((await new DurableWorkflowExecutor({journal,handlers}).execute(def)).state,"completed");
  assert.equal(count,3);journal.close();
  journal=OperationJournal.open({directory:dir,namespace:"workflow-test",signing_key:key});
  const again=await new DurableWorkflowExecutor({journal,handlers}).execute(def);
  assert.equal(again.state,"completed");assert.equal(count,3);
  assert.equal(journal.list().filter(x=>x.state==="published").length,4);
  journal.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("crash after dispatch but before publication blocks mutation retry",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tf-p3a-"));const key=randomBytes(32);let count=0;
 try{
  let journal=OperationJournal.open({directory:dir,namespace:"workflow-test",signing_key:key});
  const handlers={"fs.read":async(c:ToolCall)=>output(c),"fs.patch":async(c:ToolCall)=>{count++;return output(c)},"test.run":async(c:ToolCall)=>output(c)};
  await assert.rejects(()=>new DurableWorkflowExecutor({journal,handlers,on_phase:(phase,step)=>{if(phase==="after_dispatch"&&step.id==="write")throw Error("simulated controller crash")}}).execute(definition()),/simulated controller crash/);
  journal.close();
  journal=OperationJournal.open({directory:dir,namespace:"workflow-test",signing_key:key});
  const resumed=await new DurableWorkflowExecutor({journal,handlers}).execute(definition());
  assert.equal(resumed.state,"uncertain");assert.equal(resumed.blocked_step,"write");assert.deepEqual(resumed.completed,["read"]);assert.equal(count,1);
  journal.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("manifest conflict rejects changed workflow under same ID",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tf-p3a-"));const key=randomBytes(32);
 try{
  const journal=OperationJournal.open({directory:dir,namespace:"workflow-test",signing_key:key});
  const handlers={"fs.read":async(c:ToolCall)=>output(c),"fs.patch":async(c:ToolCall)=>output(c),"test.run":async(c:ToolCall)=>output(c)};
  await new DurableWorkflowExecutor({journal,handlers}).execute(definition());
  const changed=definition();changed.steps[1].call.arguments={different:true};
  await assert.rejects(()=>new DurableWorkflowExecutor({journal,handlers}).execute(changed),/different semantic input/);
  journal.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
