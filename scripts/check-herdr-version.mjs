import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "../src/herdr-version.mjs";

const binary = process.env.HERDR_BIN || "herdr";
// The updater passes the minimum of the code it is about to install.
const minimum = process.env.HERDR_MIN_VERSION || MIN_HERDR_VERSION;
const version = await readHerdrVersion(binary);
if (!herdrVersionSupported(version, minimum)) {
  console.error(`Herdr ${version || "(unknown version)"} is older than ${minimum}. Run: ${binary} update --handoff`);
  process.exit(1);
}
console.log(`Herdr ${version}`);
