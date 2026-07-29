/**
 * sync-session: a synchronized, self-healing ConvertX browser session.
 *
 * ConvertX authenticates with an `auth` JWT cookie and scopes every job to the
 * user id inside it. Two properties of that design drive everything here:
 *
 *  1. **Login must be single-flight.** Several MCP tool calls can run
 *     concurrently; without coordination each would perform its own `POST
 *     /login` and the last `Set-Cookie` would win, invalidating jobs the others
 *     had already started. `ensureAuthenticated` collapses concurrent callers
 *     onto one in-flight login.
 *
 *  2. **Anonymous mode mints a new identity on every `GET /`.** When ConvertX
 *     runs with `ALLOW_UNAUTHENTICATED=true` and
 *     `UNAUTHENTICATED_USER_SHARING=false`, each hit of `/` issues a *fresh
 *     random user id*. Reusing one jar across jobs would silently orphan the
 *     previous job's output — the files exist but `/download/:userId/...` no
 *     longer matches. So in anonymous mode each job gets its own isolated
 *     session, created by `forJob()`, held for the job's whole lifecycle.
 */

import { CookieJar, userIdFromAuthCookie } from "./cookies.js";
import { AuthError, ConnectionError, RequestError } from "./errors.js";
import type { Config } from "../config.js";

export interface SessionOptions {
  baseUrl: string;
  webroot: string;
  unauthenticated: boolean;
  credentials: { email: string; password: string } | null;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function sessionOptionsFromConfig(config: Config): SessionOptions {
  return {
    baseUrl: config.baseUrl,
    webroot: config.webroot,
    unauthenticated: config.unauthenticated,
    credentials: config.credentials,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

export interface Job {
  jobId: string;
  userId: string | undefined;
  session: SyncSession;
}

export class SyncSession {
  private readonly jar = new CookieJar();
  private readonly fetchImpl: typeof fetch;
  private loginInFlight: Promise<void> | null = null;
  private authenticated = false;

  constructor(private readonly options: SessionOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** URL for a ConvertX path, accounting for a non-empty WEBROOT. */
  url(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.options.baseUrl}${this.options.webroot}${suffix}`;
  }

  get userId(): string | undefined {
    const auth = this.jar.get("auth");
    return auth ? userIdFromAuthCookie(auth) : undefined;
  }

  /**
   * Performs a request carrying the session cookies, absorbing any the server
   * sets. Redirects are never followed: ConvertX uses a 302 to `/login` as its
   * "your session died" signal, and following it would turn an auth failure
   * into a confusing HTML parse error.
   */
  async request(
    path: string,
    init: RequestInit & { absorbCookies?: boolean } = {},
  ): Promise<Response> {
    const { absorbCookies = true, ...requestInit } = init;
    const headers = new Headers(requestInit.headers);

    const cookieHeader = this.jar.header();
    if (cookieHeader) headers.set("cookie", cookieHeader);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...requestInit,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ConnectionError(
          `Timed out after ${this.options.requestTimeoutMs}ms contacting ConvertX at ` +
            `${this.url(path)}. Raise CONVERTX_REQUEST_TIMEOUT_MS if the instance is slow, ` +
            `or check that it is reachable from this host.`,
          error,
        );
      }
      throw new ConnectionError(
        `Could not reach ConvertX at ${this.url(path)}. Check CONVERTX_BASE_URL and that the ` +
          `instance is running.`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    if (absorbCookies) this.jar.acceptFrom(response.headers);
    return response;
  }

  /** True when the response is ConvertX redirecting us at the login page. */
  private isAuthRedirect(response: Response): boolean {
    if (response.status !== 302) return false;
    const location = response.headers.get("location") ?? "";
    return location.includes("/login") || location.includes("/setup");
  }

  /**
   * Ensures the jar holds a usable `auth` cookie. Concurrent callers share a
   * single login attempt rather than racing each other.
   */
  async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) return;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.performLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async performLogin(): Promise<void> {
    // Anonymous instances have no login endpoint to use; `GET /` issues the
    // identity, and newJob() drives that.
    if (!this.options.credentials) {
      this.authenticated = true;
      return;
    }

    const body = new URLSearchParams({
      email: this.options.credentials.email,
      password: this.options.credentials.password,
    });

    const response = await this.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    // A successful login is a 302 back to `/` carrying Set-Cookie: auth=...
    if (!this.jar.get("auth")) {
      if (response.status === 302 && this.isAuthRedirect(response)) {
        throw new AuthError(
          "ConvertX rejected the credentials in CONVERTX_EMAIL/CONVERTX_PASSWORD. Verify they " +
            "match an account on the instance; if this is a fresh instance, create the first " +
            "account through the ConvertX web UI at /setup.",
        );
      }
      throw new AuthError(
        `Login to ConvertX did not return a session cookie (HTTP ${response.status}). ` +
          `If ConvertX is served over plain HTTP, it must run with HTTP_ALLOWED=true — ` +
          `otherwise it marks the auth cookie Secure and no HTTP client can keep a session.`,
      );
    }

    this.authenticated = true;
  }

  /** Drops the cached session so the next call re-authenticates. */
  invalidate(): void {
    this.authenticated = false;
    this.jar.clear();
  }

  /**
   * Creates a new ConvertX job by hitting `/`, which allocates a job row and
   * returns its id in the `jobId` cookie.
   */
  async newJob(): Promise<Job> {
    await this.ensureAuthenticated();

    const response = await this.request("/", { method: "GET" });

    if (this.isAuthRedirect(response)) {
      // The cookie expired mid-session (ConvertX JWTs last 7 days, anonymous
      // ones 24h). Re-authenticate once before giving up.
      this.invalidate();
      await this.ensureAuthenticated();
      const retry = await this.request("/", { method: "GET" });
      if (this.isAuthRedirect(retry)) {
        throw new AuthError(
          "ConvertX redirected to the login page even after re-authenticating. If the instance " +
            "runs with ALLOW_UNAUTHENTICATED=true, set CONVERTX_UNAUTHENTICATED=true here; " +
            "otherwise supply CONVERTX_EMAIL and CONVERTX_PASSWORD.",
        );
      }
    }

    const jobId = this.jar.get("jobId");
    if (!jobId) {
      if (this.jar.hasSecureCookies()) {
        throw new AuthError(
          "ConvertX issued Secure-only cookies, which cannot be sent over plain HTTP. Either " +
            "run ConvertX with HTTP_ALLOWED=true, or point CONVERTX_BASE_URL at an https:// URL.",
        );
      }
      throw new RequestError(
        `ConvertX did not allocate a job id (HTTP ${response.status}). This usually means the ` +
          `instance is still starting up, or CONVERTX_WEBROOT does not match the WEBROOT the ` +
          `instance runs with.`,
      );
    }

    // The job cookie is consumed by the upload/convert pair; clearing it here
    // would break those, so it is left in place until the next newJob().
    return { jobId, userId: this.userId, session: this };
  }

  /**
   * Returns the session that a new job should run on.
   *
   * Authenticated instances keep one shared session — the user id is stable, so
   * jobs coexist safely. Anonymous instances get a fresh session per job,
   * because `GET /` would otherwise reassign this session's identity and orphan
   * every job already in flight.
   */
  forJob(): SyncSession {
    return this.options.unauthenticated ? new SyncSession(this.options) : this;
  }
}
