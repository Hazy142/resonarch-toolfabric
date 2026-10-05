import fs from "node:fs";
import path from "node:path";
const source=JSON.parse(fs.readFileSync("contracts/tools/registry.source.json","utf8"));
const risks=new Set(["forge.merge"]);
const r2=new Set(["forge.issue","forge.pr","forge.review","ci.rerun","web.search","web.fetch","docs.resolve","package.resolve","vulnerability.search","network.authorize","attestation.sign"]);
const mutatingPrefixes=["fs.write","fs.patch","fs.move","process.start","process.input","process.stop","git.branch","git.worktree","git.commit","git.rebase","git.merge","test.run","test.target","test.coverage","lint.run","typecheck.run","build.run","task.claim","task.dispatch","review.dispatch","session.state","ledger.append","memory.put","history.compact","checkpoint.resume","secret.redact","receipt.create","benchmark.record","archive.pack","archive.unpack","artifact.store","report.render"];
function risk(id){if(risks.has(id))return "R3";if(r2.has(id))return "R2";if(mutatingPrefixes.some(x=>id.startsWith(x)))return "R1";return "R0";}
function effect(id,r){if(r==="R0")return "none";if(id.startsWith("fs."))return "filesystem";if(id.startsWith("process."))return "process";if(id.startsWith("git.")||id.startsWith("forge.")||id.startsWith("ci."))return "repository";if(id==="report.render")return "projection";if(id.startsWith("web.")||id.startsWith("docs.")||id.startsWith("package.")||id.startsWith("vulnerability.")||id==="attestation.sign"||id==="artifact.store")return "external";return "local";}
const descriptors=[];
for(const [family,ids] of Object.entries(source.families)){
 if(ids.length!==8)throw new Error("REGISTRY_FAMILY_COUNT:"+family);
 const dir=path.join("contracts","tools",family);fs.mkdirSync(dir,{recursive:true});
 for(const id of ids){const r=risk(id);const root=id.split(".")[0];const d={schema:"resonarch.toolfabric.tool/v1",id,version:"1.0.0",title:id,summary:"Canonical ToolFabric primitive: "+id+".",input_schema:{type:"object",additionalProperties:true},output_schema:{type:"object",additionalProperties:true},capabilities:[root+(r==="R0"?":read":":write")],authority_scope:["workspace"],risk_class:r,side_effect:effect(id,r),idempotency:r==="R0"?"pure":(id==="forge.merge"||id==="attestation.sign"?"non_idempotent":"conditional"),network:/^(web|docs|package|vulnerability|forge|ci)\./.test(id)?"required":"forbidden",receipt:"required",default_timeout_ms:30000,max_output_bytes:1048576};descriptors.push(d);fs.writeFileSync(path.join(dir,id+".json"),JSON.stringify(d,null,2)+"\n");}
}
const snapshot={schema:"resonarch.toolfabric.registry/v1",count:descriptors.length,families:Object.fromEntries(Object.entries(source.families).map(([k,v])=>[k,v.length])),tools:descriptors.map(x=>x.id)};
fs.writeFileSync("contracts/tools/registry.snapshot.json",JSON.stringify(snapshot,null,2)+"\n");
if(descriptors.length!==112)throw new Error("REGISTRY_COUNT:"+descriptors.length);
console.log("generated "+descriptors.length+" tool descriptors across "+Object.keys(source.families).length+" families");
