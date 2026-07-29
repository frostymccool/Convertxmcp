#!/usr/bin/env node
/**
 * Entry point for convertx-mcp-server.
 *
 * Two transports are supported:
 *   - `stdio`  (default) for a local MCP client that spawns this as a subprocess
 *   - `http`   for a long-lived service on the LAN, which is the Proxmox case
 *
 * Nothing is ever written to stdout: under stdio that stream is the MCP channel
 * itself, so all logging goes to stderr.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { buildServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { Vault, type Redactor } from "./vault/index.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function log(redactor: Redactor, message: string): void {
  process.stderr.write(`${redactor.redact(message)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? undefined : JSON.parse(raw);
}

async function runStdio(config: Config, redactor: Redactor): Promise<void> {
  const server = buildServer(config, { redactor });
  await server.connect(new StdioServerTransport());
  log(redactor, `${SERVER_NAME} ${SERVER_VERSION} ready on stdio -> ${config.baseUrl}`);
}

async function runHttp(config: Config, redactor: Redactor): Promise<void> {
  const mcp = buildServer(config, { redactor });

  // Stateless: a transport per request avoids request-id collisions between
  // concurrent clients and keeps the service trivially restartable.
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
        return;
      }

      if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. POST JSON-RPC to /mcp." }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => void transport.close());

      try {
        const body = await readJsonBody(req);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        log(redactor, `Request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed request" }));
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    http.listen(config.httpPort, config.httpHost, resolve);
  });

  log(
    redactor,
    `${SERVER_NAME} ${SERVER_VERSION} listening on ` +
      `http://${config.httpHost}:${config.httpPort}/mcp -> ${config.baseUrl}`,
  );

  const shutdown = (signal: string): void => {
    log(redactor, `Received ${signal}, shutting down.`);
    http.close(() => process.exit(0));
    // Do not let a wedged in-flight conversion hold the process open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
  const vault = Vault.default();
  const redactor = vault.redactor;

  let config: Config;
  try {
    config = await loadConfig(process.env, vault);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  if (config.transport === "http") {
    await runHttp(config, redactor);
  } else {
    await runStdio(config, redactor);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
