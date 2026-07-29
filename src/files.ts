/**
 * File access for the MCP server.
 *
 * The server is intended to be reachable by everyone at home, so a tool
 * argument is untrusted input. Reads are therefore confined to an explicit
 * allow-list of directories, and writes are confined to the configured output
 * directory. Both checks are done on the *resolved* path so `..` traversal and
 * symlink escapes are caught.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { RequestError } from "./convertx/errors.js";

/** True if `child` is `parent` or sits underneath it. */
export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Resolves a path through symlinks as far as it exists, so that a symlink
 * pointing outside the allow-list cannot be used to escape it.
 */
async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // The file may not exist yet (output paths). Resolve the nearest existing
    // ancestor instead and re-attach the remainder.
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    const realParent = await resolveRealPath(parent);
    return join(realParent, path.slice(parent.length + 1));
  }
}

export interface FileGatewayOptions {
  allowedInputDirs: string[];
  outputDir: string;
  maxFileBytes: number;
}

export class FileGateway {
  constructor(private readonly options: FileGatewayOptions) {}

  /** Reads a source file, enforcing the allow-list and the size cap. */
  async readSource(path: string): Promise<Uint8Array> {
    if (!isAbsolute(path)) {
      throw new RequestError(
        `source_path must be an absolute path; got '${path}'. Paths are resolved on the machine ` +
          `running this MCP server, not on the caller's machine.`,
      );
    }

    const real = await resolveRealPath(path);

    if (this.options.allowedInputDirs.length === 0) {
      throw new RequestError(
        "Reading files from disk is disabled because CONVERTX_ALLOWED_INPUT_DIRS is empty. " +
          "Set it to a colon-separated list of directories this server may read, or pass the " +
          "file inline with source_base64 instead.",
      );
    }

    if (!this.options.allowedInputDirs.some((dir) => isWithin(dir, real))) {
      throw new RequestError(
        `'${path}' is outside every directory listed in CONVERTX_ALLOWED_INPUT_DIRS ` +
          `(${this.options.allowedInputDirs.join(", ")}). Move the file into one of them, or ` +
          `pass it inline with source_base64.`,
      );
    }

    const info = await stat(real).catch(() => null);
    if (!info) {
      throw new RequestError(`No such file: '${path}'.`);
    }
    if (!info.isFile()) {
      throw new RequestError(`'${path}' is not a regular file.`);
    }
    if (info.size > this.options.maxFileBytes) {
      throw new RequestError(
        `'${path}' is ${info.size} bytes, over the ${this.options.maxFileBytes}-byte limit. ` +
          `Raise CONVERTX_MAX_FILE_BYTES if this instance should handle files that large.`,
      );
    }

    return new Uint8Array(await readFile(real));
  }

  /** Writes a converted file into the output directory, refusing to escape it. */
  async writeOutput(relativeDir: string | undefined, fileName: string): Promise<string> {
    const targetDir = relativeDir
      ? resolve(this.options.outputDir, relativeDir)
      : resolve(this.options.outputDir);

    if (!isWithin(this.options.outputDir, targetDir)) {
      throw new RequestError(
        `output_subdir '${relativeDir}' resolves outside CONVERTX_OUTPUT_DIR ` +
          `(${this.options.outputDir}).`,
      );
    }

    await mkdir(targetDir, { recursive: true });
    return join(targetDir, sanitizeFileName(fileName));
  }

  async persist(path: string, content: Uint8Array): Promise<void> {
    await writeFile(path, content);
  }

  decodeBase64(data: string, fieldName = "source_base64"): Uint8Array {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      throw new RequestError(`${fieldName} is not valid base64.`);
    }
    // Buffer.from silently drops invalid characters rather than throwing, so a
    // zero-length decode of non-empty input means the input was not base64.
    if (buffer.byteLength === 0 && data.trim() !== "") {
      throw new RequestError(`${fieldName} is not valid base64.`);
    }
    if (buffer.byteLength > this.options.maxFileBytes) {
      throw new RequestError(
        `${fieldName} decodes to ${buffer.byteLength} bytes, over the ` +
          `${this.options.maxFileBytes}-byte limit set by CONVERTX_MAX_FILE_BYTES.`,
      );
    }
    return new Uint8Array(buffer);
  }
}

/** Strips any directory component and characters that are unsafe in a filename. */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f]/g, "");
  const cleaned = base.replace(/[<>:"|?*]/g, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "output";
  return cleaned;
}
