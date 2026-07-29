/**
 * Vault: credential resolution for the ConvertX MCP server.
 *
 * Secrets are never read directly from `process.env` by application code. They
 * are resolved through a provider chain so a deployment can move a credential
 * from an env var to a mounted file (Docker/Podman secrets, systemd
 * `LoadCredential=`, Proxmox host bind-mount) without touching any code.
 *
 * Resolution order is first-match-wins:
 *   1. `<NAME>_FILE` pointing at a file whose contents are the secret.
 *   2. `<NAME>` as a literal environment variable.
 *
 * Resolved values are cached for the process lifetime and registered with the
 * redactor so they cannot be echoed back through logs or error messages.
 */

import { readFile } from "node:fs/promises";

export interface SecretProvider {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
}

/** Reads a secret from a file whose path is given by `<KEY>_FILE`. */
export class FileSecretProvider implements SecretProvider {
  readonly name = "file";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(key: string): Promise<string | undefined> {
    const path = this.env[`${key}_FILE`];
    if (!path) return undefined;

    try {
      // Trailing newlines are near-universal in secret files written by
      // `echo`, editors, and orchestrators; stripping them is required for the
      // value to be usable as a password.
      return (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(
        `Vault: could not read secret '${key}' from ${key}_FILE=${path}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Check the path exists and is readable by the server's user.`,
      );
    }
  }
}

/** Reads a secret from a literal environment variable. */
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(key: string): Promise<string | undefined> {
    const value = this.env[key];
    return value === undefined || value === "" ? undefined : value;
  }
}

/**
 * Tracks resolved secret values so they can be scrubbed from any string headed
 * for a log sink or an MCP error payload.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  register(value: string): void {
    // Very short values would redact harmless substrings of unrelated text.
    if (value.length >= 4) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join("«redacted»");
    }
    return out;
  }
}

export class Vault {
  private readonly cache = new Map<string, string | undefined>();

  constructor(
    private readonly providers: SecretProvider[],
    readonly redactor: Redactor = new Redactor(),
  ) {}

  static default(env: NodeJS.ProcessEnv = process.env): Vault {
    return new Vault([new FileSecretProvider(env), new EnvSecretProvider(env)]);
  }

  /** Resolves a secret, or `undefined` if no provider supplies it. */
  async get(key: string): Promise<string | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);

    let resolved: string | undefined;
    for (const provider of this.providers) {
      const value = await provider.get(key);
      if (value !== undefined) {
        resolved = value;
        break;
      }
    }

    if (resolved !== undefined) this.redactor.register(resolved);
    this.cache.set(key, resolved);
    return resolved;
  }

  /** Resolves a secret that the deployment is required to supply. */
  async require(key: string): Promise<string> {
    const value = await this.get(key);
    if (value === undefined) {
      throw new Error(
        `Vault: required secret '${key}' is not set. Provide it as the ` +
          `environment variable ${key}, or point ${key}_FILE at a file containing it.`,
      );
    }
    return value;
  }
}
