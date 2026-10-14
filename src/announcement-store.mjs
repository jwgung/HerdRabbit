import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Kept on disk so a hub restart does not lose track of the machines that have
// told it where they are. Nothing here is a secret -- a name, an address and a
// version -- but it sits with the rest of the configuration so one directory
// holds everything a machine remembers.
export async function readAnnouncements(file) {
  try {
    const values = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(values) ? values : [];
  } catch {
    // A missing or unreadable file simply means nothing has announced itself.
    return [];
  }
}

export function announcementWriter(file, { logger = console } = {}) {
  let pending = Promise.resolve();
  return (entries) => {
    pending = pending.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    }).catch((error) => {
      // Losing the file costs a rediscovery, not a failure worth stopping for.
      logger.error?.(`Could not save announcements: ${error.message}`);
    });
    return pending;
  };
}
