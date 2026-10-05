import {readFile} from "node:fs/promises";
export interface SourceRecord{repository:string;revision:string;path:string;role:string;}
export async function sourceRegistry(path="docs/sources/source-registry.json"):Promise<SourceRecord[]>{
 const value=JSON.parse(await readFile(path,"utf8")) as {schema:string;sources:SourceRecord[]};
 if(value.schema!=="resonarch.toolfabric.sources/v1")throw new Error("INVALID_SOURCE_REGISTRY");
 return [...value.sources].sort((a,b)=>(a.repository+"/"+a.path).localeCompare(b.repository+"/"+b.path));
}
