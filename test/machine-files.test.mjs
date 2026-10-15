import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MachineFiles, remoteCommand } from "../src/machine-files.mjs";
import { listDirectory } from "../src/file-browser.mjs";
import { HerdrMachines, machineOffline } from "../src/herdr-machines.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";

const ID = "4c139ff50dfb4a0dcda27e728dc50ef9";
const SERVER = "machine-4c139ff50dfb";
const UPLOADS = ".local/share/herdrabbit/files";

// Stands in for ssh: the remote command runs in a local shell, as the remote
// login shell would run it. Ending "ssh" closes its pipes but, as with a real
// remote command, leaves the script there to finish on its own.
function fakeSsh(home) {
  const commands = [];
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, "ssh");
    commands.push(args.at(-1));
    const child = spawn("sh", ["-c", args.at(-1)], { ...options, cwd: home, env: { ...process.env, HOME: home } });
    child.kill = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      return true;
    };
    return child;
  };
  return { commands, spawnProcess };
}

const fakeLink = () => ({
  ssh: "ssh", state: "ready",
  sshArgs: (options, ...command) => ["-S", "/run/x.ctl", ...options, "--", "me@lab", ...command],
});

async function setup(options = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-machine-home-")));
  const ssh = fakeSsh(home);
  const link = fakeLink();
  const files = new MachineFiles({ link: () => link, spawnProcess: ssh.spawnProcess, ...options });
  return { home, files, ...ssh };
}

async function text(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function oddFolder(home) {
  const folder = join(home, "odd");
  await mkdir(join(folder, "sub"), { recursive: true });
  await writeFile(join(folder, "plain.txt"), "plain");
  await writeFile(join(folder, "with space.md"), "space");
  await writeFile(join(folder, "quo'te\"d.txt"), "quoted");
  await writeFile(join(folder, "new\nline"), "line");
  await writeFile(join(folder, "$(touch pwned)"), "dollar");
  await writeFile(join(folder, ".hidden"), "quiet");
  await symlink("plain.txt", join(folder, "link-to-file"));
  await symlink("sub", join(folder, "link-to-folder"));
  await symlink("nowhere", join(folder, "broken"));
  // A name that is not UTF-8 at all.
  writeFileSync(Buffer.concat([Buffer.from(`${folder}/`), Buffer.from([0x66, 0xff, 0x6f])]), "bytes");
  return folder;
}

test("lists a machine's folder exactly as this machine lists its own, odd names and links included", async () => {
  const { home, files } = await setup();
  const folder = await oddFolder(home);
  const remote = await files.listDirectory(folder);
  const local = await listDirectory(folder);
  const strip = ({ etag, entries, ...rest }) => ({ ...rest, entries: entries.filter((entry) => entry.readable) });
  assert.deepEqual(strip(remote), strip(local));
  assert.ok(remote.entries.some((entry) => entry.name === "new\nline" && entry.kind === "file" && entry.size === 4));
  assert.deepEqual(remote.entries.find((entry) => entry.name === "broken"),
    { name: "broken", path: join(folder, "broken"), hidden: false, readable: true, kind: "other", symlink: true, broken: true });
  assert.equal(remote.entries.find((entry) => entry.name === "link-to-folder").kind, "directory");
  const unreadable = remote.entries.filter((entry) => !entry.readable);
  assert.equal(unreadable.length, 1, "a name that is not UTF-8 is listed but marked");
  assert.equal(existsSync(join(folder, "pwned")), false);
  assert.match(remote.etag, /^[0-9a-z.]+:[0-9a-z]+$/u);
});

test("filters by prefix and cuts a long listing to the first entries by name", async () => {
  const { home, files } = await setup();
  for (const name of ["b", "a", "c", "Ab"]) await writeFile(join(home, name), name);
  const cut = await files.listDirectory(home, { limit: 2 });
  assert.deepEqual([cut.entries.map((entry) => entry.name), cut.truncated, cut.total], [["Ab", "a"], true, 4]);
  const matched = await files.listDirectory(home, { prefix: "a" });
  assert.deepEqual(matched.entries.map((entry) => entry.name), ["Ab", "a"]);
});

test("with no path, lists the machine's home", async () => {
  const { home, files } = await setup();
  assert.equal((await files.listDirectory(null)).path, home);
});

test("maps a missing folder, a file and an unreadable folder to the local errors", async () => {
  const { home, files } = await setup();
  await writeFile(join(home, "file"), "x");
  await assert.rejects(files.listDirectory(join(home, "missing")), { status: 404, code: "not_found" });
  await assert.rejects(files.listDirectory(join(home, "file")), { status: 404, code: "not_found", message: "That path is not a folder." });
  await assert.rejects(files.listDirectory("relative/path"), { status: 400, code: "invalid_path" });
});

test("a folder's fingerprint matches its listing and changes with it; many come in one round trip", async () => {
  const { home, files, commands } = await setup();
  await mkdir(join(home, "a"));
  const listing = await files.listDirectory(join(home, "a"));
  assert.equal(await files.directoryFingerprint(join(home, "a")), listing.etag);
  await writeFile(join(home, "a", "new"), "x");
  const before = commands.length;
  const fingerprints = await files.directoryFingerprints([join(home, "a"), join(home, "gone"), "not absolute"]);
  assert.equal(commands.length, before + 1);
  assert.notEqual(fingerprints.get(join(home, "a")), listing.etag);
  assert.equal(fingerprints.get(join(home, "gone")), null);
  assert.equal(fingerprints.get("not absolute"), null);
  await assert.rejects(files.directoryFingerprint(join(home, "gone")), { code: "not_found" });
});

test("opens a file whole or by range, with its size known up front", async () => {
  const { home, files } = await setup();
  await writeFile(join(home, "clip.bin"), "0123456789");
  const whole = await files.openFile(join(home, "clip.bin"));
  assert.deepEqual([whole.name, whole.size, whole.range, whole.length], ["clip.bin", 10, null, 10]);
  assert.equal(await text(whole.stream), "0123456789");
  const part = await files.openFile(join(home, "clip.bin"), { rangeHeader: "bytes=2-4" });
  assert.deepEqual([part.size, part.range, part.length], [10, { start: 2, end: 4 }, 3]);
  assert.equal(await text(part.stream), "234");
  const tail = await files.openFile(join(home, "clip.bin"), { rangeHeader: "bytes=-3" });
  assert.equal(await text(tail.stream), "789");
  await assert.rejects(files.openFile(join(home, "clip.bin"), { rangeHeader: "bytes=20-" }), { status: 416, size: 10 });
  await assert.rejects(files.openFile(join(home, "clip.bin"), { maxBytes: 5 }), { status: 413, code: "file_too_large" });
  await assert.rejects(files.openFile(home), { status: 400, code: "not_a_file" });
  await assert.rejects(files.openFile(join(home, "missing")), { status: 404, code: "not_found" });
});

test("destroying an open file's stream ends the read on the machine", async () => {
  const { home, files } = await setup();
  await writeFile(join(home, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
  const opened = await files.openFile(join(home, "big.bin"));
  await once(opened.stream, "readable");
  opened.stream.destroy();
  await once(opened.stream, "close");
  // The stream slot comes back: five more opens go through.
  for (let index = 0; index < 6; index += 1) (await files.openFile(join(home, "big.bin"), { rangeHeader: "bytes=0-0" })).stream.resume();
});

test("an upload lands under a safe name, private, without replacing a file already there", async () => {
  const { home, files } = await setup();
  const directory = await files.uploadsDirectory();
  assert.equal(directory, join(home, UPLOADS));
  assert.deepEqual(await files.listUploads(), [], "no folder yet is an empty list");
  const first = await files.saveUpload("my report.txt", Readable.from([Buffer.from("hello")]), { bytes: 5 });
  assert.deepEqual([first.name, first.size, first.path], ["my_report.txt", 5, join(directory, "my_report.txt")]);
  const second = await files.saveUpload("my report.txt", Readable.from([Buffer.from("again!")]), { bytes: 6 });
  assert.equal(second.name, "my_report-2.txt");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal(await readFile(first.path, "utf8"), "hello");
  assert.deepEqual((await files.listUploads()).map((file) => [file.name, file.size]), [["my_report-2.txt", 6], ["my_report.txt", 5]]);

  const opened = await files.openUpload("my_report.txt");
  assert.deepEqual([opened.name, opened.size], ["my_report.txt", 5]);
  assert.equal(await text(opened.stream), "hello");
  await files.removeUpload("my_report.txt");
  assert.deepEqual((await files.listUploads()).map((file) => file.name), ["my_report-2.txt"]);
  await assert.rejects(files.removeUpload("my_report.txt"), { message: "File not found" });
  await assert.rejects(files.openUpload("my_report.txt"), { message: "File not found" });
});

test("the uploads list leaves out temporary files, links and folders, as the local one does", async () => {
  const { home, files } = await setup();
  const directory = join(home, UPLOADS);
  await mkdir(join(directory, "folder"), { recursive: true });
  await writeFile(join(directory, ".part-123"), "partial");
  await writeFile(join(directory, "kept"), "x");
  await symlink("/etc/hostname", join(directory, "link"));
  assert.deepEqual((await files.listUploads()).map((file) => file.name), ["kept"]);
  await assert.rejects(files.openUpload("link"), { message: "File not found" });
  await assert.rejects(files.removeUpload("link"), { message: "File not found" });
  assert.ok((await lstat(join(directory, "link"))).isSymbolicLink(), "a link in the uploads folder is never followed or removed");
  await assert.rejects(files.openUpload(".part-123"), { message: "Invalid file name" });
});

test("an upload that arrives short, too large or broken off leaves nothing behind", async () => {
  const { home, files } = await setup({ maxBytes: 8 });
  const directory = join(home, UPLOADS);
  await assert.rejects(files.saveUpload("short.txt", Readable.from([Buffer.from("abc")]), { bytes: 5 }), { message: /did not arrive whole/u });
  await assert.rejects(files.saveUpload("big.txt", Readable.from([Buffer.from("x".repeat(9))]), { bytes: 9 }), { message: /upload limit/u });
  await assert.rejects(files.saveUpload("big.txt", Readable.from([Buffer.from("x".repeat(9))]), { bytes: 4 }), { message: /upload limit/u });
  const broken = new Readable({ read() {} });
  const saving = files.saveUpload("cut.txt", broken, { bytes: 8 });
  broken.push(Buffer.from("abcd"));
  setTimeout(() => broken.destroy(new Error("client went away")), 50);
  await assert.rejects(saving, /client went away/u);
  // The script on the machine notices the short body and clears up by itself.
  const deadline = Date.now() + 5_000;
  while ((await readdir(directory)).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readdir(directory), []);
});

test("paths and names only ever reach the machine as quoted arguments, never inside a script", async () => {
  const { home, files, commands } = await setup();
  const marker = join(home, "pwned");
  const hostile = [
    `/tmp/x'; touch ${marker}; '`,
    `/tmp/$(touch ${marker})`,
    `/tmp/\`touch ${marker}\``,
    `/tmp/"; touch ${marker}; "`,
  ];
  for (const path of hostile) {
    await assert.rejects(files.listDirectory(path), { code: "not_found" });
    await assert.rejects(files.openFile(path), { code: "not_found" });
  }
  await files.saveUpload(`$(touch ${marker}).txt`, Readable.from([Buffer.from("x")]), { bytes: 1 });
  await assert.rejects(files.removeUpload("`touch pwned`"), { message: "File not found" });
  await assert.rejects(files.removeUpload("$(touch pwned)"), { message: "File not found" });
  await assert.rejects(files.removeUpload("../escape"), { message: "Invalid file name" });
  assert.equal(existsSync(marker), false);
  for (const command of commands) {
    // sh -c '<fixed script>' herdrabbit '<arg>' ...: everything a request chose comes after the name.
    const script = command.slice(0, command.indexOf(" herdrabbit"));
    assert.match(script, /^sh -c '/u);
    for (const value of [...hostile, "touch"]) assert.equal(script.includes(value), false, `${value} is not in ${script}`);
  }
  // A newline or NUL never leaves at all.
  const before = commands.length;
  await assert.rejects(files.listDirectory("/tmp/a\nb"), { code: "invalid_path" });
  await assert.rejects(files.openFile("/tmp/a\u0000b"), { code: "invalid_path" });
  assert.equal(commands.length, before);
  assert.throws(() => remoteCommand("true", ["a\nb"]), { code: "invalid_path" });
  assert.equal(remoteCommand("echo \"$1\"", ["it's"]), `sh -c 'echo "$1"' herdrabbit 'it'\\''s'`);
});

test("a machine without the GNU tools says so instead of answering with garbage", async () => {
  const { home } = await setup();
  const ssh = fakeSsh(home);
  // A find without -printf, as BusyBox and BSD have, defined inside the script itself.
  const shell = new MachineFiles({
    link: fakeLink,
    spawnProcess: (binary, args, options) => ssh.spawnProcess(binary,
      [...args.slice(0, -1), args.at(-1).replace(/^sh -c '/u, "sh -c 'find() { return 1; }; ")], options),
  });
  await assert.rejects(shell.listDirectory(home), { status: 501, code: "machine_tools_missing", message: /GNU find/u });
});

test("a machine that is off or not connected refuses file calls the way it refuses every call", async () => {
  const files = new MachineFiles({ link: () => { throw machineOffline("Turned off"); }, spawnProcess: () => assert.fail("nothing runs") });
  await assert.rejects(files.listDirectory("/tmp"), { status: 503, code: "machine_offline", message: "Turned off" });
  await assert.rejects(files.listUploads(), { status: 503, code: "machine_offline" });

  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}),
    createLink: (machine) => ({ machine, state: "connecting", error: null, start() {}, async stop() {} }),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: false }],
  });
  await machines.refresh();
  const herdr = new MultiServerClient({ local: {}, machines });
  const client = herdr.fileClient(SERVER);
  assert.ok(client, "a machine has a file client, on or off");
  await assert.rejects(client.listDirectory("/tmp"), { status: 503, code: "machine_offline", message: "Turned off" });
  assert.equal(herdr.fileClient("machine-000000000000"), null);
  assert.equal(herdr.fileClient("local"), null);
});

test("a slow machine's calls wait for its own slots, never another machine's", async () => {
  const pending = [];
  const stuck = new MachineFiles({
    link: fakeLink,
    spawnProcess: () => {
      const child = spawn("sleep", ["5"], { stdio: ["ignore", "pipe", "pipe"] });
      pending.push(child);
      return child;
    },
    timeoutMs: 1_000,
  });
  const { home, files } = await setup();
  const slow = [1, 2, 3, 4].map(() => stuck.listDirectory("/tmp").catch((error) => error));
  assert.equal((await files.listDirectory(home)).path, home, "another machine answers meanwhile");
  const errors = await Promise.all(slow);
  assert.ok(errors.every((error) => error.code === "machine_timeout"));
  assert.equal(pending.length, 4, "the fourth waited for a slot rather than run alongside");
});

async function machineServer(home) {
  const ssh = fakeSsh(home);
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}),
    createLink: (machine) => ({ machine, ...fakeLink(), error: null, start() {}, async stop() {} }),
    createFiles: (options) => new MachineFiles({ ...options, spawnProcess: ssh.spawnProcess }),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
  });
  await machines.refresh();
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, machines });
  const files = { directory: "/nowhere", list: async () => assert.fail("not this machine's uploads") };
  const created = createHerdrHttpServer({ herdr, files, csrfToken: "fixed-test-token", logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return { ...created, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

test("the browse and uploads routes reach a machine with ?server=", async (context) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-machine-api-")));
  await writeFile(join(home, "clip.mp4"), "0123456789");
  const app = await machineServer(home);
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const headers = { Origin: app.baseUrl };
  const write = { ...headers, "X-Herdr-CSRF": "fixed-test-token" };

  const listing = await (await fetch(`${app.baseUrl}/api/browse?server=${SERVER}`, { headers })).json();
  assert.equal(listing.path, home);
  assert.equal(listing.server, SERVER);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["clip.mp4"]);

  const check = await (await fetch(`${app.baseUrl}/api/browse/check?server=${SERVER}&targets=${encodeURIComponent(JSON.stringify({ [home]: listing.etag, "/gone": "x" }))}`, { headers })).json();
  assert.deepEqual(check.changed, ["/gone"]);

  const ticket = await (await fetch(`${app.baseUrl}/api/browse/tickets`, {
    method: "POST", headers: { ...write, "Content-Type": "application/json" },
    body: JSON.stringify({ server: SERVER, path: join(home, "clip.mp4"), view: true }),
  })).json();
  const slice = await fetch(`${app.baseUrl}/api/browse/download/${ticket.ticket}`, { headers: { Range: "bytes=3-5" } });
  assert.equal(slice.status, 206);
  assert.equal(slice.headers.get("content-range"), "bytes 3-5/10");
  assert.equal(await slice.text(), "345");

  const upload = await fetch(`${app.baseUrl}/api/files/up%20load.txt?server=${SERVER}`, {
    method: "POST", headers: { ...write, "Content-Type": "application/octet-stream" }, body: "uploaded",
  });
  assert.equal(upload.status, 201);
  const { file } = await upload.json();
  assert.deepEqual([file.name, file.path], ["up_load.txt", join(home, UPLOADS, "up_load.txt")]);
  const uploads = await (await fetch(`${app.baseUrl}/api/files?server=${SERVER}`)).json();
  assert.deepEqual([uploads.directory, uploads.files.map((entry) => entry.name), uploads.server], [join(home, UPLOADS), ["up_load.txt"], SERVER]);
  const download = await fetch(`${app.baseUrl}/api/files/up_load.txt?server=${SERVER}`);
  assert.equal(download.headers.get("content-length"), "8");
  assert.equal(await download.text(), "uploaded");
  const removed = await fetch(`${app.baseUrl}/api/files/up_load.txt?server=${SERVER}`, { method: "DELETE", headers: write });
  assert.equal(removed.status, 204);
  assert.deepEqual(await readdir(join(home, UPLOADS)), []);
  const missing = await fetch(`${app.baseUrl}/api/browse?server=${SERVER}&path=${encodeURIComponent(join(home, "nope"))}`, { headers });
  assert.deepEqual([missing.status, (await missing.json()).error.code], [404, "not_found"]);
});

test("a download ticket for a server that went away does not open the same path here", async (context) => {
  const GONE = "machine-0123456789ab";
  let servers = [{ id: GONE, name: "old", transport: "machine", address: "me@old" }];
  const herdr = new MultiServerClient({
    local: {},
    machines: { profiles: () => servers, client: () => ({ files: () => ({ openFile: async () => assert.fail("not reached") }), close() {} }) },
  });
  const created = createHerdrHttpServer({ herdr, csrfToken: "fixed-test-token", logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  const ticket = await (await fetch(`${baseUrl}/api/browse/tickets`, {
    method: "POST", headers: { Origin: baseUrl, "X-Herdr-CSRF": "fixed-test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ server: GONE, path: "/etc/hostname" }),
  })).json();
  servers = [];
  const response = await fetch(`${baseUrl}/api/browse/download/${ticket.ticket}`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "unknown_server");
});

test("a value with a backslash never reaches a remote shell", () => {
  assert.throws(() => remoteCommand("true", ["/a\\"]), { status: 400, code: "invalid_path" });
  assert.throws(() => remoteCommand("true", ["/a\\b", "/ ;id #"]), { status: 400 });
  assert.match(remoteCommand("true", ["/a b"]), /'\/a b'$/u);
});

test("a file read that stops sending is ended, and gives its slot back", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-machine-home-")));
  await writeFile(join(home, "slow.txt"), "data");
  const ssh = fakeSsh(home);
  const killed = [];
  // The size is asked as usual; the read itself hangs there.
  const spawnProcess = (binary, args, options) => {
    if (!args.at(-1).includes("tail -c")) return ssh.spawnProcess(binary, args, options);
    const child = spawn("sleep", ["30"], options);
    const kill = child.kill.bind(child);
    child.kill = (signal) => { killed.push(signal); return kill(signal); };
    return child;
  };
  const files = new MachineFiles({ link: () => fakeLink(), spawnProcess, readIdleMs: 100 });
  const opened = await files.openFile(join(home, "slow.txt"));
  await assert.rejects(text(opened.stream));
  assert.deepEqual(killed, ["SIGKILL"]);
});

test("a read that brings fewer bytes than it promised fails instead of ending short", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-machine-home-")));
  const path = join(home, "shrinks.txt");
  await writeFile(path, "0123456789");
  const ssh = fakeSsh(home);
  // The file is cut short between taking its size and reading it; the shell
  // still exits 0, as only head's status counts.
  const spawnProcess = (binary, args, options) => {
    if (args.at(-1).includes("tail -c")) writeFileSync(path, "0123");
    return ssh.spawnProcess(binary, args, options);
  };
  const files = new MachineFiles({ link: () => fakeLink(), spawnProcess });
  const opened = await files.openFile(path);
  assert.equal(opened.size, 10);
  await assert.rejects(text(opened.stream));
});

test("downloads and uploads have no size limit unless one is given", async () => {
  const { home, files } = await setup();
  assert.equal(files.maxBytes, Infinity);
  await writeFile(join(home, "clip.bin"), "0123456789");
  const whole = await files.openFile(join(home, "clip.bin"), { maxBytes: Infinity });
  assert.equal(await text(whole.stream), "0123456789");
  const saved = await files.saveUpload("many.bin", Readable.from([Buffer.alloc(1024 * 1024, 1)]), { bytes: 1024 * 1024 });
  assert.equal(saved.size, 1024 * 1024);
  const limited = (await setup({ maxBytes: 8 })).files;
  await assert.rejects(limited.saveUpload("big.bin", Readable.from([Buffer.from("x".repeat(9))]), { bytes: 9 }), { message: /upload limit/u });
});

test("a file of unknown size is read to its end, bounded by the cap rather than by Infinity", async () => {
  const { files } = await setup();
  const unlimited = await files.openFile("/proc/self/status");
  assert.equal(unlimited.size, null);
  assert.equal(unlimited.length, null);
  assert.ok((await text(unlimited.stream)).length > 0);
  const limited = await files.openFile("/proc/self/status", { maxBytes: 5 });
  assert.equal((await text(limited.stream)).length, 5);
});

test("a download whose browser stops reading is ended; one that reads slowly keeps going", async (context) => {
  // the stream's own timers do not hold the process open: this test does
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const { home, files } = await setup({ readIdleMs: 40, stalledClientMs: 400 });
  await writeFile(join(home, "big.bin"), Buffer.alloc(256 * 1024, 3));
  const stalled = await files.openFile(join(home, "big.bin"));
  stalled.stream.on("error", () => {});
  await new Promise((resolve) => stalled.stream.once("close", resolve));
  assert.ok(stalled.stream.destroyed);

  const slow = await files.openFile(join(home, "big.bin"));
  let total = 0;
  for await (const chunk of slow.stream) {
    total += chunk.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(total, 256 * 1024);
});

test("a machine's keys and sign-ins are listed locked and never opened, through a link or not", async () => {
  const { home, files } = await setup();
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "secret");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "secret");
  await writeFile(join(home, ".claude.json"), "secret");
  await mkdir(join(home, "notes"), { recursive: true });
  await writeFile(join(home, "notes", "plain.txt"), "ordinary");
  await symlink(join(home, ".ssh", "id_ed25519"), join(home, "notes", "innocent.txt"));
  await symlink(join(home, ".ssh"), join(home, "notes", "keys"));
  const refused = { status: 403, code: "protected_path" };

  const listing = await files.listDirectory(home);
  const ssh = listing.entries.find((entry) => entry.name === ".ssh");
  assert.deepEqual(ssh, { name: ".ssh", path: join(home, ".ssh"), hidden: true, readable: false, kind: "directory", locked: true });
  assert.equal(listing.entries.find((entry) => entry.name === ".claude.json").locked, true);
  assert.equal(listing.entries.find((entry) => entry.name === "notes").locked, undefined);
  // a link to a key is listed locked too, with nothing of the key's size or time
  const notes = await files.listDirectory(join(home, "notes"));
  for (const name of ["innocent.txt", "keys"]) {
    const entry = notes.entries.find((item) => item.name === name);
    assert.equal(entry.locked, true, name);
    assert.equal(entry.size, undefined, name);
    assert.equal(entry.modifiedAt, undefined, name);
  }
  assert.equal(notes.entries.find((item) => item.name === "plain.txt").locked, undefined);
  await assert.rejects(() => files.listDirectory(join(home, ".ssh")), refused);
  await assert.rejects(() => files.listDirectory(join(home, "notes", "keys")), refused);
  await assert.rejects(() => files.openFile(join(home, ".codex", "auth.json")), refused);
  await assert.rejects(() => files.openFile(join(home, "notes", "innocent.txt")), refused);
  await assert.rejects(() => files.openFile(join(home, "notes", "keys", "id_ed25519")), refused);
  assert.equal((await files.directoryFingerprints([join(home, ".ssh")])).get(join(home, ".ssh")), null);
  // A link to a protected folder is no way round for the fingerprint either.
  const linked = (await files.directoryFingerprints([join(home, "notes", "keys"), join(home, "notes")]));
  assert.equal(linked.get(join(home, "notes", "keys")), null);
  assert.notEqual(linked.get(join(home, "notes")), null);
  // Other tools' credentials are protected the same way.
  await mkdir(join(home, ".aws"), { recursive: true });
  await writeFile(join(home, ".aws", "credentials"), "secret");
  await writeFile(join(home, ".netrc"), "secret");
  await assert.rejects(() => files.openFile(join(home, ".netrc")), refused);
  await assert.rejects(() => files.listDirectory(join(home, ".aws")), refused);
  assert.equal(await text((await files.openFile(join(home, "notes", "plain.txt"))).stream), "ordinary");
});
