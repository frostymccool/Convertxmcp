import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  CONVERTX_BASE_URL: "http://convertx.lan:3000",
  CONVERTX_EMAIL: "me@home.lan",
  CONVERTX_PASSWORD: "hunter2",
};

describe("loadConfig", () => {
  it("builds a config from the minimum required environment", async () => {
    const config = await loadConfig({ ...base });

    expect(config.baseUrl).toBe("http://convertx.lan:3000");
    expect(config.credentials).toEqual({ email: "me@home.lan", password: "hunter2" });
    expect(config.transport).toBe("stdio");
  });

  it("rejects a base URL that is not absolute", async () => {
    await expect(loadConfig({ ...base, CONVERTX_BASE_URL: "convertx.lan" })).rejects.toThrow(
      /CONVERTX_BASE_URL/,
    );
  });

  it("strips a trailing slash from the base URL", async () => {
    const config = await loadConfig({ ...base, CONVERTX_BASE_URL: "http://x.lan:3000/" });
    expect(config.baseUrl).toBe("http://x.lan:3000");
  });

  it("normalises WEBROOT to a single leading slash", async () => {
    await expect(loadConfig({ ...base, CONVERTX_WEBROOT: "convert" })).resolves.toMatchObject({
      webroot: "/convert",
    });
    await expect(loadConfig({ ...base, CONVERTX_WEBROOT: "/convert/" })).resolves.toMatchObject({
      webroot: "/convert",
    });
  });

  it("defaults WEBROOT to empty, matching an unconfigured ConvertX", async () => {
    await expect(loadConfig({ ...base })).resolves.toMatchObject({ webroot: "" });
  });

  it("allows anonymous operation when explicitly opted into", async () => {
    const config = await loadConfig({
      CONVERTX_BASE_URL: base.CONVERTX_BASE_URL,
      CONVERTX_UNAUTHENTICATED: "true",
    });

    expect(config.credentials).toBeNull();
    expect(config.unauthenticated).toBe(true);
  });

  it("refuses to start with neither credentials nor an anonymous opt-in", async () => {
    await expect(loadConfig({ CONVERTX_BASE_URL: base.CONVERTX_BASE_URL })).rejects.toThrow(
      /CONVERTX_UNAUTHENTICATED/,
    );
  });

  it("refuses a half-configured credential pair", async () => {
    await expect(
      loadConfig({ CONVERTX_BASE_URL: base.CONVERTX_BASE_URL, CONVERTX_EMAIL: "me@home.lan" }),
    ).rejects.toThrow(/must be set together/);
  });

  it("accepts the usual spellings of a boolean flag", async () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      const config = await loadConfig({
        CONVERTX_BASE_URL: base.CONVERTX_BASE_URL,
        CONVERTX_UNAUTHENTICATED: value,
      });
      expect(config.unauthenticated).toBe(true);
    }
  });

  it("rejects an out-of-range timeout rather than silently clamping", async () => {
    await expect(loadConfig({ ...base, CONVERTX_REQUEST_TIMEOUT_MS: "0" })).rejects.toThrow(
      /CONVERTX_REQUEST_TIMEOUT_MS/,
    );
  });

  it("splits the input allow-list on colons", async () => {
    const config = await loadConfig({
      ...base,
      CONVERTX_ALLOWED_INPUT_DIRS: "/srv/in:/mnt/scans",
    });

    expect(config.allowedInputDirs).toEqual(["/srv/in", "/mnt/scans"]);
  });

  it("defaults the allow-list to empty, which disables reads from disk", async () => {
    await expect(loadConfig({ ...base })).resolves.toMatchObject({ allowedInputDirs: [] });
  });

  it("reads credentials through the vault's file indirection", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "cfg-test-"));
    const passwordFile = join(dir, "password");
    await writeFile(passwordFile, "from-a-file\n");

    const config = await loadConfig({
      CONVERTX_BASE_URL: base.CONVERTX_BASE_URL,
      CONVERTX_EMAIL: "me@home.lan",
      CONVERTX_PASSWORD_FILE: passwordFile,
    });

    expect(config.credentials?.password).toBe("from-a-file");
  });
});
