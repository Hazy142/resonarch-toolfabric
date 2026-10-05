import test from "node:test";
import assert from "node:assert/strict";
import {canonicalDigest,canonicalJson} from "../src/contracts/canonical.js";
import {assertToolDescriptor} from "../src/contracts/validate.js";
const d={schema:"resonarch.toolfabric.tool/v1",id:"fs.read",version:"1.0.0",title:"Read file",summary:"Read a file",input_schema:{type:"object"},output_schema:{type:"object"},capabilities:["fs:read"],authority_scope:["workspace"],risk_class:"R0",side_effect:"none",idempotency:"pure",network:"forbidden",receipt:"required",default_timeout_ms:30000,max_output_bytes:1048576};
test("canonical JSON is key-order stable",()=>{assert.equal(canonicalJson({b:2,a:{z:1,y:2}}),'{"a":{"y":2,"z":1},"b":2}');assert.equal(canonicalDigest({b:2,a:1}),canonicalDigest({a:1,b:2}));});
test("canonical JSON rejects non-finite numbers",()=>assert.throws(()=>canonicalJson({x:NaN}),/NON_FINITE/));
test("descriptor validation fails closed on invalid risk",()=>{assert.doesNotThrow(()=>assertToolDescriptor(d));assert.throws(()=>assertToolDescriptor({...d,risk_class:"observe"}),/INVALID_TOOL_DESCRIPTOR/);});
