import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agyAdapter, claudeAdapter, createAgyAdapter, secretServiceFound, sessionBusAddress } from "../src/ai-account-adapters.mjs";
import { SECRET, machine, stagedLocation, stagingDirectoryOf, writeAgy, writeClaude, writeCodex } from "./fixtures/ai-accounts.mjs";

async function filesUnder(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function signInElsewhere(accounts, cli, write) {
  const login = await accounts.startLogin(cli);
  const directory = stagingDirectoryOf(login.command);
  await write(stagedLocation(cli, directory));
  return { login, directory, finished: await accounts.finishLogin(cli, login.loginId) };
}

test("lists who is signed in without saving anything", async (t) => {
  const { accounts, directory } = await machine(t);
  const { clis } = await accounts.list();
  const claude = clis.find((cli) => cli.id === "claude");
  assert.equal(claude.supported, true);
  assert.equal(claude.current.email, "a@example.com");
  assert.equal(claude.current.plan, "max");
  assert.equal(claude.current.id, null);
  assert.deepEqual(claude.accounts, []);
  assert.equal(clis.find((cli) => cli.id === "codex").current.plan, "plus");
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("saves the live account in private files", async (t) => {
  const { accounts, directory, claude } = await machine(t);
  const saved = await accounts.saveCurrent("claude");
  assert.match(saved.account.id, /^acct_/u);
  const slot = join(directory, "claude", saved.account.id);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(slot)).mode & 0o777, 0o700);
  for (const file of await filesUnder(slot)) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(slot, "credentials.json"), "utf8"), await readFile(claude.credentials, "utf8"));

  const again = await accounts.saveCurrent("claude");
  assert.equal(again.account.id, saved.account.id, "the same account reuses its slot");
  const { clis } = await accounts.list();
  assert.equal(clis[0].current.id, saved.account.id);
});

test("a new account signs in apart from the live one", async (t) => {
  const { accounts, claude } = await machine(t);
  const before = await readFile(claude.credentials, "utf8");
  const { login, directory, finished } = await signInElsewhere(accounts, "claude", (location) =>
    writeClaude(location, { uuid: "uuid-b", email: "b@example.com", token: "b1" }));
  assert.match(login.command, /^env CLAUDE_CONFIG_DIR='.+' claude auth login$/u);
  assert.equal(finished.account.email, "b@example.com");
  assert.equal(finished.account.active, false);
  await assert.rejects(stat(directory), { code: "ENOENT" }, "the sign-in directory is removed");
  assert.equal(await readFile(claude.credentials, "utf8"), before, "the live sign-in is untouched");
});

test("finishing before signing in, and cancelling", async (t) => {
  const { accounts } = await machine(t);
  const login = await accounts.startLogin("codex");
  assert.match(login.command, /^env CODEX_HOME='.+' codex login --device-auth$/u);
  await assert.rejects(accounts.finishLogin("codex", login.loginId), { code: "login_incomplete" });
  await accounts.cancelLogin("codex", login.loginId);
  await assert.rejects(accounts.finishLogin("codex", login.loginId), { code: "login_not_found", status: 404 });
});

test("open sign-ins are listed by id until they finish or are cancelled", async (t) => {
  const { accounts } = await machine(t);
  const claudeLogin = await accounts.startLogin("claude");
  const codexLogin = await accounts.startLogin("codex");
  let { clis } = await accounts.list();
  assert.deepEqual(clis.find((cli) => cli.id === "claude").logins, [claudeLogin.loginId]);
  assert.deepEqual(clis.find((cli) => cli.id === "codex").logins, [codexLogin.loginId]);

  await writeClaude(stagedLocation("claude", stagingDirectoryOf(claudeLogin.command)), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  await accounts.finishLogin("claude", claudeLogin.loginId);
  await accounts.cancelLogin("codex", codexLogin.loginId);
  ({ clis } = await accounts.list());
  assert.deepEqual(clis.map((cli) => cli.logins), clis.map(() => []));
});

test("switching installs the account and keeps rotated tokens of the one it replaces", async (t) => {
  const { accounts, claude, home, directory } = await machine(t);
  const { finished } = await signInElsewhere(accounts, "claude", (location) =>
    writeClaude(location, { uuid: "uuid-b", email: "b@example.com", token: "b1" }));

  const switched = await accounts.switch("claude", finished.account.id);
  assert.equal(switched.changed, true);
  const global = JSON.parse(await readFile(claude.global, "utf8"));
  assert.equal(global.oauthAccount.emailAddress, "b@example.com");
  assert.deepEqual(global.mcpServers, { keep: { command: "x" } }, "other settings survive");
  assert.match(await readFile(claude.credentials, "utf8"), /refresh-b1/u);
  assert.equal((await stat(claude.credentials)).mode & 0o777, 0o600);

  // Claude refreshes while account B is live, rotating its tokens.
  await writeClaude(claude, { uuid: "uuid-b", email: "b@example.com", token: "b2" });
  const { clis } = await accounts.list();
  const accountA = clis[0].accounts.find((item) => item.email === "a@example.com");
  assert.ok(accountA, "the replaced account was saved on the way out");
  await accounts.switch("claude", accountA.id);
  assert.match(await readFile(claude.credentials, "utf8"), /refresh-a1/u);
  assert.match(await readFile(join(directory, "claude", finished.account.id, "credentials.json"), "utf8"), /refresh-b2/u);

  const leftovers = [...await filesUnder(home)].filter((file) => file.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("warns about running agents and proceeds once confirmed", async (t) => {
  const running = [{ paneId: "w1:p1", agent: "codex", label: "api" }, { paneId: "w1:p2", agent: "claude", label: null }];
  const { accounts, codex } = await machine(t, { running });
  const { finished } = await signInElsewhere(accounts, "codex", (location) =>
    writeCodex(location, { accountId: "codex-b", email: "b@example.com", token: "b1" }));
  await assert.rejects(accounts.switch("codex", finished.account.id), (error) => {
    assert.equal(error.code, "agents_running");
    assert.deepEqual(error.details.panes, [{ paneId: "w1:p1", label: "api" }]);
    return true;
  });
  await accounts.switch("codex", finished.account.id, { confirmRunning: true });
  assert.match(await readFile(codex.auth, "utf8"), /refresh-b1/u);
});

test("a switch that does not take is rolled back", async (t) => {
  const broken = { ...claudeAdapter, install: async () => {} };
  const { accounts, claude } = await machine(t, { adapters: [broken] });
  const { finished } = await signInElsewhere(accounts, "claude", (location) =>
    writeClaude(location, { uuid: "uuid-b", email: "b@example.com", token: "b1" }));
  const before = await readFile(claude.credentials, "utf8");
  await assert.rejects(accounts.switch("claude", finished.account.id), { code: "switch_failed", status: 500 });
  assert.equal(await readFile(claude.credentials, "utf8"), before);
});

test("the active account cannot be removed", async (t) => {
  const { accounts } = await machine(t);
  const saved = await accounts.saveCurrent("codex");
  await assert.rejects(accounts.remove("codex", saved.account.id), { code: "account_active" });
  const { finished } = await signInElsewhere(accounts, "codex", (location) =>
    writeCodex(location, { accountId: "codex-b", email: "b@example.com", token: "b1" }));
  await accounts.remove("codex", finished.account.id);
  const { clis } = await accounts.list();
  assert.deepEqual(clis.find((cli) => cli.id === "codex").accounts.map((item) => item.email), ["a@example.com"]);
});

test("ids from the outside cannot point at another path", async (t) => {
  const { accounts } = await machine(t);
  await assert.rejects(accounts.switch("claude", "../../etc"), { name: "InputValidationError" });
  await assert.rejects(accounts.remove("claude", "acct_../x"), { name: "InputValidationError" });
  await assert.rejects(accounts.finishLogin("claude", "../staging"), { name: "InputValidationError" });
  await assert.rejects(accounts.cancelLogin("claude", "login_../../"), { name: "InputValidationError" });
  await assert.rejects(accounts.saveCurrent("gemini"), { name: "InputValidationError" });
  await assert.rejects(accounts.startLogin("__proto__"), { name: "InputValidationError" });
});

test("codex in keyring mode is reported and left alone", async (t) => {
  const { accounts, codex } = await machine(t);
  await writeFile(codex.config, 'model = "o3"\ncli_auth_credentials_store = "keyring"\n');
  const { clis } = await accounts.list();
  const entry = clis.find((cli) => cli.id === "codex");
  assert.equal(entry.supported, false);
  assert.match(entry.reason, /keyring/u);
  await assert.rejects(accounts.saveCurrent("codex"), { code: "unsupported" });
  await assert.rejects(accounts.startLogin("codex"), { code: "unsupported" });
});

test("Antigravity is listed by its email and switches", async (t) => {
  const { accounts, agy, directory } = await machine(t);
  let { clis } = await accounts.list();
  const entry = clis.find((cli) => cli.id === "agy");
  assert.equal(entry.label, "Antigravity CLI");
  assert.equal(entry.supported, true);
  assert.equal(entry.current.email, "a@example.com");

  // agy has no sign-in command: it signs in on first run. Its HOME is the
  // sign-in directory, and without a session bus it cannot reach the keyring,
  // which would put the new account where the live one is read from.
  const { login, finished } = await signInElsewhere(accounts, "agy", (location) =>
    writeAgy(location, { email: "b@example.com", token: "b1" }));
  assert.match(login.command, /^env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR HOME='.+' agy$/u);
  assert.equal(finished.account.email, "b@example.com");
  assert.equal(finished.account.active, false);

  await accounts.switch("agy", finished.account.id);
  assert.match(await readFile(agy.token, "utf8"), /refresh-b1/u);
  assert.equal((await stat(agy.token)).mode & 0o777, 0o600);

  // agy refreshes while B is live; going back to A keeps B's new tokens.
  await writeAgy(agy, { email: "b@example.com", token: "b2" });
  ({ clis } = await accounts.list());
  const accountA = clis.find((cli) => cli.id === "agy").accounts.find((item) => item.email === "a@example.com");
  assert.ok(accountA, "the replaced account was saved on the way out");
  await accounts.switch("agy", accountA.id);
  assert.match(await readFile(agy.token, "utf8"), /refresh-a1/u);
  assert.match(await readFile(join(directory, "agy", finished.account.id, "antigravity-oauth-token"), "utf8"), /refresh-b2/u);
});

test("an Antigravity file names its account by email, else by its ID token", async (t) => {
  const { home } = await machine(t);
  const location = agyAdapter.locate({ HOME: join(home, "other") });
  assert.equal(await agyAdapter.identify(location), null, "no file, no account");
  await writeAgy(location, { token: "c1", idToken: { sub: "google-c", email: "C@Example.com" } });
  assert.deepEqual(await agyAdapter.identify(location),
    { accountId: "c@example.com", email: "C@Example.com", organization: null, plan: null, refreshExpiresAt: null });
  await writeFile(location.token, JSON.stringify({ token: { access_token: "x" }, id_token_email: "c@example.com" }));
  assert.equal(await agyAdapter.identify(location), null, "a file without a refresh token is no sign-in");
});

test("Antigravity in keyring mode is reported and left alone", async (t) => {
  const keyring = createAgyAdapter({ keyringHoldsToken: async () => true });
  const { accounts, agy } = await machine(t, { adapters: [keyring] });
  const before = await readFile(agy.token, "utf8");
  const { clis } = await accounts.list();
  assert.equal(clis[0].supported, false);
  assert.match(clis[0].reason, /keyring/u);
  await assert.rejects(accounts.saveCurrent("agy"), { code: "unsupported" });
  await assert.rejects(accounts.startLogin("agy"), { code: "unsupported" });
  assert.equal(await readFile(agy.token, "utf8"), before);
});

test("the keyring is looked for on the session bus agy itself would use", () => {
  assert.equal(sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/7/bus,guid=x" }), "unix:path=/run/user/7/bus,guid=x");
  assert.equal(sessionBusAddress({ XDG_RUNTIME_DIR: "/run/user/7" }), "unix:path=/run/user/7/bus");
  assert.equal(sessionBusAddress({ HOME: "/home/x" }), null, "no bus: agy writes the file");
  assert.equal(secretServiceFound("(@ao [], @ao [])"), false);
  assert.equal(secretServiceFound("([objectpath '/org/freedesktop/secrets/collection/login/3'], @ao [])"), true);
  assert.equal(secretServiceFound("(@ao [], [objectpath '/org/freedesktop/secrets/collection/login/3'])"), true, "a locked item counts");
});

test("a running agy holds a switch until confirmed", async (t) => {
  const { accounts, agy } = await machine(t, { running: [{ paneId: "w1:p3", agent: "agy", label: "docs" }] });
  const { finished } = await signInElsewhere(accounts, "agy", (location) =>
    writeAgy(location, { email: "b@example.com", token: "b1" }));
  await assert.rejects(accounts.switch("agy", finished.account.id), { code: "agents_running" });
  await accounts.switch("agy", finished.account.id, { confirmRunning: true });
  assert.match(await readFile(agy.token, "utf8"), /refresh-b1/u);
});

test("abandoned sign-in directories are cleaned up", async (t) => {
  let clock = Date.now();
  const { accounts } = await machine(t, { now: () => clock });
  const login = await accounts.startLogin("claude");
  const directory = stagingDirectoryOf(login.command);
  await utimes(directory, new Date(clock - 1000), new Date(clock - 1000));
  await accounts.list();
  assert.ok(await stat(directory));
  clock += 2 * 60 * 60 * 1000;
  await accounts.list();
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("no credential appears in anything returned or thrown", async (t) => {
  const { accounts } = await machine(t, { running: [{ paneId: "w1:p1", agent: "claude" }] });
  const outputs = [];
  const capture = async (promise) => {
    try { outputs.push(await promise); } catch (error) { outputs.push({ message: error.message, code: error.code, details: error.details }); }
  };
  await capture(accounts.list());
  await capture(accounts.saveCurrent("claude"));
  await capture(accounts.saveCurrent("codex"));
  await capture(accounts.saveCurrent("agy"));
  const { finished } = await signInElsewhere(accounts, "claude", (location) =>
    writeClaude(location, { uuid: "uuid-b", email: "b@example.com", token: "b1" }));
  outputs.push(finished);
  await capture(accounts.switch("claude", finished.account.id));
  await capture(accounts.switch("claude", finished.account.id, { confirmRunning: true }));
  await capture(accounts.remove("claude", finished.account.id));
  await capture(accounts.list());
  const serialized = JSON.stringify(outputs);
  assert.ok(serialized.length > 100);
  assert.ok(!serialized.includes(SECRET), serialized);
  assert.ok(!serialized.includes("accountUuid") && !serialized.includes("uuid-"), "account identifiers stay internal");
});
