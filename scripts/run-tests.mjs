import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
const files=readdirSync("dist/tests").filter(x=>x.endsWith(".test.js")).sort().map(x=>"dist/tests/"+x);
if(files.length===0)throw new Error("NO_COMPILED_TESTS");
const result=spawnSync(process.execPath,["--test",...files],{stdio:"inherit"});
process.exitCode=result.status??1;
