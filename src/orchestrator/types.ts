export type TaskState="draft"|"scoped"|"planned"|"ready"|"executing"|"verifying"|"review"|"completed"|"blocked"|"uncertain"|"cancelled";
export interface TaskNode{id:string;depends_on:string[];write_surfaces:string[];state:TaskState;}
export interface Lease{lease_id:string;node_id:string;worker_id:string;generation:number;fencing_token:string;expires_at:number;}
export interface HandoffPackage{task_id:string;brief_ref:string;instruction_manifest_ref:string;context_manifest_ref:string;evidence_manifest_ref:string;open_findings:string[];artifact_refs:string[];next_action:string;}
