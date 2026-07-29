/**
 * An in-process stand-in for ConvertX.
 *
 * It implements the same endpoint contract the real instance exposes —
 * cookie-based auth, job allocation via `GET /`, multipart upload, form-encoded
 * convert, HTML progress polling, and byte downloads — so the client can be
 * exercised end to end without Docker. The integration suite runs the same
 * expectations against a real container.
 */

import { authToken, conversionsFragment, progressFragment, type FixtureTarget } from "./html.js";

export interface FakeConvertXOptions {
  /** Mirrors ConvertX's ALLOW_UNAUTHENTICATED: `GET /` mints a new identity. */
  allowUnauthenticated?: boolean;
  /** Mirrors UNAUTHENTICATED_USER_SHARING: anonymous users all share id 0. */
  unauthenticatedUserSharing?: boolean;
  credentials?: { email: string; password: string };
  targets?: FixtureTarget[];
  /** Progress polls that report "not finished" before the job completes. */
  pollsBeforeDone?: number;
  /** Marks converted files as failed, to exercise the failure paths. */
  failConversion?: boolean;
  /** Marks cookies Secure, as ConvertX does when HTTP_ALLOWED is not set. */
  secureCookies?: boolean;
}

interface JobState {
  userId: string;
  fileNames: string[];
  target?: string;
  converter?: string;
  polls: number;
}

export class FakeConvertX {
  readonly requests: { method: string; path: string }[] = [];
  private readonly jobs = new Map<string, JobState>();
  private nextJobId = 1000;
  private nextAnonUserId = 5_000_000;
  private readonly options: Required<
    Pick<
      FakeConvertXOptions,
      | "allowUnauthenticated"
      | "unauthenticatedUserSharing"
      | "targets"
      | "pollsBeforeDone"
      | "failConversion"
      | "secureCookies"
    >
  > & { credentials?: { email: string; password: string } };

  constructor(options: FakeConvertXOptions = {}) {
    this.options = {
      allowUnauthenticated: options.allowUnauthenticated ?? false,
      unauthenticatedUserSharing: options.unauthenticatedUserSharing ?? false,
      targets: options.targets ?? [
        { target: "pdf", converter: "libreoffice" },
        { target: "png", converter: "imagemagick" },
        { target: "jpg", converter: "imagemagick" },
      ],
      pollsBeforeDone: options.pollsBeforeDone ?? 1,
      failConversion: options.failConversion ?? false,
      secureCookies: options.secureCookies ?? false,
      ...(options.credentials ? { credentials: options.credentials } : {}),
    };
  }

  /** A `fetch` implementation to inject into the session/client. */
  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = (init?.method ?? "GET").toUpperCase();
      const cookies = parseCookieHeader(new Headers(init?.headers).get("cookie"));
      this.requests.push({ method, path: url.pathname });
      return this.route(url.pathname, method, cookies, init);
    }) as typeof fetch;
  }

  private cookie(name: string, value: string, extra = ""): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${
      this.options.secureCookies ? "; Secure" : ""
    }${extra}`;
  }

  private async route(
    path: string,
    method: string,
    cookies: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    if (path === "/healthcheck" && method === "GET") {
      return json({ status: "ok" });
    }

    if (path === "/login" && method === "POST") {
      return this.handleLogin(init);
    }

    if (path === "/" && method === "GET") {
      return this.handleRoot(cookies);
    }

    if (path === "/conversions" && method === "POST") {
      return html(conversionsFragment(this.options.targets));
    }

    if (path === "/upload" && method === "POST") {
      return this.handleUpload(cookies, init);
    }

    if (path === "/convert" && method === "POST") {
      return this.handleConvert(cookies, init);
    }

    const progressMatch = /^\/progress\/(.+)$/.exec(path);
    if (progressMatch && method === "POST") {
      return this.handleProgress(progressMatch[1]!, cookies);
    }

    const downloadMatch = /^\/download\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (downloadMatch && method === "GET") {
      return this.handleDownload(
        decodeURIComponent(downloadMatch[1]!),
        decodeURIComponent(downloadMatch[2]!),
        decodeURIComponent(downloadMatch[3]!),
        cookies,
      );
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleLogin(init?: RequestInit): Promise<Response> {
    const body = new URLSearchParams(await bodyText(init));
    const expected = this.options.credentials;

    if (
      !expected ||
      body.get("email") !== expected.email ||
      body.get("password") !== expected.password
    ) {
      return redirect("/login");
    }

    return new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": this.cookie("auth", authToken("7")) },
    });
  }

  private handleRoot(cookies: Record<string, string>): Response {
    const headers = new Headers({ "content-type": "text/html" });

    let userId: string;
    if (this.options.allowUnauthenticated) {
      // Faithful to ConvertX: a brand-new identity on every visit unless
      // sharing is on. This is what makes per-job sessions necessary.
      userId = this.options.unauthenticatedUserSharing ? "0" : String(this.nextAnonUserId++);
      headers.append("set-cookie", this.cookie("auth", authToken(userId)));
    } else {
      const auth = cookies["auth"];
      if (!auth) return redirect("/login");
      userId = userIdOf(auth);
    }

    const jobId = String(this.nextJobId++);
    this.jobs.set(jobId, { userId, fileNames: [], polls: 0 });
    headers.append("set-cookie", this.cookie("jobId", jobId));

    return new Response("<html><body>ConvertX</body></html>", { status: 200, headers });
  }

  private async handleUpload(
    cookies: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    const job = this.jobs.get(cookies["jobId"] ?? "");
    if (!job) return redirect("/");

    const form = init?.body;
    if (form instanceof FormData) {
      for (const value of form.getAll("file")) {
        if (value instanceof File) job.fileNames.push(value.name);
      }
    }
    return json({ message: "Files uploaded successfully." });
  }

  private async handleConvert(
    cookies: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    const jobId = cookies["jobId"] ?? "";
    const job = this.jobs.get(jobId);
    if (!job) return redirect("/");

    const body = new URLSearchParams(await bodyText(init));
    const [target, converter] = (body.get("convert_to") ?? "").split(",");

    // ConvertX bounces unsupported pairs back to `/` rather than erroring.
    const supported = this.options.targets.some(
      (t) => t.target === target && t.converter === converter,
    );
    if (!target || !converter || !supported) return redirect("/");

    job.target = target;
    job.converter = converter;
    job.fileNames = JSON.parse(body.get("file_names") ?? "[]") as string[];

    return redirect(`/results/${jobId}`);
  }

  private handleProgress(jobId: string, cookies: Record<string, string>): Response {
    const job = this.jobs.get(jobId);
    if (!job) return json({ message: "Job not found." }, 404);

    // Downloads and progress are scoped to the creating user; a session that
    // re-identified itself must not see the job.
    const auth = cookies["auth"];
    if (auth && userIdOf(auth) !== job.userId) {
      return json({ message: "Job not found." }, 404);
    }

    const numFiles = job.fileNames.length;
    const finished = job.polls++ >= this.options.pollsBeforeDone;

    const files = finished
      ? job.fileNames.map((name) => ({
          name: `${stripExtension(name)}.${job.target}`,
          status: this.options.failConversion ? "failed" : "done",
        }))
      : [];

    return html(progressFragment({ userId: job.userId, jobId, numFiles, files }));
  }

  private handleDownload(
    userId: string,
    jobId: string,
    fileName: string,
    cookies: Record<string, string>,
  ): Response {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return redirect("/results");

    const auth = cookies["auth"];
    if (auth && userIdOf(auth) !== job.userId) return redirect("/results");

    return new Response(Buffer.from(`converted:${fileName}`), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

async function bodyText(init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function userIdOf(jwt: string): string {
  const payload = jwt.split(".")[1];
  if (!payload) return "";
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { id?: string };
  return parsed.id ?? "";
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
