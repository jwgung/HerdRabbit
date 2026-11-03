// update.sh's question to origin's releases: given `git ls-remote --tags
// origin 'refs/tags/v*'` on stdin, prints the latest release tag (the highest
// vX.Y.Z, as src/app-update.mjs picks it) and exits 0 when it is newer than
// the version in this checkout's package.json, 3 when it is not (nothing to
// update to), or 1, printing nothing, when origin has no release.
import { readFile } from "node:fs/promises";
import { compareVersions, latestRelease } from "../src/app-update.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const release = latestRelease(Buffer.concat(chunks).toString("utf8"));
if (!release) {
  process.exitCode = 1;
} else {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(release.tag);
  process.exitCode = compareVersions(release.version, version) > 0 ? 0 : 3;
}
