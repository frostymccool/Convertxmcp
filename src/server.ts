import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConvertXClient } from "./convertx/client.js";
import { FileGateway } from "./files.js";
import { registerTools } from "./tools/index.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { sessionOptionsFromConfig } from "./convertx/session.js";
import type { Config } from "./config.js";
import { Redactor } from "./vault/index.js";

export interface BuildOptions {
  redactor?: Redactor;
  fetchImpl?: typeof fetch;
}

/** Wires config into a ready-to-connect MCP server. */
export function buildServer(config: Config, options: BuildOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new ConvertXClient({
    ...sessionOptionsFromConfig(config),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    pollIntervalMs: config.pollIntervalMs,
    convertTimeoutMs: config.convertTimeoutMs,
  });

  const files = new FileGateway({
    allowedInputDirs: config.allowedInputDirs,
    outputDir: config.outputDir,
    maxFileBytes: config.maxFileBytes,
  });

  registerTools(server, {
    client,
    files,
    redactor: options.redactor ?? new Redactor(),
    outputDir: config.outputDir,
  });

  return server;
}
