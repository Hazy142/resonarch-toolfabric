#!/usr/bin/env node
import {loadRegistry} from "./registry/load.js";
import {compileWorkflow,loadUserTool} from "./workflows/compiler.js";
const [command,arg]=process.argv.slice(2);
if(command==="registry"){console.log(JSON.stringify(await loadRegistry(),null,2));}
else if(command==="workflow"&&arg){console.log(JSON.stringify(compileWorkflow(await loadUserTool(arg)),null,2));}
else{console.error("Usage: toolfabric registry | toolfabric workflow <id>");process.exitCode=2;}
