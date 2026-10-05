export type ImplementationStatus = "absent" | "partial" | "implemented";
export type ExecutionStatus = "not_run" | "executed" | "failed";
export type VerificationStatus = "unverified" | "verified" | "rejected";
export type ClaimStatus = "supported" | "contradicted" | "not_shown" | "open" | "diagnostic";
export type MaturityStatus = "research" | "candidate" | "releasable" | "released" | "deprecated";
export interface StatusAxes { implementation:ImplementationStatus; execution:ExecutionStatus; verification:VerificationStatus; claim:ClaimStatus; maturity:MaturityStatus; }
export const INITIAL_STATUS:StatusAxes=Object.freeze({implementation:"absent",execution:"not_run",verification:"unverified",claim:"open",maturity:"research"});
