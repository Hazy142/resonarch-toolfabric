import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {DockerBackend} from "../dist/src/runtime/dockerBackend.js";
import {LOCKED_NODE_BASE} from "../dist/src/runtime/sealedCapsule.js";

const config=await mkdtemp(join(tmpdir(),"toolfabric-docker-config-"));
await writeFile(join(config,"config.json"),"{}\n");
const options=process.platform==="win32"?{
  executable:join(process.env.SystemRoot??"C:\\Windows","System32/wsl.exe"),prefix_args:["-d","Ubuntu","--exec","docker"],
  wsl_distribution:"Ubuntu",config_directory:config,
}:{executable:"/usr/bin/docker",config_directory:config};
const backend=new DockerBackend(options);
const identity=await backend.identity();
console.log("HARDENED_BACKEND="+JSON.stringify(identity));
try{await backend.inspectImage(LOCKED_NODE_BASE);}catch{await backend.command(["pull",LOCKED_NODE_BASE],180000);}
await mkdir("evidence/local",{recursive:true});
const child=spawn(process.execPath,["scripts/run-tests.mjs"],{stdio:"inherit",windowsHide:true,
  env:{...process.env,TOOLFABRIC_P2D_LIVE_DOCKER:"1",TOOLFABRIC_P2D_DOCKER_CONFIG:config}});
const status=await new Promise(resolve=>{child.once("error",()=>resolve(1));child.once("exit",code=>resolve(code??1));});
process.exitCode=Number(status);
