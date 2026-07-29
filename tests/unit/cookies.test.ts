import { describe, expect, it } from "vitest";
import { CookieJar, userIdFromAuthCookie } from "../../src/convertx/cookies.js";
import { authToken } from "../fixtures/html.js";

describe("CookieJar", () => {
  it("stores and serialises cookies", () => {
    const jar = new CookieJar();
    jar.accept("auth=abc; Path=/; HttpOnly");
    jar.accept("jobId=1000; Path=/; HttpOnly");

    expect(jar.get("auth")).toBe("abc");
    expect(jar.header()).toBe("auth=abc; jobId=1000");
  });

  it("returns no header when empty", () => {
    expect(new CookieJar().header()).toBeUndefined();
  });

  it("treats an empty value as a deletion", () => {
    const jar = new CookieJar();
    jar.accept("jobId=1000; Path=/");
    jar.accept("jobId=; Path=/; Max-Age=0");

    expect(jar.get("jobId")).toBeUndefined();
  });

  it("tracks the Secure flag so plain-HTTP misconfiguration can be diagnosed", () => {
    const jar = new CookieJar();
    jar.accept("auth=abc; Path=/; Secure");
    expect(jar.hasSecureCookies()).toBe(true);

    const plain = new CookieJar();
    plain.accept("auth=abc; Path=/");
    expect(plain.hasSecureCookies()).toBe(false);
  });

  it("absorbs every Set-Cookie on a response", () => {
    const headers = new Headers();
    headers.append("set-cookie", "auth=abc; Path=/");
    headers.append("set-cookie", "jobId=99; Path=/");

    const jar = new CookieJar();
    jar.acceptFrom(headers);

    expect(jar.get("auth")).toBe("abc");
    expect(jar.get("jobId")).toBe("99");
  });

  it("ignores malformed Set-Cookie headers", () => {
    const jar = new CookieJar();
    jar.accept("");
    jar.accept("novalue");
    jar.accept("=novalue");

    expect(jar.header()).toBeUndefined();
  });

  it("clears every cookie on invalidation", () => {
    const jar = new CookieJar();
    jar.set("auth", "abc");
    jar.clear();
    expect(jar.header()).toBeUndefined();
  });
});

describe("userIdFromAuthCookie", () => {
  it("reads the id claim out of a ConvertX token", () => {
    expect(userIdFromAuthCookie(authToken("42"))).toBe("42");
  });

  it("returns undefined for tokens it cannot read", () => {
    expect(userIdFromAuthCookie("not-a-jwt")).toBeUndefined();
    expect(userIdFromAuthCookie("a.!!!not-base64!!!.c")).toBeUndefined();
    expect(userIdFromAuthCookie("")).toBeUndefined();
  });

  it("returns undefined when the payload carries no id", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(userIdFromAuthCookie(`h.${payload}.s`)).toBeUndefined();
  });

  it("accepts a numeric id claim", () => {
    const payload = Buffer.from(JSON.stringify({ id: 7 })).toString("base64url");
    expect(userIdFromAuthCookie(`h.${payload}.s`)).toBe("7");
  });
});
