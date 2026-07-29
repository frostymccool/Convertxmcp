/**
 * High-level ConvertX operations, expressed against the endpoints its own web
 * UI uses. Nothing here requires ConvertX to be modified or extended.
 *
 * A conversion is a five-step dance:
 *   1. `GET /`                  allocate a job (jobId cookie)
 *   2. `POST /upload`           multipart, field name `file`
 *   3. `POST /convert`          convert_to=`<target>,<converter>`, file_names=JSON
 *   4. `POST /progress/:jobId`  poll until the progress bar reports done
 *   5. `GET /download/:userId/:jobId/:name`  fetch each output
 */

import { basename, extname } from "node:path";
import { SyncSession, type Job, type SessionOptions } from "./session.js";
import {
  parseConversionTargets,
  parseJobProgress,
  type ConversionTarget,
  type JobProgress,
} from "./parse.js";
import { ConversionError, RequestError, TimeoutError } from "./errors.js";

export interface ConvertXClientOptions extends SessionOptions {
  pollIntervalMs: number;
  convertTimeoutMs: number;
  /** Injectable for tests; defaults to real wall-clock delay. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceFile {
  fileName: string;
  content: Uint8Array;
}

export interface ConvertedFile {
  fileName: string;
  status: string;
  content: Uint8Array;
}

export interface ConversionResult {
  jobId: string;
  target: string;
  converter: string;
  files: ConvertedFile[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ConvertXClient {
  private readonly root: SyncSession;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ConvertXClientOptions) {
    this.root = new SyncSession(options);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Liveness probe against ConvertX's own `/healthcheck`. */
  async health(): Promise<{ reachable: boolean; status: string }> {
    const response = await this.root.request("/healthcheck", { method: "GET" });
    if (!response.ok) {
      return { reachable: false, status: `HTTP ${response.status}` };
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    return { reachable: true, status: body.status ?? "ok" };
  }

  /**
   * Lists every `<target>,<converter>` pair ConvertX can produce from a given
   * input format. This is the authoritative source for the `target` argument of
   * `convert` — targets not in this list are rejected by ConvertX.
   */
  async listTargets(inputFormat: string): Promise<ConversionTarget[]> {
    const fileType = normalizeFormat(inputFormat);
    if (!fileType) {
      throw new RequestError(
        "An input format is required, e.g. 'png', 'docx' or 'mp4' (with or without a leading dot).",
      );
    }

    await this.root.ensureAuthenticated();
    const response = await this.root.request("/conversions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ fileType }),
    });

    if (!response.ok) {
      throw new RequestError(
        `ConvertX rejected a format query for '${fileType}' (HTTP ${response.status}).`,
      );
    }

    return parseConversionTargets(await response.text());
  }

  /**
   * Runs a conversion end to end and returns the produced files.
   *
   * `converter` may be omitted, in which case the first converter ConvertX
   * offers for the target is used — matching what the web UI does when a user
   * simply picks a format.
   */
  async convert(
    sources: SourceFile[],
    target: string,
    converter?: string,
  ): Promise<ConversionResult> {
    if (sources.length === 0) {
      throw new RequestError("At least one source file is required.");
    }

    const normalizedTarget = normalizeFormat(target);
    if (!normalizedTarget) {
      throw new RequestError("A target format is required, e.g. 'pdf'.");
    }

    const resolvedConverter =
      converter ?? (await this.pickConverter(sources[0]!.fileName, normalizedTarget));

    const job = await this.startJob(sources, normalizedTarget, resolvedConverter);
    const progress = await this.waitForJob(job);

    const files = await this.collectOutputs(job, progress);

    return {
      jobId: job.jobId,
      target: normalizedTarget,
      converter: resolvedConverter,
      files,
    };
  }

  /** Chooses a converter capable of producing `target` from the source's format. */
  private async pickConverter(sourceFileName: string, target: string): Promise<string> {
    const sourceFormat = normalizeFormat(extname(sourceFileName));
    if (!sourceFormat) {
      throw new RequestError(
        `Cannot infer the input format from '${sourceFileName}' because it has no extension. ` +
          `Pass 'converter' explicitly, or give the file a normal extension.`,
      );
    }

    const available = await this.listTargets(sourceFormat);
    const match = available.find((t) => t.target === target);
    if (!match) {
      const offered = [...new Set(available.map((t) => t.target))].sort();
      throw new RequestError(
        `ConvertX cannot convert ${sourceFormat} to ${target}. ` +
          (offered.length > 0
            ? `Available targets for ${sourceFormat}: ${offered.join(", ")}.`
            : `It reports no conversions from ${sourceFormat} at all — check the format is one ` +
              `this instance's converters support.`),
      );
    }
    return match.converter;
  }

  /** Allocates a job, uploads the sources, and kicks off the conversion. */
  private async startJob(sources: SourceFile[], target: string, converter: string): Promise<Job> {
    const session = this.root.forJob();
    const job = await session.newJob();

    const form = new FormData();
    for (const source of sources) {
      // Copy into a fresh ArrayBuffer: a Uint8Array view over a pooled Buffer
      // would otherwise upload neighbouring bytes from the same pool.
      const bytes = new Uint8Array(source.content.byteLength);
      bytes.set(source.content);
      form.append("file", new Blob([bytes]), basename(source.fileName));
    }

    const upload = await session.request("/upload", { method: "POST", body: form });
    if (!upload.ok) {
      throw new ConversionError(
        `Uploading to ConvertX failed (HTTP ${upload.status}). If the files are large, the ` +
          `reverse proxy in front of ConvertX may be capping the request body size.`,
      );
    }

    const convert = await session.request("/convert", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        convert_to: `${target},${converter}`,
        file_names: JSON.stringify(sources.map((s) => basename(s.fileName))),
      }),
    });

    // ConvertX answers a started conversion with a 302 to /results/:jobId, and
    // signals every rejection by redirecting to `/` instead.
    const location = convert.headers.get("location") ?? "";
    if (convert.status === 302 && !location.includes("/results/")) {
      throw new ConversionError(
        `ConvertX refused the conversion to '${target}' via '${converter}'. That combination is ` +
          `not one it offers — call convertx_list_formats for the source format to see valid ones.`,
      );
    }
    if (convert.status !== 302 && !convert.ok) {
      throw new ConversionError(`Starting the conversion failed (HTTP ${convert.status}).`);
    }

    return job;
  }

  /** Polls `/progress/:jobId` until the job finishes or the budget expires. */
  async waitForJob(job: Job): Promise<JobProgress> {
    const deadline = Date.now() + this.options.convertTimeoutMs;
    let last: JobProgress | undefined;

    for (;;) {
      last = await this.getProgress(job);
      if (last.done) return last;

      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `Conversion did not finish within ${this.options.convertTimeoutMs}ms ` +
            `(${last.completed}/${last.total} files done). Raise ` +
            `CONVERTX_CONVERT_TIMEOUT_MS for large media files, or check the ConvertX logs — ` +
            `a converter may be stuck.`,
        );
      }
      await this.sleep(this.options.pollIntervalMs);
    }
  }

  async getProgress(job: Job): Promise<JobProgress> {
    const response = await job.session.request(`/progress/${encodeURIComponent(job.jobId)}`, {
      method: "POST",
    });

    if (response.status === 404) {
      throw new ConversionError(
        `ConvertX has no job ${job.jobId} for this session. Jobs are scoped to the user that ` +
          `created them and are cleaned up by AUTO_DELETE_EVERY_N_HOURS.`,
      );
    }
    if (!response.ok) {
      throw new ConversionError(`Reading job ${job.jobId} failed (HTTP ${response.status}).`);
    }

    return parseJobProgress(await response.text());
  }

  /** Downloads every output file the finished job produced. */
  private async collectOutputs(job: Job, progress: JobProgress): Promise<ConvertedFile[]> {
    const userId = job.userId ?? progress.userId;
    if (!userId) {
      throw new ConversionError(
        "Could not determine the ConvertX user id for the download URL. This indicates an " +
          "unexpected response shape — the instance may be a much newer ConvertX than this " +
          "server was built against.",
      );
    }

    const failed = progress.files.filter((f) => /fail|error/i.test(f.status));
    if (failed.length === progress.files.length && failed.length > 0) {
      throw new ConversionError(
        `Every file failed to convert. ConvertX reported: ` +
          `${failed.map((f) => `${f.outputFileName} (${f.status})`).join("; ")}.`,
      );
    }

    const files: ConvertedFile[] = [];
    for (const file of progress.files) {
      if (/fail|error/i.test(file.status)) continue;
      files.push({
        fileName: file.outputFileName,
        status: file.status,
        content: await this.download(job, userId, file.outputFileName),
      });
    }

    if (files.length === 0) {
      throw new ConversionError(
        "The conversion finished but produced no downloadable output. Check the ConvertX logs " +
          "for the underlying converter's error.",
      );
    }

    return files;
  }

  async download(job: Job, userId: string, fileName: string): Promise<Uint8Array> {
    const path =
      `/download/${encodeURIComponent(userId)}/${encodeURIComponent(job.jobId)}/` +
      encodeURIComponent(fileName);

    const response = await job.session.request(path, { method: "GET" });
    if (!response.ok) {
      throw new ConversionError(
        `Downloading '${fileName}' failed (HTTP ${response.status}). The job's files may have ` +
          `been cleaned up by ConvertX's AUTO_DELETE_EVERY_N_HOURS policy.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Lowercases a format and strips a leading dot, so `.PNG` and `png` agree. */
export function normalizeFormat(format: string): string {
  return format.trim().replace(/^\.+/, "").toLowerCase();
}
