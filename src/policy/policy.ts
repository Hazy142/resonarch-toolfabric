import type {RiskClass} from "../contracts/types.js";
const ORDER:Record<RiskClass,number>={R0:0,R1:1,R2:2,R3:3,R4:4};
export interface Capability{id:string;resource:string;operations:string[];risk_ceiling:RiskClass;delegable:boolean;}
export interface Action{operation:string;resource:string;risk:RiskClass;}
export function authorize(action:Action,caps:readonly Capability[]):{allowed:boolean;capability?:string}{
 const cap=caps.find(c=>c.operations.includes(action.operation)&&ORDER[action.risk]<=ORDER[c.risk_ceiling]&&(c.resource==="*"||action.resource===c.resource||action.resource.startsWith(c.resource+"/")));
 return cap?{allowed:true,capability:cap.id}:{allowed:false};
}
