import { describe, expect, it, vi } from "vitest";
import { SyncSession, type SessionOptions } from "../../src/convertx/session.js";
import { AuthError, ConnectionError } from "../../src/convertx/errors.js";
import { FakeConvertX } from "../fixtures/fake-convertx.js";

const CREDENTIALS = { email: "me@home.lan", password: "hunter2" };

function options(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    baseUrl: "http://convertx.lan:3000",
    webroot: "",
    unauthenticated: false,
    credentials: CREDENTIALS,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

describe("SyncSession URL building", () => {
  it("builds URLs against the base", () => {
    const session = new SyncSession(options());
    expect(session.url("/upload")).toBe("http://convertx.lan:3000/upload");
  });

  it("honours a WEBROOT-mounted instance", () => {
    const session = new SyncSession(options({ webroot: "/convert" }));
    expect(session.url("/upload")).toBe("http://convertx.lan:3000/convert/upload");
  });
});

describe("SyncSession authentication", () => {
  it("logs in and keeps the auth cookie", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(options({ fetchImpl: fake.fetch }));

    await session.ensureAuthenticated();

    expect(session.userId).toBe("7");
  });

  it("collapses concurrent callers onto a single login", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(options({ fetchImpl: fake.fetch }));

    await Promise.all([
      session.ensureAuthenticated(),
      session.ensureAuthenticated(),
      session.ensureAuthenticated(),
    ]);

    // Without single-flight, each caller would POST /login and the last
    // Set-Cookie would invalidate the others' jobs.
    expect(fake.requests.filter((r) => r.path === "/login")).toHaveLength(1);
  });

  it("does not re-login once authenticated", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(options({ fetchImpl: fake.fetch }));

    await session.ensureAuthenticated();
    await session.ensureAuthenticated();

    expect(fake.requests.filter((r) => r.path === "/login")).toHaveLength(1);
  });

  it("reports bad credentials as an actionable auth error", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(
      options({ fetchImpl: fake.fetch, credentials: { email: "me@home.lan", password: "wrong" } }),
    );

    await expect(session.ensureAuthenticated()).rejects.toBeInstanceOf(AuthError);
  });

  it("explains the Secure-cookie trap when ConvertX runs without HTTP_ALLOWED", async () => {
    // ConvertX marks its cookies Secure unless HTTP_ALLOWED=true. Over plain
    // HTTP those cookies never come back, which would otherwise present as a
    // baffling login loop; reproduce that by dropping them in transit.
    const fake = new FakeConvertX({ credentials: CREDENTIALS, secureCookies: true });
    const dropping: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      const stripped = new Headers(response.headers);
      stripped.delete("set-cookie");
      return new Response(response.body, { status: response.status, headers: stripped });
    };

    const session = new SyncSession(options({ fetchImpl: dropping }));
    await expect(session.ensureAuthenticated()).rejects.toThrow(/HTTP_ALLOWED/);
  });

  it("skips login entirely on an anonymous instance", async () => {
    const fake = new FakeConvertX({ allowUnauthenticated: true });
    const session = new SyncSession(
      options({ fetchImpl: fake.fetch, credentials: null, unauthenticated: true }),
    );

    await session.ensureAuthenticated();

    expect(fake.requests.filter((r) => r.path === "/login")).toHaveLength(0);
  });
});

describe("SyncSession job allocation", () => {
  it("allocates a job id from the jobId cookie", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(options({ fetchImpl: fake.fetch }));

    const job = await session.newJob();

    expect(job.jobId).toBe("1000");
    expect(job.userId).toBe("7");
  });

  it("re-authenticates once when the session has expired", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    const session = new SyncSession(options({ fetchImpl: fake.fetch }));

    await session.newJob();
    // Mimic ConvertX expiring the JWT: the jar still holds a cookie, but the
    // server no longer honours it.
    session.invalidate();
    const job = await session.newJob();

    expect(job.jobId).toBe("1001");
    expect(fake.requests.filter((r) => r.path === "/login")).toHaveLength(2);
  });

  it("recovers when ConvertX expires the cookie mid-session", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });
    let rootHits = 0;

    // Drop the auth cookie on the first GET /, which is exactly how an expired
    // JWT presents: ConvertX 302s to /login instead of allocating a job.
    const expiring: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/" && rootHits++ === 0) {
        const headers = new Headers(init?.headers);
        headers.delete("cookie");
        return fake.fetch(input, { ...init, headers });
      }
      return fake.fetch(input, init);
    };

    const session = new SyncSession(options({ fetchImpl: expiring }));
    const job = await session.newJob();

    expect(job.jobId).toBeTruthy();
    expect(fake.requests.filter((r) => r.path === "/login")).toHaveLength(2);
  });

  it("gives up with a configuration hint if login never sticks", async () => {
    const fake = new FakeConvertX({ credentials: CREDENTIALS });

    // Login succeeds but GET / always bounces, the signature of an instance
    // whose auth mode does not match this server's configuration.
    const alwaysBouncing: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "/login" } }),
        );
      }
      return fake.fetch(input, init);
    };

    const session = new SyncSession(options({ fetchImpl: alwaysBouncing }));

    await expect(session.newJob()).rejects.toThrow(/ALLOW_UNAUTHENTICATED/);
  });

  it("explains a missing job id that is not an auth problem", async () => {
    const noJobCookie: typeof fetch = (input) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/") return Promise.resolve(new Response("<html></html>"));
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "/", "set-cookie": "auth=x" } }),
      );
    };

    const session = new SyncSession(options({ fetchImpl: noJobCookie }));

    await expect(session.newJob()).rejects.toThrow(/CONVERTX_WEBROOT/);
  });

  it("surfaces a connection failure with the base URL in the message", async () => {
    const failing: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const session = new SyncSession(options({ fetchImpl: failing }));

    await expect(session.newJob()).rejects.toBeInstanceOf(ConnectionError);
  });

  it("reports a timeout distinctly from a refused connection", async () => {
    vi.useFakeTimers();
    try {
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });

      const session = new SyncSession(
        options({ fetchImpl: hanging, requestTimeoutMs: 1_000, credentials: null }),
      );
      // Attach the rejection handler before advancing the clock, otherwise the
      // rejection lands with no handler and surfaces as an unhandled error.
      const assertion = expect(session.request("/healthcheck")).rejects.toThrow(
        /Timed out after 1000ms/,
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncSession per-job isolation", () => {
  it("reuses one session on an authenticated instance", () => {
    const session = new SyncSession(options());
    expect(session.forJob()).toBe(session);
  });

  it("hands each job its own session on an anonymous instance", () => {
    const session = new SyncSession(options({ unauthenticated: true, credentials: null }));
    expect(session.forJob()).not.toBe(session);
  });

  it("keeps concurrent anonymous jobs from stealing each other's identity", async () => {
    // ConvertX mints a fresh random user id on every GET / when anonymous.
    // Sharing one jar would leave the first job's output undownloadable.
    const fake = new FakeConvertX({ allowUnauthenticated: true });
    const root = new SyncSession(
      options({ fetchImpl: fake.fetch, credentials: null, unauthenticated: true }),
    );

    const first = await root.forJob().newJob();
    const second = await root.forJob().newJob();

    expect(first.userId).not.toBe(second.userId);
    expect(first.session).not.toBe(second.session);
    // The first job's session must still identify as its original user.
    expect(first.session.userId).toBe(first.userId);
  });
});
