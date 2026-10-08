import test from "node:test";
import assert from "node:assert/strict";
import {execFile as execFileCb} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomBytes,randomUUID} from "node:crypto";
import {sha256} from "../src/contracts/canonical.js";
import {OperationJournal} from "../src/evidence/operationJournal.js";
import {DurableWorkflowExecutor,type WorkflowDefinition,type WorkflowStepHandler} from "../src/orchestrator/durableWorkflowExecutor.js";
import {GitIsolationRuntime} from "../src/runtime/gitIsolation.js";
import {WritePlaneRuntime} from "../src/runtime/writePlane.js";
import {ProcessLifecycleRuntime} from "../src/runtime/processLifecycle.js";
import {bindProcessPlan} from "../src/runtime/processPlan.js";
import type {ToolCall} from "../src/runtime/readPlane.js";
const execFile=promisify(execFileCb);
async function git(cwd:string,args:string[]){return (await execFile("git",args,{cwd,windowsHide:true})).stdout.trim();}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"tf-p3a-e2e-")),workspace=join(root,"workspace"),repo=join(workspace,"repo"),artifacts=join(root,"artifacts");
 await mkdir(repo,{recursive:true});await git(repo,["init","-b","main"]);await git(repo,["config","user.name","Fixture"]);await git(repo,["config","user.email","fixture@example.invalid"]);await git(repo,["config","core.autocrlf","false"]);
 await writeFile(join(repo,"calc.cjs"),"exports.add = (a, b) => a - b;\n");await writeFile(join(repo,"calc.test.cjs"),'const test=require("node:test");const assert=require("node:assert/strict");const {add}=require("./calc.cjs");test("sum",()=>assert.equal(add(2,3),5));\n');
 await git(repo,["add","."]);await git(repo,["commit","-m","initial"]);return {root,workspace,repo,artifacts,head:await git(repo,["rev-parse","HEAD"])};
}
function call(workspace:string,tool:string,args:Record<string,unknown>,expected:Record<string,unknown>):ToolCall{return {schema:"resonarch.toolfabric.call/v1",call_id:randomUUID(),task_id:"p3a-real",trace_id:"p3a-real-trace",tool:{id:tool,version:"2.0.0"},arguments:args,expected_state:expected,approval_ref:"approval:p3a-real",scope:{workspace_root:workspace},deadline:new Date(Date.now()+120000).toISOString()};}
async function setup(){
 const f=await fixture();const authority={capabilities:["git:branch","git:worktree","git:commit","fs:write","test:run","process:host_execution"],approved_refs:["approval:p3a-real"]};
 const branch=call(f.workspace,"git.branch",{repo_path:"repo",name:"feature/p3a-real"},{head:f.head,branch_absent:true});
 const wt=call(f.workspace,"git.worktree",{repo_path:"repo",branch:"feature/p3a-real",path:"task-wt"},{branch_head:f.head,target_absent:true});
 const pre=sha256("exports.add = (a, b) => a - b;\n"),post=sha256("exports.add = (a, b) => a + b;\n");
 const patch=call(f.workspace,"fs.patch",{path:"task-wt/calc.cjs",old_text:"a - b",new_text:"a + b",expected_replacements:1},{exists:true,sha256:pre});
 const run=call(f.workspace,"test.run",{plan_id:"p3a-real-test"},{});
 const commit=call(f.workspace,"git.commit",{repo_path:"task-wt",message:"fix sum",paths:["calc.cjs"]},{head:f.head});
 const def:WorkflowDefinition={id:"p3a-real-"+randomUUID(),steps:[
  {id:"branch",call:branch,depends_on:[]},{id:"worktree",call:wt,depends_on:["branch"]},
  {id:"patch",call:patch,depends_on:["worktree"],reconciliation:{before:[{kind:"file",path:"task-wt/calc.cjs",exists:true,sha256:pre}],after:[{kind:"file",path:"task-wt/calc.cjs",exists:true,sha256:post}]}},
  {id:"test",call:run,depends_on:["patch"]},{id:"commit",call:commit,depends_on:["test"]}]};
 const gitRuntime=await GitIsolationRuntime.create({authority,identity:{name:"P3A Host",email:"p3a@example.invalid"}});
 const writer=await WritePlaneRuntime.create({authority});
 let testRuns=0;
 const handlers:Record<string,WorkflowStepHandler>={
  "git.branch":c=>gitRuntime.execute(c),"git.worktree":c=>gitRuntime.execute(c),"fs.patch":c=>writer.execute(c),
  "git.commit":c=>gitRuntime.execute(c),"test.run":async c=>{testRuns++;c=structuredClone(c);const plan=await bindProcessPlan({id:"p3a-real-test",workspace_root:f.workspace,cwd:"task-wt",executable:process.execPath,argv:["--test","calc.test.cjs"],input_paths:["task-wt/calc.cjs","task-wt/calc.test.cjs"],repo_path:"task-wt",expected_head:f.head,grant:"host-user",purpose:"test",max_runtime_ms:10000});c.arguments={plan_id:plan.id};c.expected_state={plan_digest:plan.digest};const runtime=await ProcessLifecycleRuntime.create({workspace_root:f.workspace,artifact_root:f.artifacts,plans:[plan],authority});try{return await runtime.execute(c);}finally{await runtime.close();}}
 };
 return {f,def,handlers,getTestRuns:()=>testRuns};
}
test("P3A real File-Git-Process-Test workflow executes through production runtimes and replays exactly once",async()=>{
 const x=await setup(),dir=join(x.f.root,"journal"),key=randomBytes(32);let j=OperationJournal.open({directory:dir,namespace:"e2e",signing_key:key});
 try{const first=await new DurableWorkflowExecutor({journal:j,handlers:x.handlers}).execute(x.def);assert.equal(first.state,"completed");assert.deepEqual(first.completed,["branch","worktree","patch","test","commit"]);assert.equal(x.getTestRuns(),1);const commit=(first.results.commit.output as any).commit;assert.equal(await git(join(x.f.workspace,"task-wt"),["show",commit+":calc.cjs"]),"exports.add = (a, b) => a + b;");j.close();j=OperationJournal.open({directory:dir,namespace:"e2e",signing_key:key});const replay=await new DurableWorkflowExecutor({journal:j,handlers:x.handlers}).execute(x.def);assert.equal(replay.state,"completed");assert.equal(x.getTestRuns(),1);}finally{j.close();await rm(x.f.root,{recursive:true,force:true});}
});
test("P3A crash after published step resumes without redispatch and completes real workflow",async()=>{
 const x=await setup(),dir=join(x.f.root,"journal"),key=randomBytes(32);let j=OperationJournal.open({directory:dir,namespace:"resume",signing_key:key});let crashed=false;
 try{await assert.rejects(()=>new DurableWorkflowExecutor({journal:j,handlers:x.handlers,on_phase:(phase,step)=>{if(!crashed&&phase==="after_publish"&&step.id==="patch"){crashed=true;throw Error("crash-after-publish");}}}).execute(x.def),/crash-after-publish/);assert.equal(await readFile(join(x.f.workspace,"task-wt","calc.cjs"),"utf8"),"exports.add = (a, b) => a + b;\n");j.close();j=OperationJournal.open({directory:dir,namespace:"resume",signing_key:key});const resumed=await new DurableWorkflowExecutor({journal:j,handlers:x.handlers}).execute(x.def);assert.equal(resumed.state,"completed");assert.equal(x.getTestRuns(),1);}finally{j.close();await rm(x.f.root,{recursive:true,force:true});}
});
test("P3A crash after mutation dispatch proves post-identity but remains uncertain and never repeats mutation",async()=>{
 const x=await setup(),dir=join(x.f.root,"journal"),key=randomBytes(32);let j=OperationJournal.open({directory:dir,namespace:"uncertain",signing_key:key});let patchDispatches=0;const original=x.handlers["fs.patch"]!;x.handlers["fs.patch"]=async c=>{patchDispatches++;return original(c);};
 try{await assert.rejects(()=>new DurableWorkflowExecutor({journal:j,handlers:x.handlers,on_phase:(phase,step)=>{if(phase==="after_dispatch"&&step.id==="patch")throw Error("crash-after-dispatch");}}).execute(x.def),/crash-after-dispatch/);assert.equal(await readFile(join(x.f.workspace,"task-wt","calc.cjs"),"utf8"),"exports.add = (a, b) => a + b;\n");j.close();j=OperationJournal.open({directory:dir,namespace:"uncertain",signing_key:key});const resumed=await new DurableWorkflowExecutor({journal:j,handlers:x.handlers}).execute(x.def);assert.equal(resumed.state,"uncertain");assert.equal(resumed.blocked_step,"patch");assert.equal(patchDispatches,1);assert.equal(x.getTestRuns(),0);}finally{j.close();await rm(x.f.root,{recursive:true,force:true});}
});
