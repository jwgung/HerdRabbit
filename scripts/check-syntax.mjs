import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

// Every script the server, the browser or the installer runs, found rather
// than listed, so a new file cannot be left out of the check.
async function listScripts(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.m?js$/u.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

const files = (await Promise.all(["src", "public", "scripts"].map(listScripts))).flat();
const shells = ["install.sh", "update.sh", "migrate-to-plugin.sh"];
const failures = [];
for (const file of files) {
  await run(process.execPath, ["--check", file], { cwd: root }).catch((error) => failures.push([file, error.stderr]));
}
for (const shell of shells) {
  await run("sh", ["-n", shell], { cwd: root }).catch((error) => failures.push([shell, error.stderr]));
}
for (const [file, message] of failures) console.error(`${file}\n${message}`);
if (failures.length > 0) process.exit(1);
console.log(`Syntax OK: ${files.length + shells.length} files`);
