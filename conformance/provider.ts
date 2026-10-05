import type {ToolDescriptor,ResultStatus} from "../src/contracts/types.js";
export interface ProviderAdapter{id:string;version:string;capabilities():Promise<string[]>;projectToolDescriptor(tool:ToolDescriptor):unknown;normalizeResult(result:unknown):{status:ResultStatus;output:unknown};}
export const REQUIRED_RESULT_STATES:ResultStatus[]=["succeeded","failed","denied","cancelled","partial","uncertain"];
export function assertAdapterResultStates(states:readonly string[]):void{for(const state of REQUIRED_RESULT_STATES){if(!states.includes(state))throw new Error("ADAPTER_STATE_LOSS:"+state);}}
