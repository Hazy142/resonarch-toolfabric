export type InstructionTier = "user" | "task_contract" | "repo" | "path" | "role" | "tool" | "retrieved_data";
export interface InstructionSource { id:string; tier:InstructionTier; digest:string; scope:string; content:string; }
const PRECEDENCE:Record<InstructionTier,number>={user:0,task_contract:1,repo:2,path:3,role:4,tool:5,retrieved_data:6};
export function resolveInstructionOrder(sources:readonly InstructionSource[]):InstructionSource[]{return [...sources].sort((a,b)=>PRECEDENCE[a.tier]-PRECEDENCE[b.tier]||a.id.localeCompare(b.id));}
export function mayActAsInstruction(source:InstructionSource):boolean{return source.tier!=="retrieved_data";}
