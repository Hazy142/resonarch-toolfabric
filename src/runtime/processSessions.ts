import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";
import {BoundedProcessOutput} from "./processOutput.js";
import type {BoundProcessPlan} from "./processPlan.js";
import {processFileDigest} from "./processPlan.js";
import {RuntimeExecutionError} from "./errors.js";

export type ProcessState = "starting" | "running" | "exited" | "stopped" | "timed_out" | "launch_failed" | "uncertain";
export interface SessionSnapshot {
  session_id: string; revision: number; state: ProcessState; task_id: string; workspace_root: string;
  plan_id: string; plan_digest: string; execution_grant: "host-user"; supervisor_pid: number | null;
  process_pid: number | null; exit_code: number | null; signal: string | null; started_at: string; finished_at: string | null;
}
interface Session {
  snapshot: SessionSnapshot;
  plan: BoundProcessPlan;
  child: ChildProcessWithoutNullStreams;
  output: BoundedProcessOutput;
  done: Promise<void>;
  settle: () => void;
  timer?: NodeJS.Timeout;
  stopReason?: "stop" | "deadline";
}

export class ProcessSessions {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  constructor(private readonly windowsHost?: {path: string; digest: string},
    private readonly maxActive = 4, private readonly maxRetained = 32) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 16 || !Number.isInteger(maxRetained)
        || maxRetained < maxActive || maxRetained > 256) {
      throw new RuntimeExecutionError("INVALID_SESSION_LIMIT", "invalid host session limits", "denied");
    }
  }

  private owned(id: string, task: string, workspace: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new RuntimeExecutionError("SESSION_NOT_FOUND", "unknown managed session", "denied");
    if (session.snapshot.task_id !== task || session.snapshot.workspace_root !== workspace) {
      throw new RuntimeExecutionError("SESSION_SCOPE_MISMATCH", "session belongs to a different task or workspace", "denied");
    }
    return session;
  }

  snapshot(id: string, task: string, workspace: string): SessionSnapshot {
    return {...this.owned(id, task, workspace).snapshot};
  }

  assertRevision(id: string, task: string, workspace: string, expected: unknown): void {
    const session = this.owned(id, task, workspace);
    if (!Number.isInteger(expected) || expected !== session.snapshot.revision) {
      throw new RuntimeExecutionError("EXPECTED_STATE_MISMATCH", "session revision changed", "denied");
    }
  }

  list(task: string, workspace: string): SessionSnapshot[] {
    return [...this.sessions.values()].filter(s => s.snapshot.task_id === task && s.snapshot.workspace_root === workspace)
      .map(s => ({...s.snapshot}));
  }

  read(id: string, task: string, workspace: string, stdoutOffset = 0, stderrOffset = 0, bytes = 16 * 1024) {
    const session = this.owned(id, task, workspace);
    return {session: {...session.snapshot}, ...session.output.read(stdoutOffset, stderrOffset, bytes)};
  }

  private assertAdmission(): void {
    if (this.closed) throw new RuntimeExecutionError("PROCESS_RUNTIME_CLOSED", "runtime is closed", "denied");
    if ([...this.sessions.values()].filter(s => !s.snapshot.finished_at).length >= this.maxActive) {
      throw new RuntimeExecutionError("PROCESS_CAPACITY_EXCEEDED", "active session limit reached", "denied");
    }
  }

  async start(plan: BoundProcessPlan, task: string, deadline: string): Promise<SessionSnapshot> {
    this.assertAdmission();
    if (process.platform === "win32") {
      if (!this.windowsHost || await processFileDigest(this.windowsHost.path) !== this.windowsHost.digest) {
        throw new RuntimeExecutionError("PROCESS_HOST_DRIFT", "Windows supervisor is missing or changed", "denied");
      }
    }
    // Admission and session reservation must have no async gap. close() or another start may
    // have run during supervisor hashing; do not spawn after shutdown or above the capacity.
    this.assertAdmission();
    if (this.sessions.size >= this.maxRetained) {
      const oldest = [...this.sessions.entries()].find(([, s]) => s.snapshot.finished_at);
      if (!oldest) throw new RuntimeExecutionError("PROCESS_CAPACITY_EXCEEDED", "retained session limit reached", "denied");
      this.sessions.delete(oldest[0]);
    }
    const lifetime = Math.min(plan.max_runtime_ms, Date.parse(deadline) - Date.now());
    if (lifetime <= 0) throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "launch deadline elapsed", "cancelled");
    const captured = new BoundedProcessOutput(plan.max_output_bytes);
    const launchId = randomUUID();
    const command = process.platform === "win32" ? this.windowsHost!.path : plan.executable;
    const argv = process.platform === "win32" ? [launchId, plan.executable, ...plan.argv] : [...plan.argv];
    const child = spawn(command, argv, {cwd: plan.cwd_absolute, env: {...plan.environment}, shell: false,
      detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let doneResolve!: () => void;
    const done = new Promise<void>(resolve => { doneResolve = resolve; });
    const session: Session = {plan, child, done, settle: doneResolve, output: captured, snapshot: {
      session_id: randomUUID(), revision: 1, state: "starting", task_id: task, workspace_root: plan.workspace_root,
      plan_id: plan.id, plan_digest: plan.digest, execution_grant: "host-user", supervisor_pid: child.pid ?? null,
      process_pid: process.platform === "win32" ? null : child.pid ?? null, exit_code: null, signal: null,
      started_at: new Date().toISOString(), finished_at: null,
    }};
    this.sessions.set(session.snapshot.session_id, session);
    let handshake = Buffer.alloc(0);
    const acknowledge = () => { session.snapshot.state = "running"; readyResolve(); };
    child.once("spawn", () => { if (process.platform !== "win32") acknowledge(); });
    child.stdout.on("data", (bytes: Buffer) => {
      if (process.platform === "win32" && session.snapshot.state === "starting") {
        handshake = Buffer.concat([handshake, bytes]);
        const newline = handshake.indexOf(10);
        if (newline < 0 && handshake.byteLength <= 512) return;
        const header = newline >= 0 ? handshake.subarray(0, newline).toString("utf8").trimEnd() : "";
        const prefix = `TOOLFABRIC_PROCESS_READY:${launchId}:`;
        const pid = header.startsWith(prefix) ? Number(header.slice(prefix.length)) : Number.NaN;
        if (newline > 512 || !Number.isSafeInteger(pid) || pid <= 0) {
          readyReject(new Error("INVALID_PROCESS_HOST_HANDSHAKE"));
          void this.terminate(session, "stop").catch(() => { session.snapshot.state = "uncertain"; });
          return;
        }
        session.snapshot.process_pid = pid;
        acknowledge();
        session.output.append("stdout", handshake.subarray(newline + 1));
        handshake = Buffer.alloc(0);
      } else session.output.append("stdout", bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => session.output.append("stderr", bytes));
    child.stdin.on("error", () => { /* Individual input acknowledgements retain their own errors. */ });
    child.once("error", error => readyReject(error));
    child.once("exit", () => {
      // Ordinary descendants remain in this POSIX group. Windows closes its job in the supervisor.
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") session.snapshot.state = "uncertain"; }
      }
    });
    child.once("close", (code, signal) => {
      if (session.timer) clearTimeout(session.timer);
      if (session.snapshot.state === "starting") readyReject(new Error("PROCESS_HOST_NOT_READY"));
      if (session.snapshot.state !== "uncertain") session.snapshot.state = session.stopReason === "deadline" ? "timed_out"
        : session.stopReason === "stop" ? "stopped" : session.snapshot.state === "starting" ? "launch_failed" : "exited";
      session.snapshot.revision++;
      session.snapshot.exit_code = code;
      session.snapshot.signal = signal;
      session.snapshot.finished_at = new Date().toISOString();
      doneResolve();
    });
    session.timer = setTimeout(() => { void this.terminate(session, "deadline").catch(() => { session.snapshot.state = "uncertain"; }); }, lifetime);
    session.timer.unref();
    try { await ready; return {...session.snapshot}; }
    catch (error) {
      await this.terminate(session, "stop");
      throw new RuntimeExecutionError("PROCESS_LAUNCH_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async terminate(session: Session, reason: "stop" | "deadline"): Promise<void> {
    if (session.snapshot.finished_at) return;
    session.stopReason = reason;
    try {
      if (process.platform === "win32") {
        if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill("SIGKILL");
      } else if (session.child.pid) {
        try { process.kill(-session.child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([session.done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROCESS_TERMINATION_UNCONFIRMED")), 5000);
      })]); } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      session.snapshot.state = "uncertain";
      // A process outside a POSIX group may keep inherited pipes open. Do not wait forever or claim cleanup.
      session.child.stdout.destroy();
      session.child.stderr.destroy();
      session.child.stdin.destroy();
      session.settle();
      throw error;
    }
  }

  async input(id: string, task: string, workspace: string, data: string, eof: boolean, deadline: string): Promise<number> {
    const session = this.owned(id, task, workspace);
    if (!session.plan.allow_input) throw new RuntimeExecutionError("PROCESS_INPUT_FORBIDDEN", "host plan does not permit stdin", "denied");
    if (session.snapshot.state !== "running" || session.child.stdin.destroyed) throw new RuntimeExecutionError("PROCESS_NOT_RUNNING", "session is not running", "denied");
    const bytes = Buffer.from(data, "utf8");
    const remaining = Date.parse(deadline) - Date.now();
    if (remaining <= 0) throw new RuntimeExecutionError("DEADLINE_EXCEEDED", "input deadline elapsed", "cancelled");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([new Promise<void>((resolve, reject) => {
        if (eof) session.child.stdin.end(bytes, (error?: Error | null) => error ? reject(error) : resolve());
        else session.child.stdin.write(bytes, error => error ? reject(error) : resolve());
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROCESS_INPUT_ACK_TIMEOUT")), remaining); })]);
      session.snapshot.revision++;
      return bytes.byteLength;
    } finally { if (timer) clearTimeout(timer); }
  }

  async stop(id: string, task: string, workspace: string): Promise<SessionSnapshot> {
    const session = this.owned(id, task, workspace);
    await this.terminate(session, "stop");
    return {...session.snapshot};
  }

  async wait(id: string, task: string, workspace: string): Promise<SessionSnapshot> {
    const session = this.owned(id, task, workspace);
    await session.done;
    return {...session.snapshot};
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].filter(s => !s.snapshot.finished_at).map(s => this.terminate(s, "stop")));
  }
}
