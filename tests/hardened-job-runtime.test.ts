import test from "node:test";
import assert from "node:assert/strict";
import {copyFile,mkdir,mkdtemp,readFile,readdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {DockerBackend} from "../src/runtime/dockerBackend.js";
import {sealCapsule} from "../src/runtime/sealedCapsule.js";
import {HardenedJobRuntime} from "../src/runtime/hardenedJobRuntime.js";
import {canonicalDigest,sha256} from "../src/contracts/canonical.js";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {verifyChain} from "../src/evidence/receipt.js";
const live=process.env.TOOLFABRIC_P2D_LIVE_DOCKER==="1";
const evidenceCases:any[]=[];
async function retainEvidence(name:string,runtime:HardenedJobRuntime,operation:string,capsule:any,outcome:any,extra:Record<string,unknown>={}) {
  assert.equal(runtime.journal.verify(),true);
  const record=runtime.journal.get(operation)!;assert.equal(record.publication_count,1);
  const blobDigests=[];
  for(const ref of outcome.artifacts){const bytes=runtime.readArtifact(operation,ref);assert.equal("artifact://"+sha256(bytes),ref);blobDigests.push({ref,bytes:bytes.byteLength});}
  const directory=resolve("evidence/local/p2d-journals",name);await mkdir(directory,{recursive:true});
  const namespace=(runtime as any).options.namespace;
  const database=runtime.journal.database_path;runtime.close();
  await copyFile(database,join(directory,"operations.sqlite"));
  evidenceCases.push({name,operation,namespace,controller_platform:process.platform,node:process.version,capsule_digest:capsule.digest,image_id:capsule.image_id,
    input_digest:capsule.input_digest,backend:capsule.backend,outcome,publication_count:1,receipts_verified:verifyChain(outcome.receipts),blob_digests:blobDigests,
    journal_sha256:sha256(await readFile(join(directory,"operations.sqlite"))),private_attempt_history:record.payload.attempt_history??[],...extra});
  const runtimeHashes:Record<string,string>={};
  for(const area of ["runtime","evidence"]){for(const file of await readdir("dist/src/"+area)){if(file.endsWith(".js"))runtimeHashes[area+"/"+file]=sha256(await readFile("dist/src/"+area+"/"+file));}}
  for(const file of ["capsuleRunner.cjs","capsuleReader.cjs"])runtimeHashes[file]=sha256(await readFile("src/runtime/"+file));
  runtimeHashes["windowsSnapshotHost.cs"]=sha256(await readFile("src/runtime/windowsSnapshotHost.cs"));
  if(process.platform==="win32")runtimeHashes["native/toolfabric-snapshot-host.exe"]=sha256(await readFile("dist/native/toolfabric-snapshot-host.exe"));
  await writeFile("evidence/local/p2d-proof.json",JSON.stringify({schema:"resonarch.toolfabric.hardened-execution-evidence/v1",runtime_hashes:runtimeHashes,
    cases:evidenceCases,execution_target:"linux/amd64",exactly_once_scope:"durable-result-publication",fixture_key_byte:9},null,2)+"\n");
}
function backend() {
  return new DockerBackend(process.platform==="win32"?{executable:join(process.env.SystemRoot??"C:\\Windows","System32/wsl.exe"),
    prefix_args:["-d","Ubuntu","--exec","docker"],wsl_distribution:"Ubuntu",config_directory:process.env.TOOLFABRIC_P2D_DOCKER_CONFIG}:
    {executable:"/usr/bin/docker",config_directory:process.env.TOOLFABRIC_P2D_DOCKER_CONFIG});
}

test("hardened job publishes a real result once and replays the immutable publication",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-hardened-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'require("node:fs").writeFileSync("/output/result.txt", "bound result");console.log("actual compute");');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"]});
  const runtime=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),
    namespace:"fixture",signing_key:Buffer.alloc(32,9),capsules:[capsule],authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}} as any);t.after(()=>runtime.close());
  const outcome=await runtime.run("operation",capsule,"approval:fixture");
  assert.equal(outcome.status,"succeeded");assert.equal(outcome.publication_count,1);
  assert.equal(outcome.execution.application_exit_code,0);assert.equal(outcome.execution.pid_namespace_quiescent,true);
  const replay=await runtime.run("operation",capsule,"approval:fixture");
  assert.equal(replay.replayed,true);assert.equal(replay.publication_count,1);assert.equal(replay.result_digest,outcome.result_digest);
  assert.equal(runtime.journal.get("operation")?.publication_count,1);
  await runtime.cleanup("operation",capsule);
  assert.equal((await runtime.run("operation",capsule,"approval:fixture")).result_digest,outcome.result_digest);
  await retainEvidence("publication-replay",runtime,"operation",capsule,outcome,{replay_verified:true});
});

test("hardened capsule rejects privilege escape, live-input mutation and undeclared host access",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-isolation-"));const input=join(root,"input");await mkdir(input);
  const script='const fs=require("node:fs");const net=require("node:net");const result={uid:process.getuid(),pid:process.pid};for(const [key,fn]of Object.entries({raiseUid:()=>process.setuid(0),mutateInput:()=>fs.writeFileSync("/input/app.cjs","tampered"),readControl:()=>fs.readFileSync("/state/control/started.json"),dockerSocket:()=>fs.statSync("/var/run/docker.sock")})){try{fn();result[key]="allowed";}catch(e){result[key]="blocked";}}result.capEff=fs.readFileSync("/proc/self/status","utf8").match(/^CapEff:\\s+(.*)$/m)[1];const socket=net.createConnection({host:"1.1.1.1",port:443});const done=()=>{result.network="blocked";socket.destroy();console.log(JSON.stringify(result));};socket.on("connect",()=>{result.network="allowed";socket.destroy();console.log(JSON.stringify(result));});socket.on("error",done);socket.setTimeout(300,done);';
  await writeFile(join(input,"app.cjs"),script);
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"]});
  await writeFile(join(input,"app.cjs"),'throw new Error("live changed code must not execute");');
  const r=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),namespace:"isolation",signing_key:Buffer.alloc(32,9),capsules:[capsule],
    authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}});t.after(()=>r.close());
  const outcome=await r.run("isolation",capsule,"approval:fixture");assert.equal(outcome.status,"succeeded");
  const witness=JSON.parse(Buffer.from(r.readArtifact("isolation",outcome.stdout_ref)).toString("utf8"));
  assert.equal(witness.uid,10001);assert.equal(witness.capEff,"0000000000000000");
  for(const field of ["raiseUid","mutateInput","readControl","dockerSocket","network"])assert.equal(witness[field],"blocked",field);
  await r.cleanup("isolation",capsule);await retainEvidence("isolation",r,"isolation",capsule,outcome,{witness});
});

test("hardened detached descendants cannot outlive their PID namespace",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-pid-namespace-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});console.log("detached:"+c.pid);process.exit(0);');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"]});
  const r=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),namespace:"pid-namespace",signing_key:Buffer.alloc(32,9),capsules:[capsule],
    authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}});t.after(()=>r.close());
  const outcome=await r.run("detached",capsule,"approval:fixture");assert.equal(outcome.status,"succeeded");assert.equal(outcome.execution.pid_namespace_quiescent,true);
  assert.match(Buffer.from(r.readArtifact("detached",outcome.stdout_ref)).toString(),/detached:\d+/);
  const id=r.journal.get("detached")!.payload.container_id as string;
  const container=await engine.inspectContainer(id);assert.equal(container.State.Running,false);
  await r.cleanup("detached",capsule);await retainEvidence("detached-descendants",r,"detached",capsule,outcome,{namespace_stopped:true});
});

for(const phase of ["intent_committed","backend_created","backend_started","before_publish","published"]) {
  test(`hardened recovery after actual controller death at ${phase}`,{skip:!live},async t=>{
    const root=await mkdtemp(join(tmpdir(),"toolfabric-crash-"));const input=join(root,"input");await mkdir(input);
    await writeFile(join(input,"app.cjs"),'setTimeout(()=>{require("node:fs").writeFileSync("/output/result.txt","durable result");console.log("one confirmed attempt");},1000);');
    const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"],max_runtime_ms:5000});
    const state=join(root,"state"),artifacts=join(root,"artifacts");const config=join(root,"worker.json");
    await writeFile(config,JSON.stringify({backend:engine.options,state_directory:state,artifact_directory:artifacts,namespace:"crash-fixture",capsule,
      operation:"crash-operation",pause_phase:phase}));
    const child=spawn(process.execPath,[resolve("tests/helpers/hardened-worker.mjs"),config],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let text="",errors="";child.stdout.on("data",bytes=>text+=bytes);child.stderr.on("data",bytes=>errors+=bytes);
    t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");});
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("crash boundary not reached: "+errors)),60000);
      child.stdout.on("data",()=>{if(text.includes("READY:"+phase)){clearTimeout(timeout);resolve();}});
      child.once("exit",()=>{if(!text.includes("READY:"+phase)){clearTimeout(timeout);reject(new Error("worker exited before crash boundary: "+errors));}});
    });
    const exit=new Promise<void>(resolve=>child.once("exit",()=>resolve()));assert.equal(child.kill("SIGKILL"),true);await exit;
    assert.notEqual(child.signalCode,null);
    const runtime=HardenedJobRuntime.open({backend:engine,state_directory:state,artifact_directory:artifacts,namespace:"crash-fixture",signing_key:Buffer.alloc(32,9),capsules:[capsule],
      lease_ms:5000,authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}});t.after(()=>runtime.close());
    const before=runtime.journal.get("crash-operation")!;assert.equal(runtime.journal.verify(),true);
    const outcome=await runtime.run("crash-operation",capsule,"approval:fixture");
    assert.equal(outcome.status,"succeeded");assert.equal(outcome.publication_count,1);assert.equal(verifyChain(outcome.receipts),true);
    const after=runtime.journal.get("crash-operation")!;
    if(before.payload.container_id)assert.equal(after.payload.container_id,before.payload.container_id,"recovery must adopt the existing owned job");
    const file=outcome.files.find((file:any)=>file.path==="result.txt");assert.ok(file);
    assert.equal(Buffer.from(runtime.readArtifact("crash-operation",file.artifact_ref)).toString(),"durable result");
    const repeated=await runtime.run("crash-operation",capsule,"approval:fixture");assert.equal(repeated.replayed,true);assert.equal(repeated.result_digest,outcome.result_digest);
    await runtime.cleanup("crash-operation",capsule);
    await retainEvidence("crash-"+phase,runtime,"crash-operation",capsule,outcome,{crash_phase:phase,controller_killed:true,previous_container:before.payload.container_id??null,
      recovered_container:after.payload.container_id??null});
  });
}

test("hardened safe recomputation after killed private attempt publishes only one final result",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-recompute-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'setTimeout(()=>console.log("recomputed safely"),1500);');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"],max_runtime_ms:5000});
  let killed=false;const attempts:Array<{id:string;volume:string}>=[];
  const r=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),namespace:"recompute",signing_key:Buffer.alloc(32,9),capsules:[capsule],
    authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]},on_phase:async(phase,record)=>{
      if(phase==="backend_started")attempts.push({id:record.payload.container_id as string,volume:record.payload.volume_name as string});
      if(phase==="backend_started"&&!killed){killed=true;await engine.command(["kill",record.payload.container_id as string]);}
    }});t.after(()=>r.close());
  const outcome=await r.run("recompute",capsule,"approval:fixture");assert.equal(outcome.status,"succeeded");assert.equal(outcome.publication_count,1);
  assert.equal(outcome.execution.attempt,1);assert.equal(r.journal.get("recompute")!.publication_count,1);
  const history=r.journal.get("recompute")!.payload.attempt_history as any[];assert.equal(history.length,1);assert.equal(history[0].namespace_stopped,true);assert.equal(history[0].attempt,0);
  assert.equal(Buffer.from(r.readArtifact("recompute",outcome.stdout_ref)).toString(),"recomputed safely\n");
  await r.cleanup("recompute",capsule);
  assert.equal(attempts.length,2);
  for(const attempt of attempts){assert.equal(await engine.inspectContainer(attempt.id),null);await assert.rejects(engine.command(["volume","inspect",attempt.volume]),/No such volume/i);}
  await r.cleanup("recompute",capsule);
  assert.equal((await r.run("recompute",capsule,"approval:fixture")).result_digest,outcome.result_digest);
  await retainEvidence("safe-recomputation",r,"recompute",capsule,outcome,{private_attempt_killed:true,final_attempt:1,all_attempts_removed:attempts});
});

test("hardened collectors preserve complete confirmed output and leave an unrelated namespace alive",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-output-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'process.stdout.write("a".repeat(200000),()=>process.stderr.write("b".repeat(5000),()=>process.exit(0)));');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"],max_output_bytes:300000});
  const sentinel=await engine.command(["run","--detach","--network=none","--read-only","--cap-drop=ALL","--entrypoint","/usr/local/bin/node",capsule.image_id,"-e","setInterval(()=>{},1000)"]);
  t.after(async()=>{await engine.command(["rm","--force",sentinel]);});
  const r=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),namespace:"output",signing_key:Buffer.alloc(32,9),capsules:[capsule],
    authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}});t.after(()=>r.close());
  const outcome=await r.run("output",capsule,"approval:fixture");assert.equal(outcome.status,"succeeded");
  assert.equal(Buffer.from(r.readArtifact("output",outcome.stdout_ref)).toString(),"a".repeat(200000));
  assert.equal(Buffer.from(r.readArtifact("output",outcome.stderr_ref)).toString(),"b".repeat(5000));
  assert.equal((await engine.inspectContainer(sentinel)).State.Running,true);
  await r.cleanup("output",capsule);assert.equal((await engine.inspectContainer(sentinel)).State.Running,true);
  await retainEvidence("output-and-unrelated-process",r,"output",capsule,outcome,{unrelated_namespace_preserved:true,stdout_bytes:200000,stderr_bytes:5000});
});

test("hardened concurrent controllers converge on one publication and retain a real negative result",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-concurrent-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'setTimeout(()=>{console.error("actual negative outcome");process.exit(7);},600);');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"]});
  const config={backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),namespace:"concurrent",signing_key:Buffer.alloc(32,9),capsules:[capsule],
    authority:{capabilities:["test:run","process:host_execution","process:isolated_execution"],approved_refs:["approval:fixture"]}};
  const first=HardenedJobRuntime.open(config),second=HardenedJobRuntime.open(config);t.after(()=>first.close());t.after(()=>second.close());
  const outcomes=await Promise.all([first.run("same-operation",capsule,"approval:fixture"),second.run("same-operation",capsule,"approval:fixture")]);
  assert.equal(outcomes[0].status,"failed");assert.equal(outcomes[1].status,"failed");
  assert.equal(outcomes[0].execution.application_exit_code,7);assert.equal(outcomes[0].result_digest,outcomes[1].result_digest);
  assert.equal(first.journal.get("same-operation")!.publication_count,1);
  assert.equal(Buffer.from(first.readArtifact("same-operation",outcomes[0].stderr_ref)).toString(),"actual negative outcome\n");
  await first.cleanup("same-operation",capsule);second.close();
  await retainEvidence("concurrent-negative-result",first,"same-operation",capsule,outcomes[0],{controllers:2,publication_count:1,negative_exit:7});
});

test("hardened jobs require explicit authority and registered capsule before durable admission",{skip:!live},async t=>{
  const root=await mkdtemp(join(tmpdir(),"toolfabric-hardened-deny-"));const input=join(root,"input");await mkdir(input);
  await writeFile(join(input,"app.cjs"),'console.log("must not launch without authority");');
  const engine=backend();const capsule=await sealCapsule(engine,input,join(root,"context"),{executable:"/usr/local/bin/node",argv:["/input/app.cjs"]});
  const runtime=HardenedJobRuntime.open({backend:engine,state_directory:join(root,"state"),artifact_directory:join(root,"artifacts"),
    namespace:"fixture",signing_key:Buffer.alloc(32,9),capsules:[capsule],authority:{capabilities:[],approved_refs:["approval:fixture"]}} as any);
  t.after(()=>runtime.close());
  await assert.rejects(runtime.run("denied-operation",capsule,"approval:fixture"),{code:"CAPABILITY_DENIED"});
  assert.equal(runtime.journal.list().length,0);
});
