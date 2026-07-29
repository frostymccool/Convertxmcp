/**
 * Parsers for the HTML that ConvertX returns.
 *
 * ConvertX has no JSON API — its pages are server-rendered JSX. These parsers
 * therefore target the most stable thing on each page: the `data-*` attributes
 * and `href`s that ConvertX's own client-side JavaScript depends on. Presentation
 * classes (Tailwind utilities) change often and are never matched against.
 */

import { parse, type HTMLElement } from "node-html-parser";

export interface ConversionTarget {
  /** Target format, e.g. `png`. */
  target: string;
  /** Converter that performs it, e.g. `imagemagick`. */
  converter: string;
}

export interface JobFile {
  outputFileName: string;
  status: string;
}

export interface JobProgress {
  /** Files the job expects to produce. */
  total: number;
  /** Files ConvertX has recorded so far. */
  completed: number;
  /** True once ConvertX considers every file accounted for. */
  done: boolean;
  files: JobFile[];
  /** User id scraped from download links, when any are present. */
  userId?: string;
}

/**
 * Parses the fragment returned by `POST /conversions`.
 *
 * Each selectable target is rendered as `data-value="<target>,<converter>"`,
 * which is exactly the string `POST /convert` expects back in `convert_to`.
 */
export function parseConversionTargets(html: string): ConversionTarget[] {
  const root = parse(html);
  const seen = new Set<string>();
  const targets: ConversionTarget[] = [];

  for (const node of root.querySelectorAll("[data-value]")) {
    const value = node.getAttribute("data-value");
    if (!value) continue;

    const target = node.getAttribute("data-target") ?? value.split(",")[0];
    const converter = node.getAttribute("data-converter") ?? value.split(",")[1];
    if (!target || !converter) continue;

    const key = `${target},${converter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ target, converter });
  }

  // Older builds render only the hidden <select>; fall back to its options.
  if (targets.length === 0) {
    for (const option of root.querySelectorAll("option[value]")) {
      const value = option.getAttribute("value");
      if (!value || !value.includes(",")) continue;

      const [target, converter] = value.split(",");
      if (!target || !converter) continue;

      const key = `${target},${converter}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ target, converter });
    }
  }

  return targets;
}

/**
 * Parses the results fragment returned by `POST /progress/:jobId`.
 *
 * ConvertX signals completion by rendering `value` on the `<progress>` element
 * only once every expected file is present, so the presence of that attribute —
 * not a status string — is the authoritative "finished" signal.
 */
export function parseJobProgress(html: string): JobProgress {
  const root = parse(html);

  const progress = root.querySelector("progress");
  const total = toInt(progress?.getAttribute("max")) ?? 0;
  const valueAttr = progress?.getAttribute("value");

  const files: JobFile[] = [];
  for (const row of root.querySelectorAll("tbody tr")) {
    const cells = row.querySelectorAll("td");
    const name = cells[0]?.textContent?.trim();
    if (!name) continue;
    files.push({ outputFileName: name, status: cells[1]?.textContent?.trim() ?? "unknown" });
  }

  const userId = scrapeUserId(root);

  return {
    total,
    completed: files.length,
    // `value` is present iff files.length === num_files. Guard on total > 0 so a
    // job that has not been sized yet is never reported as finished.
    done: valueAttr !== undefined && valueAttr !== null && total > 0,
    files,
    ...(userId ? { userId } : {}),
  };
}

/**
 * Recovers the user id from a download link.
 *
 * Links are rendered as `/download/<userId>/<jobId>/<fileName>`; this is the
 * fallback for when the auth JWT could not be decoded.
 */
function scrapeUserId(root: HTMLElement): string | undefined {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const match = /\/download\/([^/]+)\/([^/]+)\//.exec(href);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function toInt(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}
