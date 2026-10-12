import { readFile } from "node:fs/promises";

// An older version linked other PCs by installing a second HerdRabbit there
// (a "leaf") and saved those links in servers.json. Remote PCs are Herdr's own
// SSH machines now, so the links are not used. The file is left where it is --
// it is the owner's -- and only counted, so the page can say once that those
// PCs have to be added again with herdr machine.
export async function countLegacyServers(file) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  try {
    const values = JSON.parse(source);
    return Array.isArray(values) ? values.length : 0;
  } catch {
    // Unreadable as a list is still something the owner saved.
    return source.trim() === "" ? 0 : 1;
  }
}
