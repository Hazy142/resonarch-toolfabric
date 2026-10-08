// Image-baked trusted PID-1 broker. Application code is only loaded by an unprivileged child.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");
const recipe = JSON.parse(fs.readFileSync("/broker/recipe.json","utf8"));
const operation = process.env.TF_OPERATION;
const capsule = process.env.TF_CAPSULE;
const attempt = Number(process.env.TF_ATTEMPT);
const expiry = Number(process.env.TF_EXPIRY);
const control = "/state/control";
const resultPath = control+"/result.json";
if(process.pid!==1 || process.getuid()!==0 || !/^sha256:[a-f0-9]{64}$/.test(operation??"")
  || !/^sha256:[a-f0-9]{64}$/.test(capsule??"") || !Number.isInteger(attempt) || !Number.isFinite(expiry)) {
  process.stderr.write("INVALID_CAPSULE_LAUNCH_CONTEXT");process.exit(125);
}
fs.mkdirSync(control,{recursive:true,mode:0o700});fs.chmodSync(control,0o700);
function durable(file,bytes) {
  const temporary=file+".tmp";const fd=fs.openSync(temporary,"w",0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);const dir=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
if(fs.existsSync(resultPath)) {
  const previous=JSON.parse(fs.readFileSync(resultPath,"utf8"));
  if(previous.operation_key!==operation||previous.capsule_digest!==capsule)process.exit(125);
  process.stdout.write("CACHED_ATTEMPT_RESULT\n");process.exit(0);
}
if(fs.existsSync(control+"/started.json")) {
  durable(resultPath,JSON.stringify({schema:"resonarch.toolfabric.capsule-result/v1",operation_key:operation,capsule_digest:capsule,
    attempt,state:"uncertain",reason:"PREVIOUS_ATTEMPT_INTERRUPTED",application_exit_code:null}));process.exit(0);
}
if(Date.now()>=expiry) {
  durable(resultPath,JSON.stringify({schema:"resonarch.toolfabric.capsule-result/v1",operation_key:operation,capsule_digest:capsule,
    attempt,state:"cancelled",reason:"LAUNCH_EXPIRED",application_exit_code:null}));process.exit(0);
}
durable(control+"/started.json",JSON.stringify({operation_key:operation,capsule_digest:capsule,attempt,at:Date.now()}));
const buffers={stdout:[],stderr:[]};const lengths={stdout:0,stderr:0};const seen={stdout:0,stderr:0};
function append(stream,bytes) {
  seen[stream]+=bytes.length;const count=Math.min(bytes.length,recipe.max_output_bytes-lengths.stdout-lengths.stderr);
  if(count>0){buffers[stream].push(Buffer.from(bytes.subarray(0,count)));lengths[stream]+=count;}
}
function processes() {
  const active=[];
  for(const entry of fs.readdirSync("/proc")) {
    if(!/^\d+$/.test(entry)||Number(entry)===1)continue;
    try {
      const stat=fs.readFileSync(`/proc/${entry}/stat`,"utf8");const state=stat.slice(stat.lastIndexOf(")")+2).split(" ")[0];
      if(state!=="Z"&&state!=="X")active.push(Number(entry));
    }catch(error){if(error.code!=="ENOENT"&&error.code!=="ESRCH")throw error;}
  }
  return active;
}
function killOwned() {for(const pid of processes()){try{process.kill(pid,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}}}
let reason=null;let finalizing=false;
const app=spawn(recipe.executable,recipe.argv,{cwd:recipe.cwd,env:{HOME:"/tmp",TZ:"UTC",...recipe.environment},
  uid:10001,gid:10001,shell:false,stdio:["ignore","pipe","pipe"]});
let closeResolve;
const pipesClosed=new Promise(resolve=>{closeResolve=resolve;});app.once("close",()=>closeResolve(true));
app.stdout.on("data",b=>append("stdout",b));app.stderr.on("data",b=>append("stderr",b));
const lifetime=Math.max(1,Math.min(recipe.max_runtime_ms,expiry-Date.now()));
const timer=setTimeout(()=>{reason="DEADLINE_EXCEEDED";try{killOwned();}catch{}},lifetime);
async function finish(code,signal,error) {
  if(finalizing)return;finalizing=true;clearTimeout(timer);
  let cleanupError=null;
  const until=Date.now()+5000;
  while(processes().length>0&&Date.now()<until){try{killOwned();}catch(e){cleanupError=String(e);}await new Promise(r=>setTimeout(r,10));}
  if(processes().length>0)cleanupError="PID_NAMESPACE_QUIESCENCE_UNCONFIRMED";
  let pipeTimer;
  const drained=await Promise.race([pipesClosed,new Promise(resolve=>{pipeTimer=setTimeout(()=>resolve(false),2000);})]);
  if(pipeTimer)clearTimeout(pipeTimer);
  if(!drained)cleanupError="OUTPUT_PIPE_QUIESCENCE_UNCONFIRMED";
  const files=[];let fileBytes=0;
  function collect(folder) {
    for(const name of fs.readdirSync(folder).sort()) {
      const file=path.join(folder,name),info=fs.lstatSync(file);
      if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory()))throw new Error("UNSAFE_OUTPUT_FILE");
      if(info.isDirectory())collect(file);
      else {
        if(files.length>=128||fileBytes+info.size>recipe.max_files_bytes)throw new Error("OUTPUT_FILE_LIMIT");
        const bytes=fs.readFileSync(file);fileBytes+=bytes.length;
        files.push({path:path.relative("/output",file),sha256:"sha256:"+crypto.createHash("sha256").update(bytes).digest("hex"),base64:bytes.toString("base64")});
      }
    }
  }
  let outputError=null;
  try{if(!cleanupError)collect("/output");}catch(e){outputError=String(e);}
  const body={schema:"resonarch.toolfabric.capsule-result/v1",operation_key:operation,capsule_digest:capsule,attempt,
    state:cleanupError?"uncertain":reason?"cancelled":error||outputError?"failed":"completed",
    reason:cleanupError??reason??outputError??(error?String(error):null),application_exit_code:code,application_signal:signal,
    application_uid:10001,pid_namespace_quiescent:!cleanupError,stdout_base64:Buffer.concat(buffers.stdout).toString("base64"),
    stderr_base64:Buffer.concat(buffers.stderr).toString("base64"),retained_bytes:lengths.stdout+lengths.stderr,
    discarded_bytes:seen.stdout+seen.stderr-lengths.stdout-lengths.stderr,files,finished_at:new Date().toISOString()};
  durable(resultPath,JSON.stringify(body));process.stdout.write("SEALED_ATTEMPT_RESULT\n");process.exit(0);
}
app.once("exit",(code,signal)=>{void finish(code,signal,null).catch(e=>{process.stderr.write(String(e));process.exit(125);});});
app.once("error",error=>{void finish(null,null,error).catch(e=>{process.stderr.write(String(e));process.exit(125);});});
