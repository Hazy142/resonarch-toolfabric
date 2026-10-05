import type {TaskNode} from "./types.js";
export function readyNodes(nodes:readonly TaskNode[]):TaskNode[]{
 const complete=new Set(nodes.filter(n=>n.state==="completed").map(n=>n.id));
 return nodes.filter(n=>n.state==="ready"&&n.depends_on.every(d=>complete.has(d)));
}
export function writesConflict(a:TaskNode,b:TaskNode):boolean{
 return a.write_surfaces.some(x=>b.write_surfaces.some(y=>x===y||x.startsWith(y+"/")||y.startsWith(x+"/")));
}
export function parallelBatch(nodes:readonly TaskNode[]):TaskNode[]{
 const selected:TaskNode[]=[];
 for(const node of readyNodes(nodes)){if(selected.every(other=>!writesConflict(other,node)))selected.push(node);}
 return selected;
}
