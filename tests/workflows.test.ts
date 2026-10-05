import test from "node:test";
import assert from "node:assert/strict";
import {readdir} from "node:fs/promises";
import {compileWorkflow,loadUserTool} from "../src/workflows/compiler.js";
test("repository ships exactly 20 standard user tools",async()=>assert.equal((await readdir("user-tools")).filter(x=>x.endsWith(".yaml")).length,20));
test("implement compiles to review and receipt gates",async()=>{const spec=await loadUserTool("implement");const dag=compileWorkflow(spec);assert.equal(dag.nodes.some(x=>x.tool==="review.dispatch"),true);assert.equal(dag.gates.includes("receipt_chain_valid"),true);assert.equal(dag.gates.includes("review_verdict"),true);});
test("network-reading user tools preserve network:web_read through workflow compilation",async()=>{for(const id of ["research","audit"]){const spec=await loadUserTool(id);assert.deepEqual(spec.required_capabilities,["network:web_read"]);assert.deepEqual(compileWorkflow(spec).required_capabilities,["network:web_read"]);}});
