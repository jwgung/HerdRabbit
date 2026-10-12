import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseByteRange } from "../public/file-preview.js";

const MAX_PATH_LENGTH = 4096;
export const MAX_LISTED_ENTRIES = 2000;
// A file that misreports its size (procfs, /proc/kcore) would otherwise stream
// without end. Downloads past this are refused with the path shown instead.
export const MAX_STREAM_BYTES = 1024 * 1024 * 1024;

export class FileAccessError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "FileAccessError";
    this.status = status;
    this.code = code;
  }
}

// Anything not mapped here would surface as a 500 and land in the error log.
const ERRNO_STATUS = new Map([
  ["EACCES", [403, "permission_denied", "You do not have permission to read this."]],
  ["EPERM", [403, "permission_denied", "You do not have permission to read this."]],
  ["ENOENT", [404, "not_found", "That path no longer exists."]],
  ["ENOTDIR", [404, "not_found", "That path is not a folder."]],
  ["EISDIR", [400, "is_directory", "That path is a folder."]],
  ["ELOOP", [400, "invalid_path", "That path loops through symbolic links."]],
  ["ENAMETOOLONG", [400, "invalid_path", "That path is too long."]],
  ["EINVAL", [400, "invalid_path", "That path cannot be read."]],
  ["EMFILE", [503, "too_many_files", "Too many open files. Try again shortly."]],
  ["ENFILE", [503, "too_many_files", "Too many open files. Try again shortly."]],
  ["ENXIO", [400, "not_a_file", "That path is not a regular file."]],
]);

export function fileAccessError(error) {
  if (error instanceof FileAccessError) return error;
  const mapped = ERRNO_STATUS.get(error?.code);
  if (!mapped) return null;
  return new FileAccessError(...mapped);
}

export function validateBrowsePath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_PATH_LENGTH ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new FileAccessError(400, "invalid_path", "Enter an absolute path.");
  }
  return resolve(value);
}

// readdir decodes names as UTF-8 and substitutes invalid bytes, so a name that
// does not survive the round trip cannot be used to reopen the file.
function isReadableName(name) {
  return !name.includes("\uFFFD") && Buffer.from(name, "utf8").toString("utf8") === name;
}

function entryKind(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

async function describeEntry(directory, name) {
  const path = resolve(directory, name);
  const entry = { name, path, hidden: name.startsWith("."), readable: isReadableName(name) };
  let link;
  try {
    link = await lstat(path);
  } catch {
    return { ...entry, kind: "other", unreadable: true };
  }

  if (!link.isSymbolicLink()) {
    return {
      ...entry,
      kind: entryKind(link),
      size: link.isFile() ? link.size : null,
      modifiedAt: link.mtime.toISOString(),
    };
  }

  // Report what the link points at so a folder link behaves like a folder.
  try {
    const target = await stat(path);
    return {
      ...entry,
      kind: entryKind(target),
      size: target.isFile() ? target.size : null,
      modifiedAt: target.mtime.toISOString(),
      symlink: true,
    };
  } catch {
    return { ...entry, kind: "other", symlink: true, broken: true };
  }
}

export async function listDirectory(rawPath, { limit = MAX_LISTED_ENTRIES, prefix = "" } = {}) {
  const requested = validateBrowsePath(rawPath);
  // Resolving symlinks keeps breadcrumbs and "go up" consistent, and lets the
  // kernel reject link loops for us.
  const directory = await realpath(requested);
  const all = await readdir(directory);

  // Completion filters here rather than in the browser: a folder like /tmp can
  // hold thousands of entries, and the match would otherwise be cut away by the
  // listing limit before it ever reached the client.
  const wanted = prefix === ""
    ? all
    : all.filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()));

  // Sort before truncating so a clipped listing is "the first N by name"
  // instead of an arbitrary subset in readdir order.
  const names = wanted.sort((first, second) => (first < second ? -1 : 1));
  const visible = names.slice(0, limit);
  const entries = [];
  for (const name of visible) entries.push(await describeEntry(directory, name));
  entries.sort((first, second) => {
    if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
    return first.name < second.name ? -1 : 1;
  });

  const parent = dirname(directory);
  const dirStat = await stat(directory).catch(() => null);
  const etag = dirStat ? `${dirStat.mtimeMs.toString(36)}:${all.length.toString(36)}` : undefined;
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
    truncated: names.length > visible.length,
    total: names.length,
    etag,
  };
}

export async function directoryFingerprint(rawPath) {
  const requested = validateBrowsePath(rawPath);
  const directory = await realpath(requested);
  const dirStat = await stat(directory);
  const all = await readdir(directory);
  return `${dirStat.mtimeMs.toString(36)}:${all.length.toString(36)}`;
}

// Opening a FIFO the ordinary way blocks until a writer appears, and the open
// runs on the libuv thread pool that logins and static files share -- a few of
// them would freeze the whole app. O_NONBLOCK returns immediately so fstat can
// reject anything that is not a regular file. O_NOFOLLOW is deliberately absent:
// browsing has no directory boundary to protect, so refusing symlinks would
// only break ordinary paths.
export async function openFile(rawPath, { maxBytes = MAX_STREAM_BYTES, rangeHeader = null } = {}) {
  const path = validateBrowsePath(rawPath);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  let stats;
  try {
    stats = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  if (!stats.isFile()) {
    await handle.close().catch(() => {});
    throw new FileAccessError(400, "not_a_file", "That path is not a regular file.");
  }
  if (stats.size > maxBytes) {
    await handle.close().catch(() => {});
    throw new FileAccessError(413, "file_too_large", "That file is too large to download here.");
  }

  // procfs and sysfs report size 0 while still holding content, so the length
  // is unknown rather than empty. Those stream without Content-Length, capped
  // so a file that lies about its size cannot stream forever.
  const size = stats.size > 0 ? stats.size : null;
  // A player seeking asks for a slice, and it asks many times for one file, so
  // the header is read here rather than by reopening the file to measure it
  // first. Only a file that knows its own length can serve a slice, which is
  // the same files that report a size above.
  const range = size === null ? null : parseByteRange(rangeHeader, size);
  if (range?.unsatisfiable) {
    await handle.close().catch(() => {});
    const error = new FileAccessError(416, "range_not_satisfiable", "That part of the file does not exist.");
    error.size = size;
    throw error;
  }
  const slice = range
    ? { start: range.start, end: range.end }
    : size === null ? { start: 0, end: maxBytes - 1 } : { start: 0, end: size - 1 };
  const stream = handle.createReadStream(slice);
  // A handle-backed stream does not close the handle for us, and leaving it to
  // garbage collection is an error in current Node.
  stream.once("close", () => void handle.close().catch(() => {}));

  return {
    name: basename(path),
    path,
    size,
    // What was actually opened. `range` is null when the whole file was, which
    // is the difference between answering 200 and answering 206.
    range,
    length: size === null ? null : slice.end - slice.start + 1,
    stream,
  };
}
