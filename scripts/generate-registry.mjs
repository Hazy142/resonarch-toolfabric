import fs from "node:fs";
import path from "node:path";
const source=JSON.parse(fs.readFileSync("contracts/tools/registry.source.json","utf8"));
const risks=new Set(["forge.merge"]);
const networkReads=new Set(["web.search","web.fetch","docs.resolve","package.resolve","vulnerability.search"]);
const processV2=new Set(["process.start","process.input","process.output","process.stop","process.list","test.run"]);
const hostExecution=new Set(["process.start","process.input","test.run"]);
const networkContractV2=new Set([...networkReads,...processV2,"network.authorize","code.edit","code.format","report.render","fs.write","fs.patch","fs.move","git.branch","git.worktree","git.commit"]);
const r2=new Set(["forge.issue","forge.pr","forge.review","ci.rerun",...networkReads,...hostExecution,"attestation.sign"]);
const mutatingPrefixes=["fs.write","fs.patch","fs.move","process.start","process.input","process.stop","git.branch","git.worktree","git.commit","git.rebase","git.merge","test.run","test.target","test.coverage","lint.run","typecheck.run","build.run","task.claim","task.dispatch","review.dispatch","session.state","ledger.append","memory.put","history.compact","checkpoint.resume","secret.redact","receipt.create","benchmark.record","archive.pack","archive.unpack","artifact.store","code.edit","code.format","report.render"];
function risk(id){if(risks.has(id))return "R3";if(r2.has(id))return "R2";if(mutatingPrefixes.some(x=>id.startsWith(x)))return "R1";return "R0";}
function effect(id,r){if(networkReads.has(id)||id==="network.authorize")return "none";if(r==="R0")return "none";if(id==="report.render")return "projection";if(id.startsWith("fs."))return "filesystem";if(id.startsWith("process."))return "process";if(id.startsWith("git.")||id.startsWith("forge.")||id.startsWith("ci."))return "repository";if(id==="attestation.sign"||id==="artifact.store")return "external";return "local";}
function capabilities(id,r){
 if(id==="process.start")return ["process:start","process:host_execution"];
 if(id==="process.input")return ["process:input","process:host_execution"];
 if(id==="process.stop")return ["process:stop"];
 if(id==="test.run")return ["test:run","process:host_execution"];
 if(networkReads.has(id))return ["network:web_read"];
 if(id==="network.authorize")return ["network:authorize"];
 if(id==="git.branch")return ["git:branch"];
 if(id==="git.worktree")return ["git:worktree"];
 if(id==="git.commit")return ["git:commit"];
 return [id.split(".")[0]+(r==="R0"?":read":":write")];
}
function idempotency(id,r){
 if(hostExecution.has(id))return "non_idempotent";
 if(id==="process.output"||id==="process.list")return "conditional";
 if(networkReads.has(id)||id==="network.authorize")return "conditional";
 return r==="R0"?"pure":(id==="forge.merge"||id==="attestation.sign"?"non_idempotent":"conditional");
}
function inputSchema(id){
 if(id==="process.start"||id==="test.run")return {type:"object",additionalProperties:false,required:["plan_id"],properties:{plan_id:{type:"string",minLength:1,maxLength:128}}};
 if(id==="process.input")return {type:"object",additionalProperties:false,required:["session_id","data"],properties:{session_id:{type:"string",minLength:1},data:{type:"string",maxLength:16384},eof:{type:"boolean"}}};
 if(id==="process.stop")return {type:"object",additionalProperties:false,required:["session_id"],properties:{session_id:{type:"string",minLength:1}}};
 if(id==="process.output")return {type:"object",additionalProperties:false,required:["session_id"],properties:{session_id:{type:"string",minLength:1},stdout_offset:{type:"integer",minimum:0},stderr_offset:{type:"integer",minimum:0},max_bytes:{type:"integer",minimum:1,maximum:32768}}};
 if(id==="process.list")return {type:"object",additionalProperties:false,properties:{}};
 if(id==="fs.write")return {type:"object",additionalProperties:false,required:["path","content"],properties:{path:{type:"string",minLength:1},content:{type:"string"}}};
 if(id==="fs.patch")return {type:"object",additionalProperties:false,required:["path","old_text","new_text"],properties:{path:{type:"string",minLength:1},old_text:{type:"string",minLength:1},new_text:{type:"string"},expected_replacements:{type:"integer",minimum:1,maximum:1000}}};
 if(id==="fs.move")return {type:"object",additionalProperties:false,required:["source","destination"],properties:{source:{type:"string",minLength:1},destination:{type:"string",minLength:1}}};
 if(id==="git.branch")return {type:"object",additionalProperties:false,required:["name"],properties:{repo_path:{type:"string",minLength:1},name:{type:"string",minLength:1,maxLength:128}}};
 if(id==="git.worktree")return {type:"object",additionalProperties:false,required:["branch","path"],properties:{repo_path:{type:"string",minLength:1},branch:{type:"string",minLength:1,maxLength:128},path:{type:"string",minLength:1}}};
 if(id==="git.commit")return {type:"object",additionalProperties:false,required:["message","paths"],properties:{repo_path:{type:"string",minLength:1},message:{type:"string",minLength:1,maxLength:8192},paths:{type:"array",minItems:1,maxItems:256,items:{type:"string",minLength:1}}}};
 return {type:"object",additionalProperties:true};
}
const descriptors=[];
for(const [family,ids] of Object.entries(source.families)){
 if(ids.length!==8)throw new Error("REGISTRY_FAMILY_COUNT:"+family);
 const dir=path.join("contracts","tools",family);fs.mkdirSync(dir,{recursive:true});
 for(const id of ids){const r=risk(id);const d={schema:"resonarch.toolfabric.tool/v1",id,version:networkContractV2.has(id)?"2.0.0":"1.0.0",title:id,summary:"Canonical ToolFabric primitive: "+id+".",input_schema:inputSchema(id),output_schema:{type:"object",additionalProperties:true},capabilities:capabilities(id,r),authority_scope:hostExecution.has(id)?["workspace","host_user"]:["workspace"],risk_class:r,side_effect:effect(id,r),idempotency:idempotency(id,r),network:hostExecution.has(id)?"optional":/^(web|docs|package|vulnerability|forge|ci)\./.test(id)?"required":"forbidden",receipt:"required",default_timeout_ms:30000,max_output_bytes:1048576};descriptors.push(d);fs.writeFileSync(path.join(dir,id+".json"),JSON.stringify(d,null,2)+"\n");}
}
const snapshot={schema:"resonarch.toolfabric.registry/v1",count:descriptors.length,families:Object.fromEntries(Object.entries(source.families).map(([k,v])=>[k,v.length])),tools:descriptors.map(x=>x.id)};
fs.writeFileSync("contracts/tools/registry.snapshot.json",JSON.stringify(snapshot,null,2)+"\n");
if(descriptors.length!==112)throw new Error("REGISTRY_COUNT:"+descriptors.length);
console.log("generated "+descriptors.length+" tool descriptors across "+Object.keys(source.families).length+" families");
