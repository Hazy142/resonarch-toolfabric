import {chmod, mkdir, open, readFile, readdir, realpath, writeFile, type FileHandle} from "node:fs/promises";
import {constants} from "node:fs";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {isAbsolute, join, relative, resolve} from "node:path";
import {canonicalDigest, canonicalJson, sha256} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";
import {isWithinPath} from "./workspace.js";
import {DockerBackend, type DockerIdentity} from "./dockerBackend.js";

export const LOCKED_NODE_BASE = "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
export interface CapsuleRecipe {
  executable: string; argv: readonly string[]; cwd?: string; environment?: Readonly<Record<string,string>>;
  max_runtime_ms?: number; max_output_bytes?: number; max_files_bytes?: number;
}
export interface SealedCapsule {
  schema: "resonarch.toolfabric.sealed-capsule/v1"; image_id:string; image_layers:readonly string[];
  input_digest:string; recipe_digest:string; recipe:Readonly<CapsuleRecipe>; backend: DockerIdentity; digest:string;
}

async function prospectiveAbsolute(path:string):Promise<string> {
  let probe=resolve(path);const tail:string[]=[];
  while(true) {
    try {return resolve(await realpath(probe),...tail);}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      const parent=resolve(probe,"..");if(parent===probe)throw error;
      tail.unshift(relative(parent,probe));probe=parent;
    }
  }
}

export interface SnapshotOptions {max_input_bytes?:number;on_entry_opened?:(path:string,kind:"file"|"directory")=>void|Promise<void>;}
type InputEntry={path:string;kind:string;sha256:string;mode:number};

async function windowsSnapshot(source:string,destination:string,options:SnapshotOptions):Promise<InputEntry[]> {
  const helper=spawn(resolve("dist/native/toolfabric-snapshot-host.exe"),[source,destination,options.on_entry_opened?"observe":"quiet",String(options.max_input_bytes??512*1024*1024)],
    {windowsHide:true,stdio:["pipe","pipe","pipe"],shell:false});
  const lines=createInterface({input:helper.stdout});let errors="",manifest:InputEntry[]|undefined,failure:unknown,chain=Promise.resolve();
  const timeout=setTimeout(()=>{failure=new Error("snapshot helper timeout");helper.kill();},120000);
  helper.stderr.on("data",bytes=>{errors=(errors+bytes).slice(0,2048);});
  lines.on("line",line=>{chain=chain.then(async()=>{
    const event=JSON.parse(line);
    if(event.type==="entry"){await options.on_entry_opened?.(event.path,event.kind);helper.stdin.write("continue\n");}
    else if(event.type==="done")manifest=event.manifest;
    else throw new Error("invalid snapshot protocol");
  }).catch(error=>{failure=error;helper.kill();});});
  const code=await new Promise<number|null>((done)=>{helper.once("error",error=>{failure=error;done(null);});helper.once("close",done);});
  clearTimeout(timeout);await chain;lines.close();
  if(failure)throw failure;
  if(code!==0||!manifest){const code=errors.match(/CAPSULE_(?:INPUT_LIMIT|SYMLINK_FORBIDDEN|SPECIAL_FILE_FORBIDDEN|SOURCE_UNSUPPORTED)/)?.[0]??"CAPSULE_INPUT_OPEN_FAILED";
    throw new RuntimeExecutionError(code,errors||"secure Windows input copy failed","denied");}
  return manifest;
}

export async function snapshotInputs(source: string, destination: string, options:SnapshotOptions={}): Promise<string> {
  const maximum=options.max_input_bytes??512*1024*1024;
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>512*1024*1024)throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT","host input limit must be between 1 byte and 512 MiB","denied");
  const root = await realpath(source);
  if (!isAbsolute(destination) || isWithinPath(root, await prospectiveAbsolute(destination))) throw new RuntimeExecutionError("INVALID_CAPSULE_CONTEXT", "snapshot must be outside live inputs", "denied");
  if(process.platform==="win32") {
    const manifest=await windowsSnapshot(root,destination,options);
    for(const entry of manifest)await chmod(join(destination,entry.path),entry.mode);
    await chmod(destination,0o555);
    return canonicalDigest(manifest.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))));
  }
  if(process.platform!=="linux")throw new RuntimeExecutionError("CAPSULE_SOURCE_UNSUPPORTED","secure input snapshots require Windows or Linux","denied");
  const manifest:InputEntry[] = [];
  let total = 0; let count = 0;
  async function pin(path:string,directory=false):Promise<FileHandle> {
    try{return await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));}
    catch(error){throw new RuntimeExecutionError("CAPSULE_INPUT_OPEN_FAILED","input entry changed or cannot be opened without following symlinks: "+(error as NodeJS.ErrnoException).code,"denied");}
  }
  async function walk(input:FileHandle, output: string, prefix:string): Promise<void> {
    await mkdir(output, {recursive:true});
    const entries = (await readdir("/proc/self/fd/"+input.fd)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    for (const name of entries) {
      if (++count>20000) throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT", "input snapshot has too many entries", "denied");
      // Every component is resolved relative to a pinned directory, never to a live ancestor pathname.
      const entry=await pin("/proc/self/fd/"+input.fd+"/"+name),to=join(output,name),path=prefix?prefix+"/"+name:name;
      try {
        const info=await entry.stat();
        if(info.isFile()||info.isDirectory())await options.on_entry_opened?.(path,info.isFile()?"file":"directory");
        if(info.isDirectory()){manifest.push({path,kind:"directory",sha256:sha256("directory"),mode:0o555});await walk(entry,to,path);}
        else if(info.isFile()) {
          if(info.size>maximum-total)throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT","input snapshot exceeds host byte limit","denied");
          const chunks:Buffer[]=[];const buffer=Buffer.alloc(65536);
          while(true){const {bytesRead}=await entry.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;
            if(total>maximum)throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT","actual input bytes exceed host limit","denied");chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));}
          const bytes=Buffer.concat(chunks),mode=info.mode&0o111?0o555:0o444;
          await writeFile(to,bytes,{flag:"wx"});await chmod(to,mode);manifest.push({path,kind:"file",sha256:sha256(bytes),mode});
        } else throw new RuntimeExecutionError("CAPSULE_SPECIAL_FILE_FORBIDDEN","only regular files and directories may be sealed","denied");
      } finally{await entry.close();}
    }
    await chmod(output,0o555);
  }
  // Pin the canonical root from / one component at a time, including its ancestors.
  let current=await pin("/",true);
  try {
    for(const component of root.split("/").filter(Boolean)){const next=await pin("/proc/self/fd/"+current.fd+"/"+component,true);await current.close();current=next;}
    await walk(current,destination,"");
  } finally{await current.close();}
  return canonicalDigest(manifest.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))));
}

export async function sealCapsule(backend: DockerBackend, source: string, context: string, recipe: CapsuleRecipe): Promise<SealedCapsule> {
  if (!recipe.executable.startsWith("/") || recipe.executable.includes("\0") || recipe.argv.some(arg=>typeof arg!=="string"||arg.includes("\0"))) {
    throw new RuntimeExecutionError("INVALID_CAPSULE_RECIPE", "recipe must bind a literal container executable and argv", "denied");
  }
  const cwd = recipe.cwd ?? "/input";
  if (cwd!=="/input" && !cwd.startsWith("/input/")) throw new RuntimeExecutionError("INVALID_CAPSULE_RECIPE", "recipe cwd must be in sealed inputs", "denied");
  const fixed = {executable:recipe.executable,argv:[...recipe.argv],cwd,environment:{...(recipe.environment??{})},
    max_runtime_ms:recipe.max_runtime_ms??10000,max_output_bytes:recipe.max_output_bytes??65536,max_files_bytes:recipe.max_files_bytes??1048576};
  if (!Number.isInteger(fixed.max_runtime_ms)||fixed.max_runtime_ms<100||fixed.max_runtime_ms>120000
      ||!Number.isInteger(fixed.max_output_bytes)||fixed.max_output_bytes<1||fixed.max_output_bytes>1048576
      ||!Number.isInteger(fixed.max_files_bytes)||fixed.max_files_bytes<1||fixed.max_files_bytes>1048576) {
    throw new RuntimeExecutionError("INVALID_CAPSULE_RECIPE", "invalid sealed resource limits", "denied");
  }
  if(isWithinPath(await realpath(source),await prospectiveAbsolute(context)))throw new RuntimeExecutionError("INVALID_CAPSULE_CONTEXT","build context must be outside live source","denied");
  await mkdir(context,{recursive:true});
  if ((await readdir(context)).length!==0) throw new RuntimeExecutionError("CAPSULE_CONTEXT_NOT_EMPTY", "use a fresh context to avoid undeclared files", "denied");
  const inputDigest = await snapshotInputs(source,join(context,"input"));
  await mkdir(join(context,"broker"));
  for(const name of ["capsuleRunner.cjs","capsuleReader.cjs"]) {
    await writeFile(join(context,"broker",name),await readFile(resolve("src/runtime",name)));
  }
  await writeFile(join(context,"recipe.json"),canonicalJson(fixed));
  await writeFile(join(context,"Dockerfile"),`FROM ${LOCKED_NODE_BASE}\nUSER 0\nCOPY input/ /input/\nCOPY broker/ /broker/\nCOPY recipe.json /broker/recipe.json\nRUN chmod 0555 /broker/*.cjs && chmod 0400 /broker/recipe.json\nENTRYPOINT ["/usr/local/bin/node", "/broker/capsuleRunner.cjs"]\n`);
  const identity = await backend.identity();
  const tag = "toolfabric-capsule:"+canonicalDigest({inputDigest,fixed,broker:sha256(await readFile(join(context,"broker/capsuleRunner.cjs")))}).slice(7,47);
  await backend.command(["build","--network=none","--platform=linux/amd64","--tag",tag,await backend.hostPath(context)],180000);
  const image = await backend.inspectImage(tag);
  if(image.Os!=="linux"||image.Architecture!=="amd64"||!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new RuntimeExecutionError("CAPSULE_IMAGE_INVALID", "unexpected sealed image identity", "denied");
  const body = {schema:"resonarch.toolfabric.sealed-capsule/v1" as const,image_id:image.Id,image_layers:Object.freeze([...image.RootFS.Layers]),
    input_digest:inputDigest,recipe_digest:canonicalDigest(fixed),recipe:Object.freeze(fixed),backend:identity};
  return Object.freeze({...body,digest:canonicalDigest(body)});
}

export async function verifyCapsule(backend: DockerBackend, capsule: SealedCapsule): Promise<void> {
  const {digest,...body}=capsule;
  if(canonicalDigest(body)!==digest || (await backend.identity()).digest!==capsule.backend.digest) throw new RuntimeExecutionError("CAPSULE_IDENTITY_DRIFT", "capsule or backend identity changed", "denied");
  const image = await backend.inspectImage(capsule.image_id);
  if(image.Id!==capsule.image_id || canonicalDigest(image.RootFS.Layers)!==canonicalDigest(capsule.image_layers)) {
    throw new RuntimeExecutionError("CAPSULE_DEPENDENCY_DRIFT", "immutable image/rootfs identity changed", "denied");
  }
}
