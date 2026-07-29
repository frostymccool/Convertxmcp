/**
 * Exercises the tools through a real MCP client over an in-memory transport,
 * so schema validation, tool registration and result shaping are all covered
 * the same way a real client would hit them.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { FakeConvertX } from "../fixtures/fake-convertx.js";

const CREDENTIALS = { email: "me@home.lan", password: "hunter2" };

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "tools-test-"));
  inputDir = join(root, "in");
  outputDir = join(root, "out");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

async function connect(fake: FakeConvertX): Promise<Client> {
  const config = await loadConfig({
    CONVERTX_BASE_URL: "http://convertx.lan:3000",
    CONVERTX_EMAIL: CREDENTIALS.email,
    CONVERTX_PASSWORD: CREDENTIALS.password,
    CONVERTX_ALLOWED_INPUT_DIRS: inputDir,
    CONVERTX_OUTPUT_DIR: outputDir,
    CONVERTX_POLL_INTERVAL_MS: "100",
  });

  const server = buildServer(config, { fetchImpl: fake.fetch });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Pulls the structured payload out of a tool result. */
function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function textOf(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content
    .map((c) => c.text)
    .join("\n");
}

describe("tool registration", () => {
  it("exposes exactly the documented tools", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "convertx_convert_file",
      "convertx_health",
      "convertx_list_formats",
    ]);
  });

  it("annotates the read-only tools as such", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));
    const { tools } = await client.listTools();

    const listFormats = tools.find((t) => t.name === "convertx_list_formats");
    expect(listFormats?.annotations?.readOnlyHint).toBe(true);

    const convert = tools.find((t) => t.name === "convertx_convert_file");
    expect(convert?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("convertx_health", () => {
  it("reports a reachable instance", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));
    const result = await client.callTool({ name: "convertx_health", arguments: {} });

    expect(structured<{ reachable: boolean }>(result).reachable).toBe(true);
    expect(textOf(result)).toMatch(/reachable/);
  });
});

describe("convertx_list_formats", () => {
  it("returns the targets grouped by converter", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));
    const result = await client.callTool({
      name: "convertx_list_formats",
      arguments: { input_format: "docx" },
    });

    const payload = structured<{ count: number; targets: { target: string }[] }>(result);
    expect(payload.count).toBe(3);
    expect(payload.targets.map((t) => t.target)).toContain("pdf");
    expect(textOf(result)).toMatch(/libreoffice/);
  });

  it("says so plainly when a format is not supported", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS, targets: [] }));
    const result = await client.callTool({
      name: "convertx_list_formats",
      arguments: { input_format: "xyz" },
    });

    expect(structured<{ count: number }>(result).count).toBe(0);
    expect(textOf(result)).toMatch(/no conversions from 'xyz'/);
  });

  it("rejects a call with no input format", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    // Schema violations come back as an error result, not a thrown exception.
    const result = await client.callTool({ name: "convertx_list_formats", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/input_format/);
  });
});

describe("convertx_convert_file", () => {
  it("converts a file from disk and writes the result to the output directory", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));
    const sourcePath = join(inputDir, "report.docx");
    await writeFile(sourcePath, "contents");

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: { source_path: sourcePath, target_format: "pdf" },
    });

    const payload = structured<{
      target: string;
      converter: string;
      files: { file_name: string; path: string; bytes: number }[];
    }>(result);

    expect(payload.target).toBe("pdf");
    expect(payload.converter).toBe("libreoffice");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.path).toBe(join(outputDir, "report.pdf"));

    await expect(readFile(payload.files[0]!.path, "utf8")).resolves.toBe("converted:report.pdf");
  });

  it("converts inline base64 input", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        source_base64: Buffer.from("contents").toString("base64"),
        source_file_name: "photo.png",
        target_format: "jpg",
      },
    });

    const payload = structured<{ files: { file_name: string }[] }>(result);
    expect(payload.files[0]!.file_name).toBe("photo.jpg");
  });

  it("writes into a requested subdirectory", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        source_base64: Buffer.from("x").toString("base64"),
        source_file_name: "a.docx",
        target_format: "pdf",
        output_subdir: "2026/july",
      },
    });

    const payload = structured<{ files: { path: string }[] }>(result);
    expect(payload.files[0]!.path).toBe(join(outputDir, "2026/july/a.pdf"));
  });

  it("returns the bytes inline when asked", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        source_base64: Buffer.from("x").toString("base64"),
        source_file_name: "a.docx",
        target_format: "pdf",
        return_content: true,
      },
    });

    const payload = structured<{ files: { content_base64?: string }[] }>(result);
    expect(Buffer.from(payload.files[0]!.content_base64!, "base64").toString()).toBe(
      "converted:a.pdf",
    );
  });

  it("requires exactly one of source_path and source_base64", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const neither = await client.callTool({
      name: "convertx_convert_file",
      arguments: { target_format: "pdf" },
    });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toMatch(/exactly one of source_path or source_base64/);

    const both = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        target_format: "pdf",
        source_path: join(inputDir, "a.docx"),
        source_base64: "eA==",
      },
    });
    expect(both.isError).toBe(true);
  });

  it("requires an extension on an inline file name", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        source_base64: "eA==",
        source_file_name: "noextension",
        target_format: "pdf",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/must include the extension/);
  });

  it("surfaces an unsupported conversion as a tool error naming the alternatives", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: {
        source_base64: "eA==",
        source_file_name: "a.docx",
        target_format: "xyz",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Available targets for docx/);
  });

  it("refuses to read a file outside the allow-list", async () => {
    const client = await connect(new FakeConvertX({ credentials: CREDENTIALS }));

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: { source_path: "/etc/passwd", target_format: "pdf" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/CONVERTX_ALLOWED_INPUT_DIRS/);
  });

  it("keeps the ConvertX password out of error text", async () => {
    // A failing instance must not echo the credential back through the error.
    const fake = new FakeConvertX({ credentials: { email: "me@home.lan", password: "other" } });
    const client = await connect(fake);

    const result = await client.callTool({
      name: "convertx_convert_file",
      arguments: { source_base64: "eA==", source_file_name: "a.docx", target_format: "pdf" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("hunter2");
  });
});
