// An HTML file shown as the page it is: with the styles, pictures and scripts
// beside it in its folder. The viewer opens it at
// /api/browse/site/<ticket>/<name>, and every relative URL the page asks for
// resolves under the same ticket, which stands for that folder alone.
//
// What keeps that safe is the response, not the frame:
//   - `sandbox allow-scripts` without `allow-same-origin`: the page runs in an
//     opaque origin. It has no cookie, no storage and no reach into this app's
//     origin, cannot submit forms, open windows or move the page around it.
//   - Every kind of request it may make is held to its own folder's URL (and
//     to data: and blob:), so a script that reads a file beside it -- a `.env`
//     -- has nowhere to send it. `internet` widens that to `https:`, for pages
//     built on a CDN; Settings > Files says what that costs.
//   - The ticket is the folder: a path that would climb out of it, or into a
//     protected file, is refused before anything is opened.

// The types a page's own files are served as. Anything else goes out as bytes
// a browser will not run (`nosniff` keeps it from guessing).
const TYPES = new Map(Object.entries({
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xhtml: "application/xhtml+xml",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
}));

export function siteContentType(name) {
  const base = String(name ?? "").split("/").pop();
  const dot = base.lastIndexOf(".");
  return TYPES.get(dot > 0 ? base.slice(dot + 1).toLowerCase() : "") ?? "application/octet-stream";
}

// Whether a file opens as a site: an HTML page, or Markdown rendered into one
// (whose pictures are as relative as a page's).
export function opensAsSite(name) {
  return /\.(?:html?|md|markdown)$/iu.test(String(name ?? ""));
}

// The path inside the folder a request names, or null for one that cannot be
// served: a climb out (`..`), an absolute or doubled path, a backslash or NUL,
// or bad escapes. "" is the folder itself, which serves the page it was opened for.
export function siteRelativePath(raw) {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const segments = [];
  for (const piece of raw.split("/")) {
    let segment;
    try {
      segment = decodeURIComponent(piece);
    } catch {
      return null;
    }
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
    segments.push(segment);
  }
  return segments.join("/");
}

// The folder a ticket stands for and the page it opens on, from the file
// asked for: `/a/b/report.html` is folder `/a/b`, page `report.html`.
export function siteOf(filePath) {
  const slash = filePath.lastIndexOf("/");
  return { root: slash <= 0 ? "/" : filePath.slice(0, slash), entry: filePath.slice(slash + 1) };
}

// Whether `real` (a resolved path) is `root` (resolved too) or inside it: a
// link in the folder that points out of it does not take the page with it.
export function insideRoot(real, root) {
  if (root === "/") return real.startsWith("/");
  return real === root || real.startsWith(`${root}/`);
}

// The policy a site's every response carries. `base` is the ticket's own URL,
// ending in a slash; requests are held to it by path.
export function siteContentSecurityPolicy(base, { internet = false } = {}) {
  const own = [base, "data:", "blob:", ...(internet ? ["https:"] : [])].join(" ");
  return [
    "default-src 'none'",
    `script-src ${own} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own}`,
    `font-src ${own}`,
    `media-src ${own}`,
    `connect-src ${own}`,
    `worker-src ${own}`,
    `frame-src ${own}`,
    `manifest-src ${base}`,
    `base-uri ${base}`,
    "form-action 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-scripts allow-downloads",
  ].join("; ");
}
