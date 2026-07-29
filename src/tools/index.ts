import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extname } from "node:path";
import { ConvertXClient, normalizeFormat } from "../convertx/client.js";
import { describeError } from "../convertx/errors.js";
import { FileGateway, sanitizeFileName } from "../files.js";
import type { Redactor } from "../vault/index.js";
import { CHARACTER_LIMIT, INLINE_RESULT_BYTE_LIMIT } from "../constants.js";

export interface ToolContext {
  client: ConvertXClient;
  files: FileGateway;
  redactor: Redactor;
  outputDir: string;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Wraps a handler so every failure becomes a readable, secret-free tool error
 * rather than a protocol-level exception.
 */
function guard(redactor: Redactor, handler: () => Promise<ToolResult>): () => Promise<ToolResult> {
  return async () => {
    try {
      return await handler();
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: redactor.redact(describeError(error)) }],
      };
    }
  };
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[truncated at ${CHARACTER_LIMIT} characters — narrow the request to see the rest]`
  );
}

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: truncate(text) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerHealth(server, ctx);
  registerListFormats(server, ctx);
  registerConvert(server, ctx);
}

function registerHealth(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "convertx_health",
    {
      title: "Check ConvertX availability",
      description:
        "Reports whether the configured ConvertX instance is reachable and responding.\n\n" +
        "Use this first when another tool fails with a connection error, to tell a misconfigured " +
        "CONVERTX_BASE_URL apart from a ConvertX instance that is down.\n\n" +
        "Returns: { reachable: boolean, status: string }",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(ctx.redactor, async () => {
      const health = await ctx.client.health();
      return ok(
        health.reachable
          ? `ConvertX is reachable (status: ${health.status}).`
          : `ConvertX is not healthy: ${health.status}.`,
        { ...health },
      );
    }),
  );
}

const ListFormatsInput = {
  input_format: z
    .string()
    .min(1)
    .max(32)
    .describe("Source file extension, with or without a dot. Examples: 'png', '.docx', 'mp4'."),
};

function registerListFormats(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "convertx_list_formats",
    {
      title: "List available target formats",
      description:
        "Lists every format the ConvertX instance can convert a given input format into, and " +
        "which converter performs each one.\n\n" +
        "The exact set depends on which converters are installed in that ConvertX image, so this " +
        "is the authoritative source — call it before convertx_convert_file when unsure whether " +
        "a conversion is supported.\n\n" +
        "Args:\n" +
        "  - input_format (string): source extension, e.g. 'png'\n\n" +
        "Returns: { input_format: string, count: number, targets: [{ target, converter }] }\n\n" +
        "Examples:\n" +
        "  - 'What can I turn a HEIC into?' -> input_format='heic'\n" +
        "  - 'Can this box make PDFs from Word docs?' -> input_format='docx', look for target 'pdf'",
      inputSchema: ListFormatsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { input_format: string }) =>
      guard(ctx.redactor, async () => {
        const inputFormat = normalizeFormat(args.input_format);
        const targets = await ctx.client.listTargets(inputFormat);

        if (targets.length === 0) {
          return ok(
            `This ConvertX instance offers no conversions from '${inputFormat}'. Check the ` +
              `extension is right, and that the image includes a converter that reads it.`,
            { input_format: inputFormat, count: 0, targets: [] },
          );
        }

        const byConverter = new Map<string, string[]>();
        for (const t of targets) {
          const list = byConverter.get(t.converter) ?? [];
          list.push(t.target);
          byConverter.set(t.converter, list);
        }

        const lines = [`# Conversions available from .${inputFormat}`, ""];
        for (const [converter, list] of [...byConverter].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`**${converter}** (${list.length}): ${list.sort().join(", ")}`);
        }

        return ok(lines.join("\n"), {
          input_format: inputFormat,
          count: targets.length,
          targets,
        });
      })(),
  );
}

const ConvertInput = {
  target_format: z
    .string()
    .min(1)
    .max(32)
    .describe("Format to convert into, with or without a dot. Example: 'pdf'."),
  source_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to the input file, resolved on the machine running this server. Must sit " +
        "inside a directory listed in CONVERTX_ALLOWED_INPUT_DIRS. Provide this or source_base64.",
    ),
  source_base64: z
    .string()
    .optional()
    .describe("Base64-encoded file contents. Provide this or source_path."),
  source_file_name: z
    .string()
    .optional()
    .describe(
      "File name (with extension) for source_base64. Required with source_base64, because " +
        "ConvertX picks the converter from the extension.",
    ),
  converter: z
    .string()
    .optional()
    .describe(
      "Converter to use, e.g. 'imagemagick'. Omit to let the server pick the first converter " +
        "offering the target, which is what the ConvertX web UI does.",
    ),
  output_subdir: z
    .string()
    .optional()
    .describe("Optional subdirectory under CONVERTX_OUTPUT_DIR to write results into."),
  return_content: z
    .boolean()
    .default(false)
    .describe(
      "When true, also return the converted bytes base64-encoded in the response. Only do this " +
        "for small files — large ones will overflow the context.",
    ),
};

type ConvertArgs = {
  target_format: string;
  source_path?: string;
  source_base64?: string;
  source_file_name?: string;
  converter?: string;
  output_subdir?: string;
  return_content?: boolean;
};

function registerConvert(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "convertx_convert_file",
    {
      title: "Convert a file",
      description:
        "Converts one file into another format using the self-hosted ConvertX instance, and " +
        "writes the result into the server's output directory.\n\n" +
        "Supply the input either as source_path (a path on this server) or as source_base64 " +
        "together with source_file_name. The conversion runs to completion before this returns.\n\n" +
        "Args:\n" +
        "  - target_format (string): e.g. 'pdf'\n" +
        "  - source_path (string, optional): absolute path on this server\n" +
        "  - source_base64 + source_file_name (optional): inline input\n" +
        "  - converter (string, optional): force a specific converter\n" +
        "  - output_subdir (string, optional): subdirectory under the output directory\n" +
        "  - return_content (boolean): also return bytes inline (default false)\n\n" +
        "Returns: { job_id, target, converter, files: [{ file_name, status, path, bytes, " +
        "content_base64? }] }\n\n" +
        "Examples:\n" +
        "  - 'Convert /srv/scans/receipt.png to PDF' -> source_path='/srv/scans/receipt.png', " +
        "target_format='pdf'\n" +
        "  - 'Turn this attachment into a JPEG' -> source_base64=..., source_file_name='x.heic', " +
        "target_format='jpg'\n\n" +
        "Errors:\n" +
        "  - Unsupported pairs name the formats that are available instead.\n" +
        "  - Conversions exceeding CONVERTX_CONVERT_TIMEOUT_MS report how far they got.",
      inputSchema: ConvertInput,
      annotations: {
        readOnlyHint: false,
        // Writes new files into the output directory; never overwrites inputs.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: ConvertArgs) =>
      guard(ctx.redactor, async () => {
        const source = await resolveSource(ctx, args);

        const result = await ctx.client.convert([source], args.target_format, args.converter);

        const files = [];
        for (const file of result.files) {
          const path = await ctx.files.writeOutput(args.output_subdir, file.fileName);
          await ctx.files.persist(path, file.content);

          const inlineable =
            args.return_content === true && file.content.byteLength <= INLINE_RESULT_BYTE_LIMIT;

          files.push({
            file_name: file.fileName,
            status: file.status,
            path,
            bytes: file.content.byteLength,
            ...(inlineable ? { content_base64: Buffer.from(file.content).toString("base64") } : {}),
            ...(args.return_content === true && !inlineable
              ? {
                  content_omitted:
                    `File is ${file.content.byteLength} bytes, over the ` +
                    `${INLINE_RESULT_BYTE_LIMIT}-byte inline limit; read it from 'path' instead.`,
                }
              : {}),
          });
        }

        const summary = [
          `Converted to ${result.target} using ${result.converter} (job ${result.jobId}).`,
          "",
          ...files.map((f) => `- ${f.file_name} (${f.bytes} bytes) -> ${f.path}`),
        ].join("\n");

        return ok(summary, {
          job_id: result.jobId,
          target: result.target,
          converter: result.converter,
          files,
        });
      })(),
  );
}

/** Turns the tool's two input styles into a single source file. */
async function resolveSource(
  ctx: ToolContext,
  args: ConvertArgs,
): Promise<{ fileName: string; content: Uint8Array }> {
  const hasPath = typeof args.source_path === "string" && args.source_path !== "";
  const hasInline = typeof args.source_base64 === "string" && args.source_base64 !== "";

  if (hasPath === hasInline) {
    throw new Error(
      "Provide exactly one of source_path or source_base64 (source_base64 also needs " +
        "source_file_name).",
    );
  }

  if (hasPath) {
    const path = args.source_path!;
    return { fileName: path, content: await ctx.files.readSource(path) };
  }

  const fileName = args.source_file_name;
  if (!fileName || extname(fileName) === "") {
    throw new Error(
      "source_file_name is required with source_base64 and must include the extension — " +
        "ConvertX chooses the converter from it.",
    );
  }

  return {
    fileName: sanitizeFileName(fileName),
    content: ctx.files.decodeBase64(args.source_base64!),
  };
}
