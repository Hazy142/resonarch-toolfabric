import fs from "node:fs";
import YAML from "yaml";
const workflows={
 inspect:["instructions.discover","instructions.resolve","git.status","fs.list","fs.search","code.symbols","code.dependencies","test.discover","context.pack","report.render"],
 plan:["task.decompose","task.graph","action.classify","capability.resolve","gate.evaluate"],
 implement:["git.worktree","task.claim","code.edit","code.format","test.target","typecheck.run","git.diff","review.dispatch","gate.evaluate","git.commit"],
 fix:["code.references","code.edit","test.target","git.diff","review.dispatch","gate.evaluate"],
 debug:["env.snapshot","git.status","test.target","ledger.append","code.search","source.compare","gate.evaluate"],
 test:["test.discover","test.run","artifact.store","receipt.create","report.render"],
 verify:["claim.classify","receipt.verify","test.target","gate.evaluate"],
 review:["task.handoff","git.diff","instructions.resolve","review.dispatch","claim.classify"],
 refactor:["test.run","code.dependencies","code.references","code.edit","test.run","git.diff","review.dispatch"],
 migrate:["manifest.create","source.compare","structured.diff","test.run","gate.evaluate","report.render"],
 research:["web.search","web.fetch","source.compare","research.bundle","claim.classify"],
 benchmark:["env.snapshot","manifest.create","benchmark.record","structured.diff","report.render"],
 audit:["policy.compile","secret"+"."+"scan","license.inspect","vulnerability.search","code.dependencies","sandbox.boundary","receipt.verify","report.render"],
 release:["git.status","manifest.create","test.run","build.run","review.dispatch","approval.request","attestation.sign","report.render"],
 ship:["test.run","review.dispatch","ci.status","forge.pr","gate.evaluate"],
 triage:["task.decompose","claim.classify","source.compare","escalation.route","report.render"],
 resume:["checkpoint.resume","receipt.verify","git.status","context.diff","context.pack","task.status"],
 handoff:["task.handoff","context.pack","manifest.create","report.render"],
 document:["source.compare","claim.classify","manifest.create","report.render"],
 delegate:["task.decompose","task.graph","model.catalog","model.route","capability.resolve","task.dispatch","task.status"]
};
fs.mkdirSync("user-tools",{recursive:true});
for(const [id,graph] of Object.entries(workflows)){
 const reviewGate=["implement","fix","refactor","migrate","release","ship"].includes(id);
 const spec={schema:"resonarch.toolfabric.user-tool/v1",id,version:"1.0.0",intent:"Compile the "+id+" user intent into a provider-independent execution DAG.",preflight:id==="research"?["provider.health"]:["instructions.discover","git.status"],required_capabilities:[],graph,required_gates:["receipt_chain_valid",...(reviewGate?["review_verdict"]:[])],failure_routes:["blocked","denied","uncertain","budget_exhausted"],default_budget:{tool_calls:64,wall_seconds:3600},completion:{require:["evidence_bound_to_current_scope","no_open_uncertain_side_effects"]}};
 fs.writeFileSync("user-tools/"+id+".yaml",YAML.stringify(spec));
}
if(Object.keys(workflows).length!==20)throw new Error("USER_TOOL_COUNT:"+Object.keys(workflows).length);
console.log("generated "+Object.keys(workflows).length+" user-tool workflows");
