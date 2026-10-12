import { pathToFileURL } from "node:url";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "../src/herdr-version.mjs";

const binary = process.env.HERDR_BIN || "herdr";
// The updater hands over the version module of the code it is about to
// install, so a release that raises the minimum is checked against it. That
// module failing to load stops the update rather than falling back.
async function requiredMinimum() {
  const incoming = process.env.HERDR_VERSION_MODULE;
  if (!incoming) return MIN_HERDR_VERSION;
  const { MIN_HERDR_VERSION: minimum } = await import(pathToFileURL(incoming).href);
  if (typeof minimum !== "string" || !minimum) throw new Error(`${incoming} names no MIN_HERDR_VERSION`);
  return minimum;
}

const minimum = await requiredMinimum().catch((error) => {
  console.error(`Could not read the Herdr version the new code needs: ${error.message}`);
  process.exit(1);
});
const version = await readHerdrVersion(binary);
if (!herdrVersionSupported(version, minimum)) {
  console.error(`Herdr ${version || "(unknown version)"} is older than ${minimum}. Run: ${binary} update --handoff`);
  process.exit(1);
}
console.log(`Herdr ${version}`);
