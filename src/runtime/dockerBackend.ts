import {execFile as callbackExecFile} from "node:child_process";
import {promisify} from "node:util";
import {isAbsolute} from "node:path";
import {canonicalDigest} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "./errors.js";

const execFile = promisify(callbackExecFile);
export interface DockerBackendOptions {
  executable: string;
  prefix_args?: readonly string[];
  config_directory?: string;
  wsl_distribution?: string;
}
export interface DockerIdentity {id: string; version: string; kernel: string; os: string; architecture: string; digest: string;}

// Host configuration only. Tool/model arguments cannot set launcher, endpoint, flags or mounts.
export class DockerBackend {
  readonly options: Readonly<DockerBackendOptions>;
  constructor(options: DockerBackendOptions) {
    if (!isAbsolute(options.executable)) throw new RuntimeExecutionError("INVALID_DOCKER_CONFIG", "Docker launcher must be a host-owned absolute executable", "denied");
    this.options = Object.freeze({...options, prefix_args: Object.freeze([...(options.prefix_args ?? [])])});
  }
  async hostPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new RuntimeExecutionError("INVALID_DOCKER_PATH", "host paths must be absolute", "denied");
    if (!this.options.wsl_distribution) return path;
    const converted = await execFile(this.options.executable, ["-d", this.options.wsl_distribution, "--exec", "wslpath", "-u", path],
      {windowsHide:true,timeout:10000,encoding:"utf8",maxBuffer:65536});
    const value = converted.stdout.trim();
    if (!value.startsWith("/") || value.includes("\n") || value.includes("\0")) throw new RuntimeExecutionError("INVALID_DOCKER_PATH", "invalid WSL path mapping", "denied");
    return value;
  }
  async command(args: readonly string[], timeout = 30000): Promise<string> {
    if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new RuntimeExecutionError("INVALID_DOCKER_ARGUMENT", "invalid Docker argument", "denied");
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "HOME", "USERPROFILE", "TMP", "TEMP"]) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const configured = this.options.config_directory ? ["--config", await this.hostPath(this.options.config_directory)] : [];
    try {
      const result = await execFile(this.options.executable, [...this.options.prefix_args!, ...configured,
        "--host", "unix:///var/run/docker.sock", ...args], {windowsHide:true,encoding:"utf8",timeout,
        maxBuffer:8*1024*1024,env:environment,shell:false});
      return result.stdout.trim();
    } catch (error) {
      const e = error as NodeJS.ErrnoException & {stderr?:string};
      throw new RuntimeExecutionError("DOCKER_COMMAND_FAILED", (e.stderr ?? e.message).slice(0,2048));
    }
  }
  async identity(): Promise<DockerIdentity> {
    const value = JSON.parse(await this.command(["info","--format","{{json .}}"]));
    const body = {id:value.ID,version:value.ServerVersion,kernel:value.KernelVersion,os:value.OSType,architecture:value.Architecture};
    if (Object.values(body).some(x=>typeof x!=="string"||!x) || body.os!=="linux") {
      throw new RuntimeExecutionError("ISOLATION_BACKEND_UNSUPPORTED", "hardened jobs require a real Linux Docker engine", "denied");
    }
    return {...body,digest:canonicalDigest(body)};
  }
  async inspectImage(reference: string): Promise<any> {return JSON.parse(await this.command(["image","inspect",reference]))[0];}
  async inspectContainer(reference: string): Promise<any | null> {
    try {return JSON.parse(await this.command(["container","inspect",reference]))[0];}
    catch (error) {
      if (error instanceof RuntimeExecutionError && /No such (object|container)/i.test(error.message)) return null;
      throw error;
    }
  }
}
