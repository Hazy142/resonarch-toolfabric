import test from "node:test";
import assert from "node:assert/strict";
import {sourceRegistry} from "../src/sources/sourceRegistry.js";
test("normative sources are revision pinned",async()=>{const sources=await sourceRegistry();assert.ok(sources.length>=12);assert.equal(sources.every(s=>/^[0-9a-f]{40}$/.test(s.revision)),true);});
test("external comparison remains explicitly identified",async()=>{const sources=await sourceRegistry();assert.ok(sources.some(s=>s.repository==="obra/superpowers"&&s.role==="external-workflow-reference"));});
