import { describe, expect, it } from "vitest";
import { ConversionError, ConvertXError, describeError } from "../../src/convertx/errors.js";

describe("describeError", () => {
  it("passes through our own error messages unchanged", () => {
    expect(describeError(new ConversionError("job failed"))).toBe("job failed");
  });

  it("unwraps the cause Node hides behind 'fetch failed'", () => {
    const error = new Error("fetch failed");
    (error as { cause?: unknown }).cause = new Error("ECONNREFUSED 10.0.0.5:3000");

    expect(describeError(error)).toBe("fetch failed: ECONNREFUSED 10.0.0.5:3000");
  });

  it("handles a plain error with no cause", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies values that are not errors at all", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(42)).toBe("42");
  });

  it("keeps the subclass name for diagnosis", () => {
    expect(new ConversionError("x").name).toBe("ConversionError");
    expect(new ConvertXError("x").name).toBe("ConvertXError");
  });
});
