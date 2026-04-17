#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { registerTools } from "./mcp/register-tools.js";

type TransportMode = "stdio" | "http";

type CliConfig = {
  transport: TransportMode;
  host: string;
  port: number;
  path: string;
  statelessHttp: boolean;
};

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "specbridge-mcp",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function parseArgs(argv: string[]): CliConfig {
  const envTransport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
  let transport: TransportMode = envTransport === "http" ? "http" : "stdio";

  let host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  let port = Number(process.env.MCP_HTTP_PORT || process.env.PORT || 3000);
  let path = process.env.MCP_HTTP_PATH || "/mcp";
  let statelessHttp = (process.env.MCP_HTTP_STATELESS || "").toLowerCase() === "true";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--http") {
      transport = "http";
      continue;
    }

    if (arg === "--stdio") {
      transport = "stdio";
      continue;
    }

    if (arg === "--transport") {
      const value = argv[i + 1]?.toLowerCase();
      if (value !== "stdio" && value !== "http") {
        throw new Error("--transport must be 'stdio' or 'http'.");
      }
      transport = value;
      i += 1;
      continue;
    }

    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--host requires a value.");
      }
      host = value;
      i += 1;
      continue;
    }

    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--port must be a positive integer.");
      }
      port = value;
      i += 1;
      continue;
    }

    if (arg === "--path") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--path requires a value.");
      }
      path = value.startsWith("/") ? value : `/${value}`;
      i += 1;
      continue;
    }

    if (arg === "--stateless") {
      statelessHttp = true;
      continue;
    }

    if (arg === "--stateful") {
      statelessHttp = false;
    }
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("MCP_HTTP_PORT/PORT must be a positive integer.");
  }

  return { transport, host, port, path, statelessHttp };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("specbridge-mcp running on stdio");
}

async function startHttpServer(config: CliConfig): Promise<void> {
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== config.path) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      if (req.method === "POST") {
        const body = await readJsonBody(req);

        if (config.statelessHttp) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          const server = createMcpServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        } else {
          let transport: StreamableHTTPServerTransport;
          if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
          } else if (!sessionId && body && isInitializeRequest(body)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                transports[newSessionId] = transport;
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                delete transports[sid];
              }
            };

            const server = createMcpServer();
            await server.connect(transport);
          } else {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: No valid session ID provided",
                },
                id: null,
              }),
            );
            return;
          }

          await transport.handleRequest(req, res, body);
          return;
        }
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (config.statelessHttp) {
          res.statusCode = 405;
          res.setHeader("allow", "POST");
          res.end("Method Not Allowed in stateless mode");
          return;
        }

        if (!sessionId || !transports[sessionId]) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
          return;
        }

        await transports[sessionId].handleRequest(req, res);
        return;
      }

      res.statusCode = 405;
      res.setHeader("allow", "GET, POST, DELETE");
      res.end("Method Not Allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message,
          },
          id: null,
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  console.error(
    `specbridge-mcp running on http://${config.host}:${config.port}${config.path} (${config.statelessHttp ? "stateless" : "stateful"})`,
  );

  const shutdown = async () => {
    for (const id of Object.keys(transports)) {
      try {
        await transports[id].close();
      } catch {
        // ignore close errors during shutdown
      }
      delete transports[id];
    }

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  if (config.transport === "http") {
    await startHttpServer(config);
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});
