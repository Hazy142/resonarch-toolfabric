export type RetrievalKind="explicit_ref"|"exact"|"lexical"|"structured"|"semantic";
export const RETRIEVAL_ORDER:RetrievalKind[]=["explicit_ref","exact","lexical","structured","semantic"];
export function requiresRawReload(kind:RetrievalKind,willClaimOrAct:boolean):boolean{return willClaimOrAct&&kind==="semantic";}
