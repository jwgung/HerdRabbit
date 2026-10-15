import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBrowsePath, readFileServer, writeBrowsePath, writeFileServer } from "../public/browse-preference.js";
import { readCollapsedWorkspaceIds, writeCollapsedWorkspaceIds } from "../public/workspace-preference.js";
import { ServerProfiles, SERVER_ID_PATTERN, newServerId, validateServerProfile } from "../src/server-profiles.mjs";

const link = { name: "Dev box", address: "http://100.64.0.9:38787" };

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-servers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "profiles.json");
  return { file, profiles: await ServerProfiles.load(file) };
}

test("persists servers in a private file", async (t) => {
  const { file, profiles } = await store(t);
  await profiles.save(link);
  await profiles.save({ ...link, name: "Second", address: "http://100.64.0.10:38787" });
  const saved = profiles.list();
  assert.deepEqual(saved.map((item) => item.name), ["Dev box", "Second"]);
  assert.match(saved[0].id, /^link_/u);
  assert.equal(validateServerProfile(link).transport, "link");
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reloaded = await ServerProfiles.load(file);
  assert.deepEqual(reloaded.list().map((item) => item.name), ["Dev box", "Second"]);
});

test("a server profile stores an origin and no secret", async (t) => {
  const { file, profiles } = await store(t);
  await profiles.save({ ...link, address: "https://Dev.Example:38787/" });
  const [saved] = profiles.list();
  assert.equal(saved.address, "https://dev.example:38787");
  const onDisk = JSON.parse(await readFile(file, "utf8"))[0];
  assert.deepEqual(Object.keys(onDisk).sort(), ["address", "id", "name", "transport"]);
});

test("refuses addresses that would change what the client talks to", () => {
  for (const address of [
    "ftp://box:38787", "https://user:pw@box", "https://box/path",
    "https://box?a=1", "https://box#x", "not a url", "https://",
  ]) {
    assert.throws(() => validateServerProfile({ ...link, address }), { name: "InputValidationError" });
  }
});

test("a connected PC's id is remembered by the page like any other server's", () => {
  // public/ cannot import from src/, so the page holds its own copy of the id
  // shape; a copy that drifts silently drops a PC's remembered folder or
  // collapsed projects.
  const id = newServerId();
  assert.ok(SERVER_ID_PATTERN.test(id));
  assert.ok(!SERVER_ID_PATTERN.test("ssh_00000000-0000-0000-0000-000000000000"));
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  assert.equal(writeBrowsePath(storage, "/srv/app", id), true);
  assert.equal(readBrowsePath(storage, id), "/srv/app");
  writeFileServer(storage, id);
  assert.equal(readFileServer(storage), id);
  const workspace = `${id}!hs_ZGVmYXVsdA~w1`;
  assert.equal(writeCollapsedWorkspaceIds(storage, new Set([workspace])), true);
  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], [workspace]);
});
