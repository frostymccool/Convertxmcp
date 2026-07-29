import { describe, expect, it } from "vitest";
import { ConvertXClient, normalizeFormat } from "../../src/convertx/client.js";
import { ConversionError, RequestError, TimeoutError } from "../../src/convertx/errors.js";
import { FakeConvertX } from "../fixtures/fake-convertx.js";

const CREDENTIALS = { email: "me@home.lan", password: "hunter2" };

function clientFor(fake: FakeConvertX, overrides: Record<string, unknown> = {}): ConvertXClient {
  return new ConvertXClient({
    baseUrl: "http://convertx.lan:3000",
    webroot: "",
    unauthenticated: false,
    credentials: CREDENTIALS,
    requestTimeoutMs: 5_000,
    pollIntervalMs: 1,
    convertTimeoutMs: 5_000,
    fetchImpl: fake.fetch,
    // Poll without real delay; the polling contract is asserted, not the clock.
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

const source = (name = "report.docx") => ({
  fileName: name,
  content: new TextEncoder().encode("hello"),
});

describe("normalizeFormat", () => {
  it("lowercases and strips a leading dot", () => {
    expect(normalizeFormat(".PNG")).toBe("png");
    expect(normalizeFormat("  Pdf ")).toBe("pdf");
  });
});

describe("ConvertXClient.health", () => {
  it("reports a healthy instance", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));
    await expect(client.health()).resolves.toEqual({ reachable: true, status: "ok" });
  });

  it("reports an unhealthy instance without throwing", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const broken: typeof fetch = () => Promise.resolve(new Response("nope", { status: 502 }));
    const client = clientFor(fake, { fetchImpl: broken });

    await expect(client.health()).resolves.toEqual({ reachable: false, status: "HTTP 502" });
  });
});

describe("ConvertXClient.listTargets", () => {
  it("lists what the instance can produce from a format", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));

    await expect(client.listTargets("docx")).resolves.toEqual([
      { target: "pdf", converter: "libreoffice" },
      { target: "png", converter: "imagemagick" },
      { target: "jpg", converter: "imagemagick" },
    ]);
  });

  it("accepts a format written with a leading dot", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));
    await expect(client.listTargets(".DOCX")).resolves.toHaveLength(3);
  });

  it("rejects an empty format", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));
    await expect(client.listTargets("  ")).rejects.toBeInstanceOf(RequestError);
  });
});

describe("ConvertXClient.convert", () => {
  it("runs the full upload/convert/poll/download workflow", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const client = clientFor(fake);

    const result = await client.convert([source()], "pdf");

    expect(result.target).toBe("pdf");
    expect(result.converter).toBe("libreoffice");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.fileName).toBe("report.pdf");
    expect(new TextDecoder().decode(result.files[0]!.content)).toBe("converted:report.pdf");

    const paths = fake.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /upload");
    expect(paths).toContain("POST /convert");
    expect(paths).toContain("GET /download/7/1000/report.pdf");
  });

  it("polls until ConvertX reports the job finished", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS, pollsBeforeDone: 3 });
    const client = clientFor(fake);

    await client.convert([source()], "pdf");

    expect(fake.requests.filter((r) => r.path.startsWith("/progress/"))).toHaveLength(4);
  });

  it("infers the converter from the source extension when not told", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const client = clientFor(fake);

    const result = await client.convert([source("photo.png")], "jpg");

    expect(result.converter).toBe("imagemagick");
  });

  it("honours an explicitly requested converter without looking one up", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const client = clientFor(fake);

    await client.convert([source()], "pdf", "libreoffice");

    expect(fake.requests.filter((r) => r.path === "/conversions")).toHaveLength(0);
  });

  it("names the available targets when the pair is unsupported", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));

    await expect(client.convert([source()], "xyz")).rejects.toThrow(/Available targets for docx/);
  });

  it("rejects a source with no extension when no converter is given", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));

    await expect(client.convert([source("README")], "pdf")).rejects.toThrow(/no extension/);
  });

  it("reports a converter ConvertX refuses", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));

    await expect(client.convert([source()], "pdf", "nonexistent")).rejects.toThrow(
      /not one it offers/,
    );
  });

  it("requires at least one source file", async () => {
    const client = clientFor(new FakeConvertX({ credentials: CREDENTIALS }));
    await expect(client.convert([], "pdf")).rejects.toBeInstanceOf(RequestError);
  });

  it("raises a conversion error when every file fails", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS, failConversion: true });
    const client = clientFor(fake);

    await expect(client.convert([source()], "pdf")).rejects.toBeInstanceOf(ConversionError);
  });

  it("times out with the progress it managed to observe", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS, pollsBeforeDone: 1_000 });
    const client = clientFor(fake, { convertTimeoutMs: 0 });

    await expect(client.convert([source()], "pdf")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("blames the cleanup policy when a finished file cannot be downloaded", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const brokenDownload: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname.startsWith("/download/")) {
        return Promise.resolve(new Response("gone", { status: 500 }));
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, { fetchImpl: brokenDownload });

    await expect(client.convert([source()], "pdf")).rejects.toThrow(/AUTO_DELETE_EVERY_N_HOURS/);
  });

  it("reports a job that vanished between starting and polling", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const lostJob: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname.startsWith("/progress/")) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, { fetchImpl: lostJob });

    await expect(client.convert([source()], "pdf")).rejects.toThrow(/no job/);
  });

  it("fails clearly when the upload is rejected", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const rejectingUpload: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/upload") {
        return Promise.resolve(new Response("too large", { status: 413 }));
      }
      return fake.fetch(input, init);
    };
    const client = clientFor(fake, { fetchImpl: rejectingUpload });

    await expect(client.convert([source()], "pdf")).rejects.toThrow(/body size/);
  });

  it("converts several files in one job", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const client = clientFor(fake);

    const result = await client.convert([source("a.docx"), source("b.docx")], "pdf");

    expect(result.files.map((f) => f.fileName).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("works against an anonymous instance, giving each job its own identity", async () => {
    const fake = new FakeConvertX({ allowUnauthenticated: true });
    const client = clientFor(fake, { credentials: null, unauthenticated: true });

    const first = await client.convert([source("a.docx")], "pdf");
    const second = await client.convert([source("b.docx")], "pdf");

    expect(first.files[0]!.fileName).toBe("a.pdf");
    expect(second.files[0]!.fileName).toBe("b.pdf");
    expect(first.jobId).not.toBe(second.jobId);
  });
});
