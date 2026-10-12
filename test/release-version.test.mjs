import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
));
const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const manifest = await readFile(
  new URL("../public/manifest.webmanifest", import.meta.url),
  "utf8",
);

test("uses the 1.2.18 release version for the PWA and all cached assets", () => {
  assert.equal(packageJson.version, "1.2.18");
  assert.doesNotMatch(page, /\?v=(?!1\.2\.18)[^"']+/u);
  assert.doesNotMatch(app, /\?v=(?!1\.2\.18)[^"']+/u);
  assert.doesNotMatch(worker, /\?v=(?!1\.2\.18)[^"']+/u);
  assert.doesNotMatch(manifest, /\?v=(?!1\.2\.18)[^"']+/u);
  assert.match(worker, /const CACHE_NAME = "herd-rabbit-v1\.2\.18"/u);
});
