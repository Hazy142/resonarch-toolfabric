import type {ResultStatus} from "../contracts/types.js";

export class RuntimeExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: Extract<ResultStatus, "failed" | "denied" | "cancelled"> = "failed",
  ) {
    super(message);
    this.name = "RuntimeExecutionError";
  }
}
