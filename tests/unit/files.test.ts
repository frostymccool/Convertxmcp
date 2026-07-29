import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileGateway, isWithin, sanitizeFileName } from "../../src/files.js";

let root: string;
let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "files-test-"));
  inputDir = join(root, "in");
  outputDir = join(root, "out");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

function gateway(overrides: Partial<ConstructorParameters<typeof FileGateway>[0]> = {}) {
  return new FileGateway({
    allowedInputDirs: [inputDir],
    outputDir,
    maxFileBytes: 1024,
    ...overrides,
  });
}

describe("isWithin", () => {
  it("accepts a directory and its descendants", () => {
    expect(isWithin("/srv/in", "/srv/in")).toBe(true);
    expect(isWithin("/srv/in", "/srv/in/a/b.txt")).toBe(true);
  });

  it("rejects siblings that merely share a prefix", () => {
    expect(isWithin("/srv/in", "/srv/input-other/x")).toBe(false);
    expect(isWithin("/srv/in", "/srv/out")).toBe(false);
  });
});

describe("FileGateway.readSource", () => {
  it("reads a file inside an allowed directory", async () => {
    const path = join(inputDir, "a.txt");
    await writeFile(path, "hello");

    const content = await gateway().readSource(path);
    expect(new TextDecoder().decode(content)).toBe("hello");
  });

  it("refuses a relative path", async () => {
    await expect(gateway().readSource("a.txt")).rejects.toThrow(/absolute path/);
  });

  it("refuses a path outside the allow-list", async () => {
    const outside = join(root, "secret.txt");
    await writeFile(outside, "nope");

    await expect(gateway().readSource(outside)).rejects.toThrow(/CONVERTX_ALLOWED_INPUT_DIRS/);
  });

  it("refuses traversal out of an allowed directory", async () => {
    const outside = join(root, "secret.txt");
    await writeFile(outside, "nope");

    await expect(gateway().readSource(join(inputDir, "..", "secret.txt"))).rejects.toThrow(
      /outside every directory/,
    );
  });

  it("refuses a symlink that escapes the allow-list", async () => {
    const outside = join(root, "secret.txt");
    await writeFile(outside, "nope");
    const link = join(inputDir, "link.txt");
    await symlink(outside, link);

    await expect(gateway().readSource(link)).rejects.toThrow(/outside every directory/);
  });

  it("refuses every read when the allow-list is empty", async () => {
    const path = join(inputDir, "a.txt");
    await writeFile(path, "hello");

    await expect(gateway({ allowedInputDirs: [] }).readSource(path)).rejects.toThrow(
      /disabled because CONVERTX_ALLOWED_INPUT_DIRS is empty/,
    );
  });

  it("reports a missing file plainly", async () => {
    await expect(gateway().readSource(join(inputDir, "nope.txt"))).rejects.toThrow(/No such file/);
  });

  it("refuses a directory", async () => {
    await expect(gateway().readSource(inputDir)).rejects.toThrow(/not a regular file/);
  });

  it("enforces the size cap", async () => {
    const path = join(inputDir, "big.bin");
    await writeFile(path, Buffer.alloc(2048));

    await expect(gateway().readSource(path)).rejects.toThrow(/CONVERTX_MAX_FILE_BYTES/);
  });
});

describe("FileGateway.writeOutput", () => {
  it("resolves a path inside the output directory", async () => {
    const path = await gateway().writeOutput(undefined, "result.pdf");
    expect(path).toBe(join(outputDir, "result.pdf"));
  });

  it("creates and uses a subdirectory", async () => {
    const path = await gateway().writeOutput("scans/2026", "result.pdf");
    expect(path).toBe(join(outputDir, "scans/2026/result.pdf"));
  });

  it("refuses a subdirectory that escapes the output directory", async () => {
    await expect(gateway().writeOutput("../elsewhere", "x.pdf")).rejects.toThrow(
      /outside CONVERTX_OUTPUT_DIR/,
    );
  });

  it("strips any directory component from the file name", async () => {
    const path = await gateway().writeOutput(undefined, "../../etc/passwd");
    expect(path).toBe(join(outputDir, "passwd"));
  });
});

describe("FileGateway.decodeBase64", () => {
  it("decodes valid base64", () => {
    const decoded = gateway().decodeBase64(Buffer.from("hello").toString("base64"));
    expect(new TextDecoder().decode(decoded)).toBe("hello");
  });

  it("rejects input that is not base64 at all", () => {
    expect(() => gateway().decodeBase64("!!!!")).toThrow(/not valid base64/);
  });

  it("enforces the size cap on inline input", () => {
    const big = Buffer.alloc(2048).toString("base64");
    expect(() => gateway().decodeBase64(big)).toThrow(/CONVERTX_MAX_FILE_BYTES/);
  });
});

describe("sanitizeFileName", () => {
  it("strips directory components", () => {
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\windows\\system32")).toBe("system32");
  });

  it("replaces characters that are unsafe in a filename", () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.pdf')).toBe("a_b_c_d_e_f_g_h.pdf");
  });

  it("falls back to a usable name for degenerate input", () => {
    expect(sanitizeFileName("")).toBe("output");
    expect(sanitizeFileName("..")).toBe("output");
  });

  it("keeps ordinary names, including spaces and dashes, intact", () => {
    expect(sanitizeFileName("My Holiday Photo-2.heic")).toBe("My Holiday Photo-2.heic");
  });
});
