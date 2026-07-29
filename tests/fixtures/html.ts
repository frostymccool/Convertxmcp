/**
 * HTML fixtures mirroring what ConvertX actually renders.
 *
 * These are trimmed copies of the markup produced by ConvertX's JSX pages
 * (`src/pages/chooseConverter.tsx` and `src/pages/results.tsx`), keeping every
 * attribute the parsers rely on and the Tailwind class soup they must ignore.
 */

export interface FixtureTarget {
  target: string;
  converter: string;
}

/** Mirrors the fragment returned by `POST /conversions`. */
export function conversionsFragment(targets: FixtureTarget[]): string {
  const byConverter = new Map<string, string[]>();
  for (const t of targets) {
    byConverter.set(t.converter, [...(byConverter.get(t.converter) ?? []), t.target]);
  }

  const groups = [...byConverter]
    .map(
      ([converter, list]) => `
    <article class="convert_to_group flex w-full flex-col border-b p-4" data-converter="${converter}">
      <header class="mb-2 w-full text-xl font-bold">${converter}</header>
      <ul class="convert_to_target flex flex-row flex-wrap gap-1">
        ${list
          .map(
            (target) => `<button tabindex="0" class="target rounded-sm bg-neutral-700 p-1"
             data-value="${target},${converter}" data-target="${target}"
             data-converter="${converter}" type="button">${target}</button>`,
          )
          .join("\n        ")}
      </ul>
    </article>`,
    )
    .join("\n");

  const options = [...byConverter]
    .map(
      ([converter, list]) =>
        `<optgroup label="${converter}">${list
          .map((t) => `<option value="${t},${converter}">${t}</option>`)
          .join("")}</optgroup>`,
    )
    .join("");

  return `<article class="convert_to_popup absolute z-2 m-0 hidden">${groups}</article>
<select name="convert_to" aria-label="Convert to" required hidden>
  <option selected disabled value="">Convert to</option>
  ${options}
</select>`;
}

/** An older ConvertX build that renders only the hidden <select>. */
export function conversionsSelectOnly(targets: FixtureTarget[]): string {
  return `<select name="convert_to" required hidden>
  <option selected disabled value="">Convert to</option>
  ${targets.map((t) => `<option value="${t.target},${t.converter}">${t.target}</option>`).join("")}
</select>`;
}

export interface FixtureFile {
  name: string;
  status: string;
}

/** Mirrors the fragment returned by `POST /progress/:jobId`. */
export function progressFragment(options: {
  userId: string;
  jobId: string;
  numFiles: number;
  files: FixtureFile[];
}): string {
  const { userId, jobId, numFiles, files } = options;
  // ConvertX renders `value` only once every expected file exists.
  const valueAttr = files.length === numFiles ? ` value="${files.length}"` : "";

  const rows = files
    .map(
      (file) => `
      <tr>
        <td class="max-w-[20vw] truncate">${file.name}</td>
        <td>${file.status}</td>
        <td class="flex flex-row gap-4">
          <a class="text-accent-500 underline" href="/download/${userId}/${jobId}/${file.name}">
            <svg></svg>
          </a>
          <a class="text-accent-500 underline"
             href="/download/${userId}/${jobId}/${file.name}" download="${file.name}">
            <svg></svg>
          </a>
        </td>
      </tr>`,
    )
    .join("");

  return `<article class="article">
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-xl">Results</h1>
    <form action="/delete/${jobId}" method="POST"><button type="submit">Delete</button></form>
    <a href="/archive/${jobId}" download="converted_files_${jobId}.tar">Tar</a>
  </div>
  <progress max="${numFiles}"${valueAttr} class="mb-4 inline-block h-2 w-full"></progress>
  <table class="w-full table-auto">
    <thead><tr><th>Converted File Name</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</article>`;
}

/** Builds an unsigned JWT shaped like ConvertX's auth cookie. */
export function authToken(userId: string): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: userId })}.signature`;
}
