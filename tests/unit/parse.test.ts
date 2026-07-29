import { describe, expect, it } from "vitest";
import { parseConversionTargets, parseJobProgress } from "../../src/convertx/parse.js";
import { conversionsFragment, conversionsSelectOnly, progressFragment } from "../fixtures/html.js";

describe("parseConversionTargets", () => {
  it("extracts every target/converter pair from the popup markup", () => {
    const html = conversionsFragment([
      { target: "pdf", converter: "libreoffice" },
      { target: "png", converter: "imagemagick" },
      { target: "jpg", converter: "imagemagick" },
    ]);

    expect(parseConversionTargets(html)).toEqual([
      { target: "pdf", converter: "libreoffice" },
      { target: "png", converter: "imagemagick" },
      { target: "jpg", converter: "imagemagick" },
    ]);
  });

  it("does not double-count the popup buttons and the hidden select", () => {
    const html = conversionsFragment([{ target: "pdf", converter: "libreoffice" }]);
    expect(parseConversionTargets(html)).toHaveLength(1);
  });

  it("falls back to the hidden select when no data-value buttons are rendered", () => {
    const html = conversionsSelectOnly([
      { target: "webp", converter: "imagemagick" },
      { target: "avif", converter: "imagemagick" },
    ]);

    expect(parseConversionTargets(html)).toEqual([
      { target: "webp", converter: "imagemagick" },
      { target: "avif", converter: "imagemagick" },
    ]);
  });

  it("returns nothing for a format the instance cannot read", () => {
    expect(parseConversionTargets(conversionsFragment([]))).toEqual([]);
  });

  it("ignores select options that are not target,converter pairs", () => {
    // The placeholder <option value=""> must not become a bogus target.
    const html = conversionsSelectOnly([{ target: "pdf", converter: "libreoffice" }]);
    expect(parseConversionTargets(html).every((t) => t.target !== "")).toBe(true);
  });
});

describe("parseJobProgress", () => {
  it("reports a job as unfinished while ConvertX omits the progress value", () => {
    const html = progressFragment({ userId: "7", jobId: "1000", numFiles: 2, files: [] });
    const progress = parseJobProgress(html);

    expect(progress.done).toBe(false);
    expect(progress.total).toBe(2);
    expect(progress.completed).toBe(0);
  });

  it("reports a job as finished once the progress value appears", () => {
    const html = progressFragment({
      userId: "7",
      jobId: "1000",
      numFiles: 2,
      files: [
        { name: "a.pdf", status: "done" },
        { name: "b.pdf", status: "done" },
      ],
    });
    const progress = parseJobProgress(html);

    expect(progress.done).toBe(true);
    expect(progress.completed).toBe(2);
    expect(progress.files.map((f) => f.outputFileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("recovers the user id from a download link", () => {
    const html = progressFragment({
      userId: "424242",
      jobId: "1000",
      numFiles: 1,
      files: [{ name: "a.pdf", status: "done" }],
    });

    expect(parseJobProgress(html).userId).toBe("424242");
  });

  it("captures per-file failure status", () => {
    const html = progressFragment({
      userId: "7",
      jobId: "1000",
      numFiles: 1,
      files: [{ name: "broken.pdf", status: "failed" }],
    });

    expect(parseJobProgress(html).files[0]).toEqual({
      outputFileName: "broken.pdf",
      status: "failed",
    });
  });

  it("never claims completion for a job that has not been sized", () => {
    // A zero-file job would otherwise satisfy files.length === num_files.
    const html = progressFragment({ userId: "7", jobId: "1", numFiles: 0, files: [] });
    expect(parseJobProgress(html).done).toBe(false);
  });
});
