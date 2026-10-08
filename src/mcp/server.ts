import {createServer as createHttpServer, type Server as HttpServer} from "node:http";
import {createMcpHandler, McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import {localhostHostValidation, localhostOriginValidation, toNodeHandler} from "@modelcontextprotocol/node";
import type {ToolDescriptor} from "../contracts/types.js";
import {RuntimeExecutionError} from "../runtime/errors.js";
import {standardJsonSchema} from "./schema.js";
import {ToolFabricMcpRuntime} from "./runtime.js";

const SERVER_INFO = {name: "resonarch-toolfabric", version: "0.1.0"};

const META_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_id: {type: "string", minLength: 1, maxLength: 128},
    trace_id: {type: "string", minLength: 1, maxLength: 128},
    expected_state: {type: "object", additionalProperties: true},
    approval_ref: {type: "string", minLength: 1, maxLength: 128},
    idempotency_key: {type: "string", minLength: 1, maxLength: 128},
    deadline_ms: {type: "integer", minimum: 1},
  },
};

const EXECUTION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["result", "receipts"],
  properties: {
    result: {type: "object", additionalProperties: true},
    receipts: {type: "array", items: {type: "object", additionalProperties: true}},
  },
};

function mcpInputSchema(descriptor: ToolDescriptor): Record<string, unknown> {
  const base = structuredClone(descriptor.input_schema);
  if (base.type !== "object") {
    throw new RuntimeExecutionError("MCP_SCHEMA_UNSUPPORTED", `${descriptor.id} input_schema must have object root`, "denied");
  }
  const properties = base.properties;
  if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
    throw new RuntimeExecutionError("MCP_SCHEMA_UNSUPPORTED", `${descriptor.id} properties must be an object`, "denied");
  }
  return {
    ...base,
    properties: {
      ...((properties as Record<string, unknown> | undefined) ?? {}),
      _toolfabric: META_SCHEMA,
    },
  };
}

function annotations(descriptor: ToolDescriptor) {
  return {
    readOnlyHint: descriptor.side_effect === "none",
    destructiveHint: descriptor.side_effect !== "none",
    idempotentHint: descriptor.idempotency === "pure" || descriptor.idempotency === "idempotent",
    openWorldHint: descriptor.network !== "forbidden",
  };
}

function descriptorMeta(descriptor: ToolDescriptor): Record<string, unknown> {
  return {
    "resonarch.toolfabric/tool": {
      schema: descriptor.schema,
      id: descriptor.id,
      version: descriptor.version,
      risk_class: descriptor.risk_class,
      capabilities: descriptor.capabilities,
      authority_scope: descriptor.authority_scope,
      side_effect: descriptor.side_effect,
      idempotency: descriptor.idempotency,
      network: descriptor.network,
      receipt: descriptor.receipt,
    },
  };
}

function safeError(error: unknown): {code: string; message: string} {
  if (error instanceof RuntimeExecutionError) return {code: error.code, message: error.message};
  return {code: "MCP_EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error)};
}

export function createToolFabricMcpServer(runtime: ToolFabricMcpRuntime): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const descriptor of runtime.listDescriptors()) {
    server.registerTool(
      descriptor.id,
      {
        title: descriptor.title,
        description: descriptor.summary,
        inputSchema: standardJsonSchema(mcpInputSchema(descriptor)),
        outputSchema: standardJsonSchema(EXECUTION_OUTPUT_SCHEMA),
        annotations: annotations(descriptor),
        _meta: descriptorMeta(descriptor),
      },
      async input => {
        try {
          const execution = await runtime.execute(descriptor.id, input);
          const structuredContent = {result: execution.result, receipts: execution.receipts};
          return {
            content: [{type: "text" as const, text: JSON.stringify(structuredContent)}],
            structuredContent,
            ...(execution.result.status === "succeeded" ? {} : {isError: true}),
          };
        } catch (error) {
          const detail = safeError(error);
          return {
            isError: true,
            content: [{type: "text" as const, text: JSON.stringify(detail)}],
          };
        }
      },
    );
  }
  return server;
}

export function serveToolFabricStdio(runtime: ToolFabricMcpRuntime): ReturnType<typeof serveStdio> {
  return serveStdio(() => createToolFabricMcpServer(runtime));
}

export interface McpHttpServerHandle {
  readonly server: HttpServer;
  readonly url: string;
  close(): Promise<void>;
}

export async function serveToolFabricHttp(
  runtime: ToolFabricMcpRuntime,
  options: {host?: string; port?: number} = {},
): Promise<McpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new RuntimeExecutionError(
      "MCP_REMOTE_BIND_FORBIDDEN",
      "P3B HTTP is loopback-only until authenticated remote serving is implemented",
      "denied",
    );
  }
  const handler = createMcpHandler(() => createToolFabricMcpServer(runtime));
  const nodeHandler = toNodeHandler(handler, {maxRequestBodySize: 4 * 1024 * 1024});
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createHttpServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/mcp") {
      res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
      res.end("Not Found");
      return;
    }
    void nodeHandler(req, res).catch(error => {
      console.error("[toolfabric:mcp:http]", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    });
  });
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP_HTTP_ADDRESS_UNAVAILABLE");
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    server,
    url: `http://${displayHost}:${address.port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
