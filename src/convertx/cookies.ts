/**
 * A deliberately small cookie jar.
 *
 * ConvertX only ever sets two cookies (`auth` and `jobId`) on a single origin,
 * so attribute handling (Domain/Path/Expires) would be dead weight. What does
 * matter is that `Secure` is honoured: ConvertX sets `secure: !HTTP_ALLOWED`,
 * and a plain-HTTP homelab deployment that forgets `HTTP_ALLOWED=true` would
 * otherwise fail with a confusing "not logged in" loop rather than a clear
 * diagnostic. We record the flag so the session layer can explain it.
 */

export interface StoredCookie {
  value: string;
  secure: boolean;
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  /** Absorbs every `Set-Cookie` on a response. */
  acceptFrom(headers: Headers): void {
    for (const header of headers.getSetCookie()) {
      this.accept(header);
    }
  }

  accept(setCookieHeader: string): void {
    const [pair, ...attributes] = setCookieHeader.split(";");
    if (!pair) return;

    const eq = pair.indexOf("=");
    if (eq <= 0) return;

    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const secure = attributes.some((a) => a.trim().toLowerCase() === "secure");

    // An empty value with Max-Age=0/Expires in the past is a deletion; ConvertX
    // uses this on logoff and when clearing a consumed job cookie.
    if (value === "") {
      this.cookies.delete(name);
      return;
    }

    this.cookies.set(name, { value, secure });
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  set(name: string, value: string, secure = false): void {
    this.cookies.set(name, { value, secure });
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  /** True if any stored cookie is Secure-only, which plain HTTP cannot carry. */
  hasSecureCookies(): boolean {
    return [...this.cookies.values()].some((c) => c.secure);
  }

  /** Serialises the jar into a `Cookie` request header, or `undefined` if empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, c]) => `${name}=${c.value}`).join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}

/**
 * Reads the `id` claim out of a ConvertX auth JWT without verifying it.
 *
 * The signature is ConvertX's to check, not ours — we only need the user id to
 * build download URLs (`/download/:userId/:jobId/:file`). Treating the payload
 * as untrusted is fine here because a forged id would simply 404.
 */
export function userIdFromAuthCookie(jwt: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload === "object" && payload !== null && "id" in payload) {
      const id = (payload as { id: unknown }).id;
      if (typeof id === "string" && id !== "") return id;
      if (typeof id === "number") return String(id);
    }
  } catch {
    // A malformed token is indistinguishable from "no id available" for our
    // purposes; the caller falls back to scraping the id from result links.
  }
  return undefined;
}
