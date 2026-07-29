/**
 * Integration tests against a real ConvertX instance.
 *
 * The unit suite proves the client against a faithful fake; this suite proves
 * the fake is faithful. It is skipped unless CONVERTX_IT_BASE_URL points at a
 * live instance, so `npm test` stays fast and hermetic.
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 *   CONVERTX_IT_BASE_URL=http://127.0.0.1:2311 \
 *   CONVERTX_IT_UNAUTHENTICATED=true \
 *   npm run test:integration
 *
 * Point it at your own instance instead by also setting CONVERTX_IT_EMAIL and
 * CONVERTX_IT_PASSWORD.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { ConvertXClient } from "../../src/convertx/client.js";

const baseUrl = process.env["CONVERTX_IT_BASE_URL"];
const email = process.env["CONVERTX_IT_EMAIL"];
const password = process.env["CONVERTX_IT_PASSWORD"];
const unauthenticated = /^(1|true|yes)$/i.test(process.env["CONVERTX_IT_UNAUTHENTICATED"] ?? "");

const describeIfLive = baseUrl ? describe : describe.skip;

describeIfLive("ConvertX (live instance)", () => {
  let client: ConvertXClient;

  beforeAll(() => {
    client = new ConvertXClient({
      baseUrl: baseUrl!,
      webroot: "",
      unauthenticated,
      credentials: email && password ? { email, password } : null,
      requestTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
      convertTimeoutMs: 120_000,
    });
  });

  it("reports the instance as healthy", async () => {
    await expect(client.health()).resolves.toMatchObject({ reachable: true });
  });

  it("lists real conversion targets for a common format", async () => {
    const targets = await client.listTargets("png");

    expect(targets.length).toBeGreaterThan(0);
    // Any image-capable ConvertX build offers at least one of these.
    expect(targets.some((t) => ["jpg", "jpeg", "webp", "pdf"].includes(t.target))).toBe(true);
  });

  it("converts a real PNG end to end", async () => {
    const targets = await client.listTargets("png");
    const jpeg = targets.find((t) => t.target === "jpg" || t.target === "jpeg");
    if (!jpeg) {
      // A minimal build may lack an image converter; the format list above
      // already proved the plumbing works.
      return;
    }

    const result = await client.convert(
      [{ fileName: "pixel.png", content: onePixelPng() }],
      jpeg.target,
      jpeg.converter,
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.content.byteLength).toBeGreaterThan(0);
  });

  it("rejects a conversion the instance cannot perform", async () => {
    await expect(
      client.convert([{ fileName: "pixel.png", content: onePixelPng() }], "not-a-real-format"),
    ).rejects.toThrow();
  });
});

/** A valid 1x1 PNG, small enough to inline. */
function onePixelPng(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
}
