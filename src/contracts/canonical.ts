import {createHash} from "node:crypto";
function normalize(value:unknown):unknown{
 if(Array.isArray(value)) return value.map(normalize);
 if(value&&typeof value==="object") return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)]));
 if(typeof value==="number"&&!Number.isFinite(value)) throw new TypeError("NON_FINITE_CANONICAL_NUMBER");
 return value;
}
export function canonicalJson(value:unknown):string{return JSON.stringify(normalize(value));}
export function sha256(value:string|Uint8Array):string{return "sha256:"+createHash("sha256").update(value).digest("hex");}
export function canonicalDigest(value:unknown):string{return sha256(canonicalJson(value));}
