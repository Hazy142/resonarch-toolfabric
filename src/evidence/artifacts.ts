import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {sha256} from "../contracts/canonical.js";
export class ArtifactStore{
 constructor(readonly root:string){}
 async put(bytes:Uint8Array):Promise<string>{const digest=sha256(bytes);await mkdir(this.root,{recursive:true});await writeFile(join(this.root,digest.slice(7)),bytes);return "artifact://"+digest;}
 async get(ref:string):Promise<Uint8Array>{const digest=ref.replace(/^artifact:\/\//,"");const data=await readFile(join(this.root,digest.slice(7)));if(sha256(data)!==digest)throw new Error("ARTIFACT_DIGEST_MISMATCH");return data;}
}
