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
const chatView = await readFile(new URL("../public/chat/chat-view.js", import.meta.url), "utf8");
const manifest = await readFile(
  new URL("../public/manifest.webmanifest", import.meta.url),
  "utf8",
);

test("uses the 1.2.71 release version for the PWA and all cached assets", () => {
  assert.equal(packageJson.version, "1.2.71");
  assert.doesNotMatch(page, /\?v=(?!1\.2\.71)[^"']+/u);
  assert.doesNotMatch(app, /\?v=(?!1\.2\.71)[^"']+/u);
  assert.doesNotMatch(worker, /\?v=(?!1\.2\.71)[^"']+/u);
  assert.doesNotMatch(manifest, /\?v=(?!1\.2\.71)[^"']+/u);
  assert.doesNotMatch(chatView, /\?v=(?!1\.2\.71)[^"']+/u);
  assert.match(worker, /const CACHE_NAME = "herd-rabbit-v1\.2\.71"/u);
});

test("every page, script and stylesheet under public asks for its assets at the package version", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = new URL("../public/", import.meta.url);
  const files = (await readdir(root, { recursive: true }))
    .filter((name) => /\.(?:m?js|html|css|webmanifest)$/u.test(name) && !name.startsWith("vendor/") && !name.startsWith("vendor\\"));
  assert.ok(files.length > 20, "the public tree was read");
  const stale = [];
  for (const name of files) {
    const text = await readFile(new URL(name, root), "utf8");
    for (const match of text.matchAll(/\?v=([0-9][^"'`)\s]*)/gu)) {
      if (match[1] !== packageJson.version) stale.push(`${name}: ?v=${match[1]}`);
    }
  }
  assert.deepEqual(stale, [], "no asset is asked for at another version");
});

test("the Herdr plugin manifest carries the package version", async () => {
  const manifest = await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  const version = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(manifest)?.[1];
  assert.equal(version, packageJson.version);
});
