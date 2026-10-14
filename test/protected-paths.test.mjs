import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { directoryFingerprint, listDirectory, openFile, refuseProtected } from "../src/file-browser.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { LeafLinkClient } from "../src/leaf-link-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { defaultDataPaths, isProtectedPath, localProtectedPaths } from "../src/protected-paths.mjs";

// A home made up for the test: nothing here reads the real one.
async function fakeHome(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-protected-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const put = async (path, text = "secret") => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const paths = {
    sshKey: join(home, ".ssh", "id_ed25519"),
    gpg: join(home, ".gnupg", "private-keys-v1.d", "key"),
    claudeCredentials: join(home, ".claude", ".credentials.json"),
    claudeGlobal: join(home, ".claude.json"),
    claudeBackup: join(home, ".claude.json.backup"),
    codexAuth: join(home, ".codex", "auth.json"),
    claudeConfig: join(home, ".config", "claude-desktop", "config.json"),
    herdrBridge: join(home, ".config", "herdr-bridge", "auth.json"),
    // Moved by the environment, away from the default folder.
    movedAuth: join(root, "settings", "auth.json"),
    movedServers: join(root, "settings", "servers.json"),
    savedSignIn: join(root, "ai-accounts", "claude", "acct", "credentials.json"),
  };
  const allowed = {
    notes: join(home, "notes", "plain.txt"),
    transcript: join(home, ".claude", "projects", "p", "session.jsonl"),
    codexConfig: join(home, ".codex", "config.toml"),
    otherConfig: join(home, ".config", "other", "ok.txt"),
  };
  for (const path of [...Object.values(paths), ...Object.values(allowed)]) await put(path, path.endsWith(".txt") ? "ordinary" : "secret");
  const data = {
    ...defaultDataPaths(home),
    authFile: paths.movedAuth,
    serversFile: paths.movedServers,
    aiAccountsDir: join(root, "ai-accounts"),
  };
  const guard = localProtectedPaths({ env: { HOME: home }, home, data });
  return { root, home, paths, allowed, guard, data };
}

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const refused = { status: 403, code: "protected_path" };

test("sign-in keys and HerdRabbit's own settings are never opened, listed into or downloaded", async (context) => {
  const { paths, guard } = await fakeHome(context);
  for (const [what, path] of Object.entries(paths)) {
    await assert.rejects(() => openFile(path, { guard }), refused, what);
    await assert.rejects(() => listDirectory(dirname(path), { guard }).then((listing) => {
      // A folder that only holds a protected file may be listed; the file in
      // it is locked. A protected folder is not listed at all.
      const entry = listing.entries.find((item) => item.path === path);
      if (entry?.locked) throw Object.assign(new Error("locked"), refused);
      throw new Error(`${what} was listed as an ordinary entry`);
    }), refused, what);
    await assert.rejects(() => refuseProtected(path, guard), refused, what);
  }
  for (const folder of [dirname(paths.sshKey), dirname(dirname(paths.gpg)), dirname(paths.herdrBridge), dirname(paths.movedAuth), dirname(paths.savedSignIn)]) {
    await assert.rejects(() => listDirectory(folder, { guard }), refused, folder);
    await assert.rejects(() => directoryFingerprint(folder, { guard }), refused, folder);
  }
});

test("ordinary files beside them, and the folders that hold them, still open", async (context) => {
  const { home, allowed, guard } = await fakeHome(context);
  for (const [what, path] of Object.entries(allowed)) {
    const opened = await openFile(path, { guard });
    assert.ok((await read(opened.stream)).length > 0, what);
  }
  const listing = await listDirectory(home, { guard });
  const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
  // Named, with its kind, and nothing else said about it.
  assert.deepEqual(byName.get(".ssh"), {
    name: ".ssh", path: join(home, ".ssh"), hidden: true, readable: false, kind: "directory", locked: true,
  });
  assert.equal(byName.get(".claude.json").locked, true);
  assert.equal(byName.get(".claude.json.backup").locked, true);
  assert.equal(byName.get(".claude").locked, undefined, "the folder holding a transcript is not itself locked");
  assert.equal(byName.get("notes").locked, undefined);
  const claude = await listDirectory(join(home, ".claude"), { guard });
  assert.equal(claude.entries.find((entry) => entry.name === ".credentials.json").locked, true);
  assert.equal(claude.entries.find((entry) => entry.name === "projects").locked, undefined);
});

test("a symbolic link to a key is the key", async (context) => {
  const { home, paths, guard } = await fakeHome(context);
  await symlink(paths.sshKey, join(home, "notes", "innocent.txt"));
  await symlink(join(home, ".ssh"), join(home, "notes", "keys"));
  await symlink(paths.codexAuth, join(home, "notes", "relative-looking"));
  await assert.rejects(() => openFile(join(home, "notes", "innocent.txt"), { guard }), refused);
  await assert.rejects(() => openFile(join(home, "notes", "keys", "id_ed25519"), { guard }), refused);
  await assert.rejects(() => openFile(join(home, "notes", "relative-looking"), { guard }), refused);
  await assert.rejects(() => listDirectory(join(home, "notes", "keys"), { guard }), refused);
  const listing = await listDirectory(join(home, "notes"), { guard });
  const locked = listing.entries.filter((entry) => entry.locked).map((entry) => entry.name).sort();
  assert.deepEqual(locked, ["innocent.txt", "keys", "relative-looking"]);
  assert.equal(listing.entries.find((entry) => entry.name === "plain.txt").locked, undefined);
});

test("a key folder that is itself a link is matched where it really is", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-protected-dotfiles-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(root, "dotfiles", "ssh"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, "dotfiles", "ssh", "id_rsa"), "secret");
  await symlink(join(root, "dotfiles", "ssh"), join(home, ".ssh"));
  const guard = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });
  await assert.rejects(() => openFile(join(root, "dotfiles", "ssh", "id_rsa"), { guard }), refused);
  await assert.rejects(() => listDirectory(join(root, "dotfiles", "ssh"), { guard }), refused);
});

test("the AI CLIs' sign-ins are found where their environment puts them", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-protected-env-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(root, "claude-config"), { recursive: true });
  await mkdir(join(root, "codex-home"), { recursive: true });
  await writeFile(join(root, "claude-config", ".credentials.json"), "secret");
  await writeFile(join(root, "codex-home", "auth.json"), "secret");
  const guard = localProtectedPaths({
    env: { HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude-config"), CODEX_HOME: join(root, "codex-home") },
    home,
    data: defaultDataPaths(home),
  });
  await assert.rejects(() => openFile(join(root, "claude-config", ".credentials.json"), { guard }), refused);
  await assert.rejects(() => openFile(join(root, "codex-home", "auth.json"), { guard }), refused);
});

test("a settings file moved into a shared folder is protected alone, not the folder", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-protected-shared-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), "secret");
  await writeFile(join(home, "readme.txt"), "ordinary");
  const guard = localProtectedPaths({ env: { HOME: home }, home, data: { ...defaultDataPaths(home), authFile: join(home, "auth.json") } });
  await assert.rejects(() => openFile(join(home, "auth.json"), { guard }), refused);
  assert.equal(await read((await openFile(join(home, "readme.txt"), { guard })).stream), "ordinary");
  await listDirectory(home, { guard });
});

test("an uploads folder inside a protected one is caught before anything is written", async (context) => {
  const { home, root, guard } = await fakeHome(context);
  assert.equal(await isProtectedPath(guard, join(home, ".ssh", "uploads")), true);
  assert.equal(await isProtectedPath(guard, join(home, ".config", "herdr-bridge", "files")), true);
  assert.equal(await isProtectedPath(guard, join(root, "ai-accounts", "files")), true);
  assert.equal(await isProtectedPath(guard, join(home, ".local", "share", "herdrabbit", "files")), false);
});

test("the page's file browser refuses them, and says why, before handing out a link", async (context) => {
  const { home, paths, guard } = await fakeHome(context);
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } }, csrfToken: "fixed-test-token", logger: { error() {} }, protectedPaths: guard,
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => { created.server.closeAllConnections(); created.server.close(resolve); }));
  const base = `http://127.0.0.1:${created.server.address().port}`;
  const browse = (path) => fetch(`${base}/api/browse?path=${encodeURIComponent(path)}`, { headers: { Origin: base } });
  const ticket = (path, view = false) => fetch(`${base}/api/browse/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: base },
    body: JSON.stringify({ path, view }),
  });

  const listing = await (await browse(home)).json();
  assert.equal(listing.entries.find((entry) => entry.name === ".ssh").locked, true);
  const inside = await browse(join(home, ".ssh"));
  assert.equal(inside.status, 403);
  assert.equal((await inside.json()).error.code, "protected_path");
  for (const view of [false, true]) {
    const refusedTicket = await ticket(paths.claudeCredentials, view);
    assert.equal(refusedTicket.status, 403);
    assert.equal((await refusedTicket.json()).error.code, "protected_path");
  }
  const check = await fetch(`${base}/api/browse/check?targets=${encodeURIComponent(JSON.stringify({ [join(home, ".ssh")]: "x" }))}`, { headers: { Origin: base } });
  assert.deepEqual((await check.json()).changed, [join(home, ".ssh")]);

  const ok = await ticket(join(home, "notes", "plain.txt"));
  assert.equal(ok.status, 201);
  const download = await fetch(`${base}/api/browse/download/${(await ok.json()).ticket}`);
  assert.equal(await download.text(), "ordinary");
});

test("another PC asking over Connect PC is refused them the same way, and held to this PC's transfer limit", async (context) => {
  const { home, paths, guard } = await fakeHome(context);
  await writeFile(join(home, "notes", "big.bin"), Buffer.alloc(64));
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: leafLinkRoutes({ client: {}, version: "1.2.46", protectedPaths: guard, maxTransferBytes: 32 }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const client = new LeafLinkClient({
    profile: { name: "desk", transport: "link", address: `http://127.0.0.1:${server.address().port}` },
    hubVersion: "1.2.46",
  });
  context.after(() => client.close());

  await assert.rejects(() => client.openFile(paths.sshKey), refused);
  await assert.rejects(() => client.listDirectory(join(home, ".ssh")), refused);
  await assert.rejects(() => client.directoryFingerprint(join(home, ".ssh")), refused);
  const listing = await client.listDirectory(home);
  assert.equal(listing.entries.find((entry) => entry.name === ".ssh").locked, true);
  await symlink(paths.codexAuth, join(home, "notes", "linked"));
  await assert.rejects(() => client.openFile(join(home, "notes", "linked")), refused);

  // The leaf's own limit, even when the hub would take more.
  await assert.rejects(() => client.openFile(join(home, "notes", "big.bin")), { status: 413, code: "file_too_large" });
  assert.equal(await read((await client.openFile(join(home, "notes", "plain.txt"))).stream), "ordinary");
});
