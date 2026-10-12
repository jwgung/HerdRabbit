import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "../src/herdr-version.mjs";

const binary = process.env.HERDR_BIN || "herdr";
const version = await readHerdrVersion(binary);
if (!herdrVersionSupported(version)) {
  console.error(`Herdr ${version || "(unknown version)"} is older than ${MIN_HERDR_VERSION}. Run: ${binary} update --handoff`);
  process.exit(1);
}
console.log(`Herdr ${version}`);
