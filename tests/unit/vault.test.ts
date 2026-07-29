import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvSecretProvider, FileSecretProvider, Redactor, Vault } from "../../src/vault/index.js";

async function tempFileContaining(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-test-"));
  const path = join(dir, "secret");
  await writeFile(path, contents);
  return path;
}

describe("EnvSecretProvider", () => {
  it("reads a value from the environment", async () => {
    const provider = new EnvSecretProvider({ TOKEN: "s3cret" });
    await expect(provider.get("TOKEN")).resolves.toBe("s3cret");
  });

  it("treats an empty variable as absent", async () => {
    const provider = new EnvSecretProvider({ TOKEN: "" });
    await expect(provider.get("TOKEN")).resolves.toBeUndefined();
  });
});

describe("FileSecretProvider", () => {
  it("reads a value from the file named by <KEY>_FILE", async () => {
    const path = await tempFileContaining("from-a-file");
    const provider = new FileSecretProvider({ TOKEN_FILE: path });
    await expect(provider.get("TOKEN")).resolves.toBe("from-a-file");
  });

  it("strips the trailing newline that secret files almost always carry", async () => {
    const path = await tempFileContaining("hunter2\n");
    const provider = new FileSecretProvider({ TOKEN_FILE: path });
    await expect(provider.get("TOKEN")).resolves.toBe("hunter2");
  });

  it("is inert when no <KEY>_FILE is set", async () => {
    const provider = new FileSecretProvider({});
    await expect(provider.get("TOKEN")).resolves.toBeUndefined();
  });

  it("explains which file it could not read", async () => {
    const provider = new FileSecretProvider({ TOKEN_FILE: "/nonexistent/secret" });
    await expect(provider.get("TOKEN")).rejects.toThrow(/TOKEN_FILE=\/nonexistent\/secret/);
  });
});

describe("Vault", () => {
  it("prefers a file-backed secret over an environment variable", async () => {
    const path = await tempFileContaining("from-file");
    const vault = Vault.default({ TOKEN: "from-env", TOKEN_FILE: path });

    await expect(vault.get("TOKEN")).resolves.toBe("from-file");
  });

  it("falls back to the environment when no file is configured", async () => {
    const vault = Vault.default({ TOKEN: "from-env" });
    await expect(vault.get("TOKEN")).resolves.toBe("from-env");
  });

  it("caches resolution, including a negative result", async () => {
    const env: NodeJS.ProcessEnv = {};
    const vault = Vault.default(env);

    await expect(vault.get("TOKEN")).resolves.toBeUndefined();
    env["TOKEN"] = "set-after-the-fact";
    await expect(vault.get("TOKEN")).resolves.toBeUndefined();
  });

  it("names the variable to set when a required secret is missing", async () => {
    const vault = Vault.default({});
    await expect(vault.require("CONVERTX_PASSWORD")).rejects.toThrow(/CONVERTX_PASSWORD_FILE/);
  });

  it("registers resolved secrets with the redactor", async () => {
    const vault = Vault.default({ TOKEN: "sup3rs3cret" });
    await vault.get("TOKEN");

    expect(vault.redactor.redact("leaked sup3rs3cret here")).toBe("leaked «redacted» here");
  });
});

describe("Redactor", () => {
  it("scrubs every occurrence of a registered secret", () => {
    const redactor = new Redactor();
    redactor.register("hunter2");

    expect(redactor.redact("hunter2 and hunter2")).toBe("«redacted» and «redacted»");
  });

  it("leaves text alone when nothing is registered", () => {
    expect(new Redactor().redact("nothing to hide")).toBe("nothing to hide");
  });

  it("refuses to register very short values that would corrupt unrelated text", () => {
    const redactor = new Redactor();
    redactor.register("ab");

    expect(redactor.redact("about")).toBe("about");
  });
});
