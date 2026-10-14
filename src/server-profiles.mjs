import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InputValidationError } from "./herdr-client.mjs";
import { validateLinkProfile } from "./link-profiles.mjs";

const MAX_PROFILES = 20;

// Two copies of this pattern live in public/ (browse-preference.js,
// workspace-preference.js) because the browser cannot import from src/; a test
// keeps all three identical.
export const SERVER_ID_PATTERN = /^link_[a-f0-9-]{36}$/u;

export function newServerId() {
  return `link_${randomUUID()}`;
}

// Every server is another HerdRabbit now. The field is kept so records read
// the same everywhere and so a stored profile says what it is.
export function validateServerProfile(input) {
  return { ...validateLinkProfile(input), transport: "link" };
}

export class ServerProfiles {
  constructor(file, profiles = []) {
    this.file = file;
    this.profiles = profiles;
    this.pending = Promise.resolve();
  }

  static async load(file) {
    let values = [];
    try { values = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(values) || values.length > MAX_PROFILES) throw new Error("Invalid server configuration");
    const ids = new Set();
    const profiles = values.map((value) => {
      if (!SERVER_ID_PATTERN.test(value.id) || ids.has(value.id)) throw new Error("Invalid server id");
      ids.add(value.id);
      return { ...validateServerProfile(value), id: value.id };
    });
    return new ServerProfiles(file, profiles);
  }

  // A server profile holds no secret at all: the machine at the other end
  // recognises this one by the address its requests arrive from.
  list() { return this.profiles.map((profile) => ({ ...profile })); }

  connectionProfiles() { return this.profiles.map((profile) => ({ ...profile })); }

  change(operation) {
    const task = this.pending.then(async () => {
      const next = operation(this.connectionProfiles());
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      this.profiles = next;
      return this.list();
    });
    this.pending = task.catch(() => {});
    return task;
  }

  save(value, id = null) {
    const profile = { ...validateServerProfile(value), id: id || newServerId() };
    return this.change((values) => {
      if (id && !values.some((item) => item.id === id)) throw new InputValidationError("Server not found");
      if (!id && values.length >= MAX_PROFILES) throw new InputValidationError(`Up to ${MAX_PROFILES} servers are supported`);
      return id ? values.map((item) => item.id === id ? profile : item) : [...values, profile];
    });
  }

  remove(id) {
    return this.change((values) => {
      if (!values.some((item) => item.id === id)) throw new InputValidationError("Server not found");
      return values.filter((item) => item.id !== id);
    });
  }
}
