export type RetrievalKind="explicit_ref"|"exact"|"lexical"|"structured"|"semantic";

export interface ReadMemoryRecord{
  id:string;
  kind:string;
  text:string;
  keys?:readonly string[];
  metadata?:Readonly<Record<string,unknown>>;
}

export const RETRIEVAL_ORDER:RetrievalKind[]=["explicit_ref","exact","lexical","structured","semantic"];

export function requiresRawReload(_kind:RetrievalKind,willClaimOrAct:boolean):boolean{
  return willClaimOrAct;
}
