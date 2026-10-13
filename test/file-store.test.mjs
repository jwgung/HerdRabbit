import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readdir, rm, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, safeTransferName, validateTransferName } from "../src/file-store.mjs";
import { InputValidationError } from "../src/herdr-client.mjs";

async function createStore(options) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-files-"));
  return { directory, store: await FileStore.load(directory, options) };
}

function body(text) {
  return Readable.from([Buffer.from(text)]);
}

test("keeps uploaded names inside the uploads folder", () => {
  assert.equal(safeTransferName("../../etc/passwd"), "passwd");
  assert.equal(safeTransferName("/etc/shadow"), "shadow");
  assert.equal(safeTransferName("report.log"), "report.log");
  assert.equal(safeTransferName("../"), "file");
  assert.equal(safeTransferName(".gitignore"), "gitignore");
  assert.equal(safeTransferName(""), "file");
  assert.equal(safeTransferName(undefined), "file");
});

test("keeps a name readable instead of flattening it", () => {
  assert.equal(safeTransferName("보고서.pdf"), "보고서.pdf");
  assert.equal(safeTransferName("2026년 3월 정산.xlsx"), "2026년_3월_정산.xlsx");
  assert.equal(safeTransferName("Übersicht (final).pdf"), "Übersicht__final_.pdf");
  assert.equal(safeTransferName("스크린샷 2026-09-09.png"), "스크린샷_2026-09-09.png");
});

test("replaces the characters that would break a pasted shell path", () => {
  assert.equal(safeTransferName("a b.txt"), "a_b.txt");
  assert.equal(safeTransferName("rm -rf $HOME; echo.sh"), "rm_-rf__HOME__echo.sh");
  assert.equal(safeTransferName("`whoami`.txt"), "_whoami_.txt");
  assert.equal(safeTransferName("a|b&c.txt"), "a_b_c.txt");
  assert.equal(safeTransferName("quote'name\"here.txt"), "quote_name_here.txt");
});

test("trims a long name by bytes so the filesystem accepts it", () => {
  const ascii = safeTransferName(`${"a".repeat(400)}.txt`);
  assert.equal(Buffer.byteLength(ascii), 200);
  assert(ascii.endsWith(".txt"), "the extension survives the trim");

  const korean = safeTransferName(`${"가".repeat(200)}.pdf`);
  assert(Buffer.byteLength(korean) <= 200, "a multibyte name fits the byte budget");
  assert(korean.endsWith(".pdf"), "the extension survives a multibyte trim");
});

test("rejects download names that escape the uploads folder", () => {
  assert.equal(validateTransferName("report.log"), "report.log");
  assert.equal(validateTransferName(encodeURIComponent("보고서.pdf")), "보고서.pdf");
  for (const value of ["..", ".", "%2e%2e%2f", "%2fetc%2fpasswd", "a/b", "", "%ZZ", ".part-1"]) {
    assert.throws(() => validateTransferName(value), InputValidationError, value);
  }
});

test("stores an upload with owner-only permissions", async () => {
  const { directory, store } = await createStore();
  const saved = await store.save("report.log", body("hello"));

  assert.equal(saved.name, "report.log");
  assert.equal(saved.size, 5);
  assert.equal(await readFile(join(directory, "report.log"), "utf8"), "hello");

  const [listed] = await store.list();
  assert.equal(listed.name, "report.log");
  assert.equal(listed.path, join(directory, "report.log"));
});

test("numbers colliding names instead of overwriting them", async () => {
  const { store } = await createStore();
  assert.equal((await store.save("a.tar.gz", body("one"))).name, "a.tar.gz");
  assert.equal((await store.save("a.tar.gz", body("two"))).name, "a.tar-2.gz");
  assert.equal((await store.save("a.tar.gz", body("three"))).name, "a.tar-3.gz");
  assert.equal((await store.save("Makefile", body("x"))).name, "Makefile");
  assert.equal((await store.save("Makefile", body("y"))).name, "Makefile-2");

  const names = (await store.list()).map((file) => file.name);
  assert.deepEqual(names, ["Makefile", "Makefile-2", "a.tar-2.gz", "a.tar-3.gz", "a.tar.gz"]);
});

test("keeps concurrent uploads of one name from losing a file", async () => {
  const { store } = await createStore();
  const saved = await Promise.all([
    store.save("shared.txt", body("first")),
    store.save("shared.txt", body("second")),
    store.save("shared.txt", body("third")),
  ]);

  assert.equal(new Set(saved.map((file) => file.name)).size, 3);
  assert.equal((await store.list()).length, 3);
});

test("refuses a file past the size limit and leaves nothing behind", async () => {
  const { directory, store } = await createStore({ maxBytes: 8 });
  await assert.rejects(() => store.save("big.bin", body("far too long")), InputValidationError);

  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(await store.list(), []);
});

test("hides directories, symlinks, and unusable names from the listing", async () => {
  const { directory, store } = await createStore();
  await store.save("visible.txt", body("ok"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "outside.txt"), "secret");
  await symlink(join(directory, "outside.txt"), join(directory, "link.txt"));

  const names = (await store.list()).map((file) => file.name);
  assert.deepEqual(names, ["outside.txt", "visible.txt"]);

  await assert.rejects(() => store.open("link.txt"), InputValidationError);
  await assert.rejects(() => store.open("nested"), InputValidationError);
  await assert.rejects(() => store.open("missing.txt"), InputValidationError);
});

test("serves a file that was copied in from a terminal", async () => {
  const { directory, store } = await createStore();
  await writeFile(join(directory, "보고서.pdf"), "report");

  const listed = await store.list();
  assert.equal(listed[0].name, "보고서.pdf");

  const { file, stream } = await store.open("보고서.pdf");
  assert.equal(file.size, 6);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "report");
});

test("deletes only files that the listing shows", async () => {
  const { directory, store } = await createStore();
  await store.save("gone.txt", body("bye"));
  await store.remove("gone.txt");

  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(() => store.remove("gone.txt"), InputValidationError);
});

test("clears stranded partial uploads at startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-files-"));
  await writeFile(join(directory, ".part-abandoned"), "half");
  await writeFile(join(directory, "kept.txt"), "whole");

  const store = await FileStore.load(directory);
  assert.deepEqual(await readdir(directory), ["kept.txt"]);
  assert.deepEqual((await store.list()).map((file) => file.name), ["kept.txt"]);
});

test("reports an empty uploads folder before anything is uploaded", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "herdrabbit-files-")), "absent");
  const store = new FileStore(directory);
  assert.deepEqual(await store.list(), []);
});

test("stores a file far past the old 50MB cap when no limit is set", async () => {
  const { directory, store } = await createStore();
  const chunk = Buffer.alloc(1024 * 1024, 7);
  let remaining = 60;
  const source = new Readable({ read() { this.push(remaining-- > 0 ? chunk : null); } });
  try {
    const saved = await store.save("huge.bin", source);
    assert.equal(saved.size, 60 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
