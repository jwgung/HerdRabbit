import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  directoryFingerprint,
  FileAccessError,
  fileAccessError,
  listDirectory,
  openFile,
  validateBrowsePath,
} from "../src/file-browser.mjs";

const run = promisify(execFile);

async function scratch() {
  return mkdtemp(join(tmpdir(), "herdrabbit-browse-"));
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function names(listing) {
  return listing.entries.map((entry) => entry.name);
}

test("requires an absolute path without control characters", () => {
  assert.equal(validateBrowsePath("/etc/hosts"), "/etc/hosts");
  assert.equal(validateBrowsePath("/tmp/../etc"), "/etc");
  for (const value of ["", "relative/path", "\u0000/etc", "/etc\n/passwd", null, "a".repeat(5000)]) {
    assert.throws(() => validateBrowsePath(value), FileAccessError, String(value));
  }
});

test("maps filesystem errors onto status codes instead of leaking 500s", () => {
  assert.equal(fileAccessError({ code: "EACCES" }).status, 403);
  assert.equal(fileAccessError({ code: "ENOENT" }).status, 404);
  assert.equal(fileAccessError({ code: "ELOOP" }).status, 400);
  assert.equal(fileAccessError({ code: "EMFILE" }).status, 503);
  assert.equal(fileAccessError({ code: "ESOMETHINGELSE" }), null);
  const own = new FileAccessError(418, "teapot", "kept as is");
  assert.equal(fileAccessError(own), own);
});

test("lists folders before files and reports the parent", async () => {
  const directory = await scratch();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "a.txt"), "one");
  await writeFile(join(directory, "b.txt"), "two");

  const listing = await listDirectory(directory);
  assert.deepEqual(names(listing), ["src", "a.txt", "b.txt"]);
  assert.equal(listing.path, await import("node:fs/promises").then((fs) => fs.realpath(directory)));
  assert.equal(listing.truncated, false);
  assert.equal(listing.entries[1].size, 3);
  assert.equal(listing.entries[1].kind, "file");
  assert.equal(listing.entries[0].kind, "directory");
  assert.ok(listing.parent);
});

test("reports no parent at the root", async () => {
  const listing = await listDirectory("/");
  assert.equal(listing.parent, null);
  assert.ok(listing.entries.length > 0);
});

test("marks hidden entries without dropping them", async () => {
  const directory = await scratch();
  await writeFile(join(directory, ".env"), "SECRET=1");
  await writeFile(join(directory, "visible.txt"), "ok");

  const listing = await listDirectory(directory);
  assert.deepEqual(names(listing), [".env", "visible.txt"]);
  assert.equal(listing.entries[0].hidden, true);
  assert.equal(listing.entries[1].hidden, false);
});

test("follows symbolic links and flags broken ones", async () => {
  const directory = await scratch();
  const target = await scratch();
  await writeFile(join(target, "inside.txt"), "reachable");
  await writeFile(join(directory, "real.txt"), "plain");
  await symlink(target, join(directory, "folder-link"));
  await symlink(join(target, "inside.txt"), join(directory, "file-link"));
  await symlink(join(target, "absent.txt"), join(directory, "dead-link"));

  const listing = await listDirectory(directory);
  const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));

  assert.equal(byName["folder-link"].kind, "directory", "a link to a folder acts like a folder");
  assert.equal(byName["folder-link"].symlink, true);
  assert.equal(byName["file-link"].kind, "file");
  assert.equal(byName["file-link"].size, 9);
  assert.equal(byName["dead-link"].broken, true);
  assert.equal(byName["real.txt"].symlink, undefined);

  // A link to a folder can be entered, and lands on the resolved location.
  const followed = await listDirectory(join(directory, "folder-link"));
  assert.deepEqual(names(followed), ["inside.txt"]);
});

test("clips a large folder to the first names in order", async () => {
  const directory = await scratch();
  for (let index = 0; index < 30; index += 1) {
    await writeFile(join(directory, `file-${String(index).padStart(3, "0")}.txt`), "x");
  }

  const listing = await listDirectory(directory, { limit: 10 });
  assert.equal(listing.entries.length, 10);
  assert.equal(listing.truncated, true);
  assert.equal(listing.total, 30);
  assert.equal(listing.entries[0].name, "file-000.txt");
  assert.equal(listing.entries[9].name, "file-009.txt");
});

test("opens a regular file with its length known", async () => {
  const directory = await scratch();
  await writeFile(join(directory, "report.txt"), "hello there");

  const file = await openFile(join(directory, "report.txt"));
  assert.equal(file.name, "report.txt");
  assert.equal(file.size, 11);
  assert.equal((await readAll(file.stream)).toString("utf8"), "hello there");
});

test("streams a file whose size the kernel reports as zero", async () => {
  // procfs holds content while reporting size 0, so the length is unknown
  // rather than empty and the body must still arrive.
  const file = await openFile("/proc/self/status");
  assert.equal(file.size, null, "size is unknown, not zero");
  const body = (await readAll(file.stream)).toString("utf8");
  assert.match(body, /^Name:/u);
});

test("refuses a FIFO instead of blocking on it", async (context) => {
  const directory = await scratch();
  const fifo = join(directory, "pipe");
  try {
    await run("mkfifo", [fifo]);
  } catch {
    context.skip("mkfifo is unavailable");
    return;
  }

  // Opening a FIFO the ordinary way never returns while no writer exists and
  // holds a libuv thread that logins share, so this must fail fast.
  const started = Date.now();
  await assert.rejects(() => openFile(fifo), (error) => error.status === 400);
  assert.ok(Date.now() - started < 2000, "the open returned instead of blocking");

  const listing = await listDirectory(directory);
  assert.equal(listing.entries[0].kind, "other", "a FIFO is not offered as a file");
});

test("refuses directories and character devices", async () => {
  const directory = await scratch();
  await assert.rejects(() => openFile(directory), (error) => error.status === 400);
  await assert.rejects(() => openFile("/dev/zero"), (error) => error.status === 400);
});

test("refuses a file past the download ceiling", async () => {
  const directory = await scratch();
  await writeFile(join(directory, "big.bin"), "0123456789");
  await assert.rejects(
    () => openFile(join(directory, "big.bin"), { maxBytes: 4 }),
    (error) => error.status === 413,
  );
});

test("surfaces missing paths as recoverable errors", async () => {
  const directory = await scratch();
  await assert.rejects(
    () => listDirectory(join(directory, "absent")),
    (error) => fileAccessError(error)?.status === 404,
  );
  await assert.rejects(
    () => openFile(join(directory, "absent.txt")),
    (error) => fileAccessError(error)?.status === 404,
  );
});

test("directoryFingerprint detects file creation and deletion", async () => {
  const directory = await scratch();
  const initial = await directoryFingerprint(directory);
  assert.ok(typeof initial === "string" && initial.includes(":"));

  const filePath = join(directory, "test.txt");
  await writeFile(filePath, "sample");
  const afterAdd = await directoryFingerprint(directory);
  assert.notEqual(afterAdd, initial);

  const { unlink } = await import("node:fs/promises");
  await unlink(filePath);
  const afterRemove = await directoryFingerprint(directory);
  assert.notEqual(afterRemove, afterAdd);
});


test("a file of unknown size streams up to the unknown-size cap, or a smaller limit", async () => {
  const unlimited = await openFile("/proc/self/status");
  assert.equal(unlimited.size, null);
  assert.equal(unlimited.stream.readableHighWaterMark > 0, true);
  unlimited.stream.destroy();
  const limited = await openFile("/proc/self/status", { maxBytes: 5 });
  const chunks = [];
  for await (const chunk of limited.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 5);
});

test("a sized file is not limited by default", async () => {
  const directory = await scratch();
  await writeFile(join(directory, "any.bin"), "0123456789");
  const file = await openFile(join(directory, "any.bin"), { maxBytes: Infinity });
  assert.equal(file.length, 10);
  file.stream.destroy();
});
