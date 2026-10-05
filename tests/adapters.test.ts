import test from "node:test";
import assert from "node:assert/strict";
import {OpenaiAdapter} from "../src/adapters/openai.js";
import {McpAdapter} from "../src/adapters/mcp.js";
const descriptor:any={schema:"resonarch.toolfabric.tool/v1",id:"fs.read",version:"1.0.0",title:"Read",summary:"Read",input_schema:{type:"object"},output_schema:{type:"object"},capabilities:["fs:read"],authority_scope:["workspace"],risk_class:"R0",side_effect:"none",idempotency:"pure",network:"forbidden",receipt:"required",default_timeout_ms:1,max_output_bytes:1};
test("adapter projection preserves canonical identity",()=>{const before=descriptor.id;const projected:any=new OpenaiAdapter().project(descriptor);assert.equal(projected.name,"fs__read");assert.equal(descriptor.id,before);});
test("unknown provider result state fails closed",()=>assert.equal(new McpAdapter().normalize({status:"unexpected"}).status,"failed"));
test("uncertain result state is preserved",()=>assert.equal(new McpAdapter().normalize({status:"uncertain"}).status,"uncertain"));
