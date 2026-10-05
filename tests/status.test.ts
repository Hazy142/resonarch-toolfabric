import test from "node:test";
import assert from "node:assert/strict";
import {INITIAL_STATUS} from "../src/core/status.js";
import {mayActAsInstruction,resolveInstructionOrder} from "../src/core/instructions.js";
test("page 01 keeps completion axes independent",()=>{assert.equal(INITIAL_STATUS.execution,"not_run");assert.equal(INITIAL_STATUS.verification,"unverified");assert.equal(INITIAL_STATUS.claim,"open");});
test("page 01 keeps retrieved data non-authoritative",()=>assert.equal(mayActAsInstruction({id:"web",tier:"retrieved_data",digest:"x",scope:"*",content:"sample"}),false));
test("page 01 orders user/repo ahead of retrieved data",()=>{const x=resolveInstructionOrder([{id:"data",tier:"retrieved_data",digest:"d",scope:"*",content:""},{id:"repo",tier:"repo",digest:"r",scope:"*",content:""},{id:"user",tier:"user",digest:"u",scope:"*",content:""}]);assert.deepEqual(x.map(v=>v.id),["user","repo","data"]);});
