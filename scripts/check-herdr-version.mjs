import { pathToFileURL } from "node:url";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "../src/herdr-version.mjs";

const binary = process.env.HERDR_BIN || "herdr";
// The updater hands over the version module of the code it is about to
// install, so the check is that release's: its minimum, and its way of reading
// and comparing versions. That module failing to load stops the update rather
// than falling back.
async function versionRules() {
  const incoming = process.env.HERDR_VERSION_MODULE;
  if (!incoming) return { MIN_HERDR_VERSION, readHerdrVersion, herdrVersionSupported };
  const rules = await import(pathToFileURL(incoming).href);
  if (typeof rules.MIN_HERDR_VERSION !== "string" || !rules.MIN_HERDR_VERSION) {
    throw new Error(`${incoming} names no MIN_HERDR_VERSION`);
  }
  for (const name of ["readHerdrVersion", "herdrVersionSupported"]) {
    if (typeof rules[name] !== "function") throw new Error(`${incoming} has no ${name}`);
  }
  return rules;
}

// A release whose rules cannot judge (a misspelled minimum, say) stops the
// update the same way a module that cannot be read does.
async function judge() {
  const rules = await versionRules();
  const version = await rules.readHerdrVersion(binary);
  return { minimum: rules.MIN_HERDR_VERSION, version, supported: rules.herdrVersionSupported(version, rules.MIN_HERDR_VERSION) };
}

const { minimum, version, supported } = await judge().catch((error) => {
  console.error(`Could not read the Herdr version the new code needs: ${error.message}`);
  process.exit(1);
});
if (!supported) {
  console.error(`Herdr ${version || "(unknown version)"} is older than ${minimum}. Run: ${binary} update --handoff`);
  process.exit(1);
}
console.log(`Herdr ${version}`);
