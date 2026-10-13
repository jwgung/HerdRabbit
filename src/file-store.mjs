import { createReadStream, constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { InputValidationError } from "./herdr-client.mjs";

// What an upload is trimmed to, leaving room for a "-2" collision suffix under
// the 255-byte limit most filesystems impose. Names already on disk are allowed
// the full 255 so a file copied in from a terminal still lists and downloads.
const MAX_NAME_BYTES = 200;
const MAX_STORED_NAME_BYTES = 255;
export const TEMPORARY_PREFIX = ".part-";
const FALLBACK_NAME = "file";
const MAX_NAME_ATTEMPTS = 100;
// Separators, shell metacharacters, and whitespace only. Everything else is
// kept, so a Korean or accented name survives the trip intact -- the stored
// path gets pasted into a shell, which is what these characters would break.
const UNSAFE_NAME_CHARACTERS = /[\s<>:"/\\|?*;&$`'()\[\]{}!#~^]/gu;

function nameBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

// Cutting by characters would still overflow the byte limit, since one Korean
// character costs three bytes. The extension is kept when there is room for it.
function limitNameBytes(name) {
  if (nameBytes(name) <= MAX_NAME_BYTES) return name;
  const { stem, extension } = splitExtension(name);
  const room = nameBytes(extension) <= 24 ? MAX_NAME_BYTES - nameBytes(extension) : MAX_NAME_BYTES;
  const suffix = nameBytes(extension) <= 24 ? extension : "";
  let cut = nameBytes(extension) <= 24 ? stem : name;
  while (cut.length > 0 && nameBytes(cut) > room) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}

// Uploads convert rather than reject: refusing a file the user already picked
// because of its name is worse than storing it under a safe one.
export function safeTransferName(raw) {
  const candidate = typeof raw === "string" ? basename(raw) : "";
  const cleaned = limitNameBytes(
    candidate
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .replace(UNSAFE_NAME_CHARACTERS, "_")
      .replace(/^\.+/u, ""),
  );
  return cleaned === "" ? FALLBACK_NAME : cleaned;
}

// Download and delete take their name from the URL, so this side rejects
// instead of converting. Percent-encoded separators only appear after
// decoding, which is why the check runs on the decoded value.
export function validateTransferName(raw) {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new InputValidationError("Invalid file name");
  }
  if (
    typeof decoded !== "string" ||
    decoded === "" ||
    nameBytes(decoded) > MAX_STORED_NAME_BYTES ||
    decoded === "." ||
    decoded === ".." ||
    decoded.startsWith(TEMPORARY_PREFIX) ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    throw new InputValidationError("Invalid file name");
  }
  return decoded;
}

export function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function numberedName(name, attempt) {
  if (attempt === 1) return name;
  const { stem, extension } = splitExtension(name);
  return `${stem}-${attempt}${extension}`;
}

export class FileStore {
  constructor(directory, { maxBytes = Infinity } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  static async load(directory, options) {
    const store = new FileStore(directory, options);
    await store.#ready();
    await store.#discardTemporaryFiles();
    return store;
  }

  async #ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  // A crash or a client disconnect can strand a partial upload. These belong to
  // no one, so clearing them at startup is not the automatic cleanup of user
  // files that the uploads folder deliberately avoids.
  async #discardTemporaryFiles() {
    for (const entry of await this.#entries()) {
      if (!entry.startsWith(TEMPORARY_PREFIX)) continue;
      await rm(join(this.directory, entry), { force: true });
    }
  }

  async #entries() {
    try {
      return await readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  // Names come off the disk, so a file copied in from a terminal can carry
  // anything. Directories, symlinks, and unusable names stay out of the listing
  // that download and delete are checked against.
  async list() {
    const files = [];
    for (const name of await this.#entries()) {
      if (name.startsWith(TEMPORARY_PREFIX)) continue;
      if (nameBytes(name) > MAX_STORED_NAME_BYTES) continue;
      if (/[\u0000-\u001f\u007f]/u.test(name)) continue;
      const path = this.#resolve(name);
      if (path === null) continue;
      let stats;
      try {
        stats = await lstat(path);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({
        name,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        path,
      });
    }
    // Code point order rather than locale order so the listing is the same on
    // every machine that serves it.
    return files.sort((first, second) => (first.name < second.name ? -1 : 1));
  }

  // Second gate behind the listing check: whatever the name looks like, the
  // resolved path has to stay inside the uploads folder.
  #resolve(name) {
    const path = resolve(this.directory, name);
    const root = resolve(this.directory);
    return path.startsWith(`${root}${sep}`) ? path : null;
  }

  async #locate(name) {
    const files = await this.list();
    const file = files.find((entry) => entry.name === name);
    if (!file) throw new InputValidationError("File not found");
    return file;
  }

  async save(requestedName, source) {
    await this.#ready();
    const name = safeTransferName(requestedName);
    const temporary = join(this.directory, `${TEMPORARY_PREFIX}${randomUUID()}`);
    let written = 0;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        source.on("data", (chunk) => {
          written += chunk.length;
        });
        await pipeline(source, handle.createWriteStream());
      } finally {
        await handle.close().catch(() => {});
      }
      if (written > this.maxBytes) {
        throw new InputValidationError("The file is larger than the upload limit.");
      }
      return await this.#claim(temporary, name, written);
    } catch (error) {
      await rm(temporary, { force: true });
      if (error.code === "ENOSPC") {
        throw new InputValidationError("The disk is full. Delete some files and try again.");
      }
      throw error;
    }
  }

  // link() fails when the target exists instead of clobbering it the way
  // rename() would, so a concurrent upload can never replace a stored file.
  async #claim(temporary, name, size) {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const finalName = numberedName(name, attempt);
      const path = this.#resolve(finalName);
      if (path === null) throw new InputValidationError("Invalid file name");
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
      await unlink(temporary);
      return { name: finalName, size, modifiedAt: new Date().toISOString(), path };
    }
    throw new InputValidationError("Too many files share this name. Rename the file and try again.");
  }

  async open(name) {
    const file = await this.#locate(name);
    // O_NOFOLLOW closes the window between the listing check and the read: a
    // symlink swapped in after lstat still cannot be followed.
    const stream = createReadStream(file.path, {
      flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    });
    return { file, stream };
  }

  async remove(name) {
    const file = await this.#locate(name);
    await rm(file.path, { force: true });
  }
}
