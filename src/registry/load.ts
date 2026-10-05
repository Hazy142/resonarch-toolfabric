import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import type {ToolDescriptor} from "../contracts/types.js";
import {assertToolDescriptor} from "../contracts/validate.js";
export async function loadRegistry(root="contracts/tools"):Promise<ToolDescriptor[]>{
 const out:ToolDescriptor[]=[];
 const families=(await readdir(root,{withFileTypes:true})).filter(x=>x.isDirectory());
 for(const family of families){for(const name of await readdir(join(root,family.name))){if(!name.endsWith(".json"))continue;const value=JSON.parse(await readFile(join(root,family.name,name),"utf8"));assertToolDescriptor(value);out.push(value);}}
 out.sort((a,b)=>a.id.localeCompare(b.id));
 if(out.length!==112)throw new Error("REGISTRY_COUNT:"+out.length);
 if(new Set(out.map(x=>x.id)).size!==112)throw new Error("REGISTRY_DUPLICATE_ID");
 return out;
}
