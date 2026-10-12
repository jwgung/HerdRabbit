import { readFileSync } from "node:fs";

// The version this HerdRabbit reports for itself in the server list.
export function readAppVersion() {
  const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = JSON.parse(source).version;
  if (typeof version !== "string" || version === "") {
    throw new Error("package.json has no version");
  }
  return version;
}
