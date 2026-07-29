import { z } from "zod";
import { Vault } from "./vault/index.js";

const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v)));

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const RawConfigSchema = z.object({
  CONVERTX_BASE_URL: z
    .string()
    .url("CONVERTX_BASE_URL must be an absolute URL, e.g. http://192.168.1.50:2310"),
  CONVERTX_WEBROOT: z
    .string()
    .optional()
    .transform((v) => (v ? `/${v.replace(/^\/+|\/+$/g, "")}` : ""))
    .describe("Set this only if ConvertX itself runs with WEBROOT set."),
  CONVERTX_UNAUTHENTICATED: booleanish(false),
  CONVERTX_REQUEST_TIMEOUT_MS: integer(30_000, 1_000, 600_000),
  CONVERTX_POLL_INTERVAL_MS: integer(1_000, 100, 60_000),
  CONVERTX_CONVERT_TIMEOUT_MS: integer(300_000, 1_000, 3_600_000),
  CONVERTX_MAX_FILE_BYTES: integer(512 * 1024 * 1024, 1, 8 * 1024 * 1024 * 1024),
  CONVERTX_OUTPUT_DIR: z.string().min(1).default("/data/output"),
  CONVERTX_ALLOWED_INPUT_DIRS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(":")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_PORT: integer(2300, 1, 65_535),
});

export interface Credentials {
  email: string;
  password: string;
}

export interface Config {
  baseUrl: string;
  webroot: string;
  /** True when the ConvertX instance runs with ALLOW_UNAUTHENTICATED=true. */
  unauthenticated: boolean;
  credentials: Credentials | null;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  convertTimeoutMs: number;
  maxFileBytes: number;
  outputDir: string;
  allowedInputDirs: string[];
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
}

/**
 * Builds the runtime config from the environment, pulling credentials through
 * the vault so they can come from files rather than env vars.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  vault: Vault = Vault.default(env),
): Promise<Config> {
  const parsed = RawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  const raw = parsed.data;

  const email = await vault.get("CONVERTX_EMAIL");
  const password = await vault.get("CONVERTX_PASSWORD");

  if ((email === undefined) !== (password === undefined)) {
    throw new Error(
      "Invalid configuration: CONVERTX_EMAIL and CONVERTX_PASSWORD must be set together. " +
        "Set both to log in, or neither if ConvertX runs with ALLOW_UNAUTHENTICATED=true " +
        "(in which case also set CONVERTX_UNAUTHENTICATED=true).",
    );
  }

  const credentials = email !== undefined && password !== undefined ? { email, password } : null;

  if (credentials === null && !raw.CONVERTX_UNAUTHENTICATED) {
    throw new Error(
      "Invalid configuration: no credentials were supplied and CONVERTX_UNAUTHENTICATED is not " +
        "set. Either provide CONVERTX_EMAIL/CONVERTX_PASSWORD (or their _FILE variants), or set " +
        "CONVERTX_UNAUTHENTICATED=true if your ConvertX instance allows anonymous use.",
    );
  }

  return {
    baseUrl: raw.CONVERTX_BASE_URL.replace(/\/+$/, ""),
    webroot: raw.CONVERTX_WEBROOT,
    unauthenticated: raw.CONVERTX_UNAUTHENTICATED,
    credentials,
    requestTimeoutMs: raw.CONVERTX_REQUEST_TIMEOUT_MS,
    pollIntervalMs: raw.CONVERTX_POLL_INTERVAL_MS,
    convertTimeoutMs: raw.CONVERTX_CONVERT_TIMEOUT_MS,
    maxFileBytes: raw.CONVERTX_MAX_FILE_BYTES,
    outputDir: raw.CONVERTX_OUTPUT_DIR,
    allowedInputDirs: raw.CONVERTX_ALLOWED_INPUT_DIRS,
    transport: raw.MCP_TRANSPORT,
    httpHost: raw.MCP_HTTP_HOST,
    httpPort: raw.MCP_HTTP_PORT,
  };
}
