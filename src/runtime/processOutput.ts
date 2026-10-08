import {RuntimeExecutionError} from "./errors.js";

export class BoundedProcessOutput {
  private readonly buffers: Record<"stdout" | "stderr", Buffer>;
  private readonly lengths = {stdout: 0, stderr: 0};
  private readonly seen = {stdout: 0, stderr: 0};

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
      throw new RuntimeExecutionError("INVALID_OUTPUT_BUDGET", "output budget must be 1..1048576 bytes", "denied");
    }
    this.buffers = {stdout: Buffer.alloc(maxBytes), stderr: Buffer.alloc(maxBytes)};
  }

  append(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    this.seen[stream] += bytes.byteLength;
    const count = Math.min(bytes.byteLength, this.maxBytes - this.lengths.stdout - this.lengths.stderr);
    this.buffers[stream].set(bytes.subarray(0, count), this.lengths[stream]);
    this.lengths[stream] += count;
  }

  read(stdoutOffset: number, stderrOffset: number, maxBytes: number) {
    if (!Number.isInteger(stdoutOffset) || stdoutOffset < 0 || stdoutOffset > this.lengths.stdout
        || !Number.isInteger(stderrOffset) || stderrOffset < 0 || stderrOffset > this.lengths.stderr) {
      throw new RuntimeExecutionError("INVALID_OUTPUT_CURSOR", "cursor is outside retained output", "denied");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
      throw new RuntimeExecutionError("INVALID_OUTPUT_PAGE_SIZE", "page size must be 1..1048576 bytes", "denied");
    }
    const stdoutNext = Math.min(this.lengths.stdout, stdoutOffset + maxBytes);
    const stderrNext = Math.min(this.lengths.stderr, stderrOffset + maxBytes - (stdoutNext - stdoutOffset));
    const retained = this.lengths.stdout + this.lengths.stderr;
    const discarded = this.seen.stdout + this.seen.stderr - retained;
    return {
      stdout_base64: this.buffers.stdout.subarray(stdoutOffset, stdoutNext).toString("base64"),
      stderr_base64: this.buffers.stderr.subarray(stderrOffset, stderrNext).toString("base64"),
      stdout_next: stdoutNext,
      stderr_next: stderrNext,
      stdout_retained: this.lengths.stdout,
      stderr_retained: this.lengths.stderr,
      stdout_seen: this.seen.stdout,
      stderr_seen: this.seen.stderr,
      retained_bytes: retained,
      discarded_bytes: discarded,
      truncated: discarded > 0,
    };
  }
}
