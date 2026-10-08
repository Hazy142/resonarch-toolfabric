import {chmod, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile} from "node:fs/promises";
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

export async function snapshotInputs(source: string, destination: string): Promise<string> {
  const root = await realpath(source);
  if (!isAbsolute(destination) || isWithinPath(root, await prospectiveAbsolute(destination))) throw new RuntimeExecutionError("INVALID_CAPSULE_CONTEXT", "snapshot must be outside live inputs", "denied");
  const manifest: Array<{path:string;kind:string;sha256:string;mode:number}> = [];
  let total = 0; let count = 0;
  async function walk(input: string, output: string): Promise<void> {
    await mkdir(output, {recursive:true});
    const entries = (await readdir(input)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    for (const name of entries) {
      if (++count>20000) throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT", "input snapshot has too many entries", "denied");
      const from = join(input,name); const to = join(output,name); const info = await lstat(from);
      const path = relative(root,from).replaceAll("\\","/");
      if (info.isSymbolicLink()) throw new RuntimeExecutionError("CAPSULE_SYMLINK_FORBIDDEN", "input symlinks must be materialized by the host before sealing", "denied");
      if (info.isDirectory()) {manifest.push({path,kind:"directory",sha256:sha256("directory"),mode:0o555});await walk(from,to);}
      else if (info.isFile()) {
        total += info.size;
        if (total>512*1024*1024) throw new RuntimeExecutionError("CAPSULE_INPUT_LIMIT", "input snapshot exceeds 512 MiB", "denied");
        const bytes = await readFile(from); const mode = info.mode & 0o111 ? 0o555 : 0o444;
        await writeFile(to,bytes);await chmod(to,mode);
        manifest.push({path,kind:"file",sha256:sha256(bytes),mode});
      } else throw new RuntimeExecutionError("CAPSULE_SPECIAL_FILE_FORBIDDEN", "only regular files and directories may be sealed", "denied");
    }
    await chmod(output,0o555);
  }
  await walk(root,destination);
  return canonicalDigest(manifest);
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
