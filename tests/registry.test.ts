import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {loadRegistry} from "../src/registry/load.js";
test("registry contains exactly 112 unique valid primitives",async()=>{const r=await loadRegistry();assert.equal(r.length,112);assert.equal(new Set(r.map(x=>x.id)).size,112);});
test("registry source has 14 families of eight",async()=>{const s=JSON.parse(await readFile("contracts/tools/registry.source.json","utf8"));assert.equal(Object.keys(s.families).length,14);for(const ids of Object.values(s.families) as unknown[][])assert.equal(ids.length,8);});
