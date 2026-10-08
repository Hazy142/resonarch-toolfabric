import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {sha256} from "../src/contracts/canonical.js";
import {reconcileFileEvidence,type StepEvidence} from "../src/orchestrator/stepReconciliation.js";
import type {ToolCall} from "../src/runtime/readPlane.js";

test("reconciliation distinguishes exact pre, exact post, drift and indistinguishable states",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tf-reconcile-"));await mkdir(join(root,"workspace"));
 const call:ToolCall={schema:"resonarch.toolfabric.call/v1",call_id:"check",task_id:"task",trace_id:"trace",tool:{id:"fs.patch",version:"2.0.0"},arguments:{},scope:{workspace_root:join(root,"workspace")},deadline:"2099-01-01T00:00:00Z"};
 const file=join(root,"workspace","value.txt");
 const pre="old",post="new";
 const evidence:StepEvidence={before:[{kind:"file",path:"value.txt",exists:true,sha256:sha256(pre)}],after:[{kind:"file",path:"value.txt",exists:true,sha256:sha256(post)}]};
 try{
  await writeFile(file,pre);assert.equal(await reconcileFileEvidence(call,evidence),"pre");
  await writeFile(file,post);assert.equal(await reconcileFileEvidence(call,evidence),"post");
  await writeFile(file,"third");assert.equal(await reconcileFileEvidence(call,evidence),"uncertain");
  assert.equal(await reconcileFileEvidence(call,{before:evidence.before,after:evidence.before}),"uncertain");
 }finally{await rm(root,{recursive:true,force:true});}
});
