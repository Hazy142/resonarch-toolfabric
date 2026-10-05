export type RiskClass="R0"|"R1"|"R2"|"R3"|"R4";
export type ResultStatus="succeeded"|"failed"|"denied"|"cancelled"|"partial"|"uncertain";
export interface ToolDescriptor {
 schema:"resonarch.toolfabric.tool/v1"; id:string; version:string; title:string; summary:string;
 input_schema:Record<string,unknown>; output_schema:Record<string,unknown>;
 capabilities:string[]; authority_scope:string[]; risk_class:RiskClass;
 side_effect:"none"|"local"|"process"|"filesystem"|"repository"|"external"|"release"|"projection";
 idempotency:"pure"|"idempotent"|"conditional"|"non_idempotent";
 network:"forbidden"|"optional"|"required"; receipt:"required"|"optional"|"forbidden";
 default_timeout_ms:number; max_output_bytes:number;
}
