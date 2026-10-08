#!/usr/bin/env node
import {loadRegistry} from "./registry/load.js";
import {compileWorkflow, loadUserTool} from "./workflows/compiler.js";
import {loadMcpConfig} from "./mcp/config.js";
import {ToolFabricMcpRuntime} from "./mcp/runtime.js";
import {serveToolFabricHttp, serveToolFabricStdio} from "./mcp/server.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function usage(): never {
  console.error(
    "Usage: toolfabric registry | toolfabric workflow <id> | "
    + "toolfabric mcp stdio --config <file> | toolfabric mcp http --config <file> [--port <n>]",
  );
  process.exitCode = 2;
  throw new Error("USAGE");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "registry") {
    console.log(JSON.stringify(await loadRegistry(), null, 2));
    return;
  }
  if (command === "workflow" && args[0]) {
    console.log(JSON.stringify(compileWorkflow(await loadUserTool(args[0])), null, 2));
    return;
  }
  if (command !== "mcp") usage();

  const mode = args[0];
  const configPath = flag(args, "--config");
  if (!configPath || (mode !== "stdio" && mode !== "http")) usage();
  const runtime = await ToolFabricMcpRuntime.create(await loadMcpConfig(configPath));
  if (mode === "stdio") {
    serveToolFabricStdio(runtime);
    console.error("[toolfabric:mcp] stdio ready");
    return;
  }

  const rawPort = flag(args, "--port");
  const port = rawPort === undefined ? 8787 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  const handle = await serveToolFabricHttp(runtime, {port});
  console.error(`[toolfabric:mcp] HTTP ready at ${handle.url}`);
  const close = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch(error => {
  if (error instanceof Error && error.message === "USAGE") return;
  console.error("[toolfabric]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
