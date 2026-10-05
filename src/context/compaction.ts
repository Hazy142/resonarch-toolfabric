export interface ToolHistory{call_id:string;tool:string;state:"open"|"closed";args_digest:string;result_digest?:string;artifact_refs:string[];}
export interface CompactRecord{call_id:string;tool:string;args_digest:string;result_digest:string;artifact_refs:string[];}
export function compactClosedTools(items:readonly ToolHistory[]):{warm:CompactRecord[];hot:ToolHistory[]}{
 const warm:CompactRecord[]=[];const hot:ToolHistory[]=[];
 for(const item of items){
  if(item.state==="closed"&&item.result_digest){warm.push({call_id:item.call_id,tool:item.tool,args_digest:item.args_digest,result_digest:item.result_digest,artifact_refs:[...item.artifact_refs]});}
  else hot.push(item);
 }
 return {warm,hot};
}
