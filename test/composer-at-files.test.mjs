import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AT_MATCHES,
  applyAtCompletion,
  atReferenceText,
  createListingCache,
  matchingEntries,
  parseAtQuery,
  resolveAtDirectory,
} from "../public/composer-at-files.js";

const at = (value, caret = value.length) => parseAtQuery(value, caret, caret);

test("finds the @ reference the caret is in", () => {
  assert.deepEqual(at("@"), { start: 0, end: 1, query: "", quoted: false, dir: "", prefix: "" });
  assert.deepEqual(at("look at @src/ap"), { start: 8, end: 15, query: "src/ap", quoted: false, dir: "src/", prefix: "ap" });
  assert.equal(at("line one\n@do").start, 9);
  assert.equal(at("tab\t@x").start, 4);
  assert.deepEqual(at("@/etc/ho"), { start: 0, end: 8, query: "/etc/ho", quoted: false, dir: "/etc/", prefix: "ho" });
});

test("is no reference mid-word, after whitespace, or with a selection", () => {
  assert.equal(at("mail@example"), null);
  assert.equal(at("@src done"), null);
  assert.equal(at("@src "), null);
  assert.equal(at("plain text"), null);
  assert.equal(parseAtQuery("@src", 1, 3), null);
  assert.equal(parseAtQuery("@src", undefined), null);
});

test("takes in the rest of the word after the caret", () => {
  const token = parseAtQuery("@srcfoo bar", 4, 4);
  assert.equal(token.query, "src");
  assert.equal(token.end, 7);
});

test("reads a quoted reference with spaces, and its closing quote", () => {
  assert.deepEqual(at('see @"my folder/no'), { start: 4, end: 18, query: "my folder/no", quoted: true, dir: "my folder/", prefix: "no" });
  const value = '@"my folder/"';
  const inside = parseAtQuery(value, value.length - 1, value.length - 1);
  assert.equal(inside.query, "my folder/");
  assert.equal(inside.end, value.length, "the closing quote is part of it");
  assert.equal(at('@"done" '), null);
});

test("resolves the folder part against the pane's folder", () => {
  assert.equal(resolveAtDirectory("/home/me/proj", ""), "/home/me/proj");
  assert.equal(resolveAtDirectory("/home/me/proj/", "src/"), "/home/me/proj/src");
  assert.equal(resolveAtDirectory("/home/me/proj", "./src/../docs/"), "/home/me/proj/docs");
  assert.equal(resolveAtDirectory("/home/me/proj", "/etc/"), "/etc");
  assert.equal(resolveAtDirectory("/home/me/proj", "/"), "/");
  assert.equal(resolveAtDirectory("/", "../../"), "/");
});

test("does not resolve ~ or a relative folder without a working folder", () => {
  assert.equal(resolveAtDirectory("/home/me", "~/"), null);
  assert.equal(resolveAtDirectory("/home/me", "~"), null);
  assert.equal(resolveAtDirectory(null, "src/"), null);
  assert.equal(resolveAtDirectory("relative", "src/"), null);
  assert.equal(resolveAtDirectory(null, "/abs/"), "/abs");
});

const listing = [
  { name: "zeta.md", kind: "file" },
  { name: "Apps", kind: "directory" },
  { name: "app.js", kind: "file" },
  { name: "api", kind: "directory" },
  { name: ".env", kind: "file", hidden: true },
  { name: ".github", kind: "directory" },
  { name: "secret", kind: "directory", locked: true },
  { name: "socket", kind: "other" },
  { name: 'odd"name', kind: "file" },
];

test("offers folders first, then files, by name, matching the start", () => {
  assert.deepEqual(matchingEntries(listing, "").map((entry) => entry.name), ["Apps", "api", "app.js", "zeta.md"]);
  assert.deepEqual(matchingEntries(listing, "ap").map((entry) => entry.name), ["Apps", "api", "app.js"]);
  assert.deepEqual(matchingEntries(listing, "z").map((entry) => entry.name), ["zeta.md"]);
});

test("offers hidden names only for a leading dot, and never locked ones", () => {
  assert.deepEqual(matchingEntries(listing, ".").map((entry) => entry.name), [".github", ".env"]);
  assert.equal(matchingEntries(listing, "sec").length, 0);
  assert.equal(matchingEntries(listing, "so").length, 0);
  assert.equal(matchingEntries(listing, "odd").length, 0);
});

test("offers at most the limit", () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ name: `f${String(index).padStart(2, "0")}`, kind: "file" }));
  assert.equal(matchingEntries(many, "").length, MAX_AT_MATCHES);
  assert.equal(matchingEntries(many, "", 3).length, 3);
  assert.deepEqual(matchingEntries(null, ""), []);
});

test("quotes a reference with whitespace", () => {
  assert.equal(atReferenceText("src/app.js"), "@src/app.js");
  assert.equal(atReferenceText("my folder/a b.txt"), '@"my folder/a b.txt"');
  assert.equal(atReferenceText("plain", true), '@"plain"');
});

test("puts a file in with a space after it", () => {
  const value = "fix @src/ap please";
  const token = parseAtQuery(value, 11, 11);
  const next = applyAtCompletion(value, token, { name: "app.js", kind: "file" });
  assert.equal(next.value, "fix @src/app.js please");
  assert.equal(next.caret, "fix @src/app.js ".length);
  assert.equal(next.open, false);
  const end = applyAtCompletion("@ap", at("@ap"), { name: "app.js", kind: "file" });
  assert.deepEqual(end, { value: "@app.js ", caret: 8, open: false });
});

test("puts a folder in with its slash and keeps going inside it", () => {
  const next = applyAtCompletion("@sr", at("@sr"), { name: "src", kind: "directory" });
  assert.deepEqual(next, { value: "@src/", caret: 5, open: true });
  assert.equal(at(next.value, next.caret).dir, "src/");
});

test("quotes a name with a space, with the caret inside the quotes for a folder", () => {
  const folder = applyAtCompletion("@my", at("@my"), { name: "my folder", kind: "directory" });
  assert.equal(folder.value, '@"my folder/"');
  assert.equal(folder.caret, folder.value.length - 1);
  const inside = parseAtQuery(folder.value, folder.caret, folder.caret);
  assert.equal(inside.dir, "my folder/");
  const file = applyAtCompletion(folder.value, inside, { name: "notes.md", kind: "file" });
  assert.equal(file.value, '@"my folder/notes.md" ');
  assert.equal(file.caret, file.value.length);
  const spaced = applyAtCompletion("@a", at("@a"), { name: "a b.txt", kind: "file" });
  assert.equal(spaced.value, '@"a b.txt" ');
});

test("keeps listings briefly, and lets a whole shorter one answer a longer name", () => {
  let clock = 1_000;
  const cache = createListingCache({ ttlMs: 100, now: () => clock });
  const entries = [{ name: "app.js", kind: "file" }];
  assert.equal(cache.get("local", "/p", "a"), null);
  cache.set("local", "/p", "a", { entries, truncated: false });
  assert.equal(cache.get("local", "/p", "a"), entries);
  assert.equal(cache.get("local", "/p", "ap"), entries, "a whole listing for `a` holds every `ap`");
  assert.equal(cache.get("local", "/p", ""), null, "a shorter name is not inside it");
  assert.equal(cache.get("lab", "/p", "a"), null, "another machine is asked on its own");
  cache.set("local", "/q", "", { entries, truncated: true });
  assert.equal(cache.get("local", "/q", ""), entries);
  assert.equal(cache.get("local", "/q", "x"), null, "a cut-short listing cannot answer for a longer name");
  clock += 200;
  assert.equal(cache.get("local", "/p", "a"), null, "an old listing is asked again");
});

test("completing in the middle of a quoted name replaces the whole name, quote and all", () => {
  const value = 'use @"src/apple.js" now';
  const caret = 'use @"src/ap'.length;
  const token = parseAtQuery(value, caret, caret);
  assert.equal(token.prefix, "ap");
  assert.equal(value.slice(token.start, token.end), '@"src/apple.js"');
  const next = applyAtCompletion(value, token, { name: "api.js", kind: "file" });
  assert.equal(next.value, 'use @"src/api.js" now');
  // a quoted name still being typed, with no closing quote yet, ends at the caret
  const open = parseAtQuery('@"my fo', 7, 7);
  assert.equal(open.end, 7);
});
