import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPasswordConfiguration,
  loadPasswordAuth,
  passkeyHandle,
  PasswordAttempts,
  PasswordAttemptsByKey,
  PasswordAuth,
  SESSION_DURATION_SECONDS,
  writePasswordConfiguration,
} from "../src/password-auth.mjs";

test("stores only a password hash with private file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "nested", "auth.json");
  await writePasswordConfiguration(authFile, "correct horse battery staple");

  const source = await readFile(authFile, "utf8");
  const file = await stat(authFile);
  assert.doesNotMatch(source, /correct horse battery staple/);
  assert.equal(file.mode & 0o777, 0o600);

  const auth = await loadPasswordAuth(authFile);
  assert.equal(auth.required, true);
  assert.equal(await auth.verifyPassword("correct horse battery staple"), true);
  assert.equal(await auth.verifyPassword("wrong"), false);
});

test("an empty password removes authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "temporary");
  await writePasswordConfiguration(authFile, "");
  const auth = await loadPasswordAuth(authFile);
  assert.equal(auth.required, false);
  assert.equal(auth.hasValidSession(), true);
});

test("signed sessions expire and changing the configuration invalidates them", async () => {
  let now = 1_000_000;
  const first = new PasswordAuth(
    await createPasswordConfiguration("password"),
    { now: () => now },
  );
  const token = first.createSession();
  const launchToken = first.createLaunchToken();
  assert.equal(first.hasValidSession(`other=x; herdr_session=${token}`), true);
  assert.equal(first.hasValidLaunchToken(launchToken), true);
  assert.equal(first.hasValidSession(`herdr_session=${launchToken}`), false);
  assert.equal(first.hasValidLaunchToken(token), false);
  assert.equal(SESSION_DURATION_SECONDS, 7 * 24 * 60 * 60);

  now += 8 * 24 * 60 * 60 * 1_000;
  assert.equal(first.hasValidSession(`herdr_session=${token}`), false);
  assert.equal(first.hasValidLaunchToken(launchToken), false);

  const replacement = new PasswordAuth(
    await createPasswordConfiguration("password"),
    { now: () => 1_000_000 },
  );
  assert.equal(replacement.hasValidSession(`herdr_session=${token}`), false);
});

test("persists passkey public data and clears it when the password changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "first-password");

  const auth = await loadPasswordAuth(authFile);
  assert.equal(auth.hasPasskeys, false);
  await auth.addPasskey({
    id: "credential-id",
    publicKey: Uint8Array.from([1, 2, 3, 4]),
    counter: 3,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
  });

  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasPasskeys, true);
  assert.deepEqual(reloaded.passkeys, [{
    id: "credential-id",
    publicKey: Uint8Array.from([1, 2, 3, 4]),
    counter: 3,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
  }]);

  await reloaded.updatePasskeyCounter("credential-id", 4);
  const updated = await loadPasswordAuth(authFile);
  assert.equal(updated.passkeys[0].counter, 4);

  await writePasswordConfiguration(authFile, "second-password");
  const replaced = await loadPasswordAuth(authFile);
  assert.equal(replaced.hasPasskeys, false);
});

test("keeps passkey names and dates, removes by handle, and loads older entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  let now = 1_000;
  const configuration = await createPasswordConfiguration("secret");
  // Written before passkeys had names or dates.
  configuration.passkeys = [{
    id: "older",
    publicKey: "b2xkZXI",
    counter: 0,
    transports: [],
    deviceType: "singleDevice",
    backedUp: false,
  }];
  await writeFile(authFile, JSON.stringify(configuration));
  const auth = new PasswordAuth(configuration, { authFile, now: () => now });
  await auth.addPasskey({
    id: "newer",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ["hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    label: "Chrome · Android",
    createdAt: 900,
  });
  now = 2_000;
  await auth.updatePasskeyCounter("newer", 4);

  assert.deepEqual(auth.passkeySummaries(), [
    { handle: passkeyHandle("older"), label: null, createdAt: null, lastUsedAt: null, deviceType: "singleDevice", backedUp: false },
    { handle: passkeyHandle("newer"), label: "Chrome · Android", createdAt: 900, lastUsedAt: 2_000, deviceType: "multiDevice", backedUp: true },
  ]);
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.passkeySummaries()[1].lastUsedAt, 2_000);

  assert.equal(await auth.removePasskey("not-a-handle"), false);
  assert.equal(await auth.removePasskey(passkeyHandle("missing")), false);
  assert.equal(await auth.removePasskey(passkeyHandle("older")), true);
  assert.equal(await auth.removePasskey(passkeyHandle("older")), false);
  assert.deepEqual(auth.passkeys.map(({ id }) => id), ["newer"]);
  assert.deepEqual((await loadPasswordAuth(authFile)).passkeys.map(({ id }) => id), ["newer"]);
});

test("rejects passkey names that carry control characters", () => {
  const configuration = {
    version: 1,
    password: { algorithm: "scrypt", salt: "c2FsdA", hash: "aGFzaA" },
    sessionSecret: "c2VjcmV0",
    passkeys: [{
      id: "one",
      publicKey: "b25l",
      counter: 0,
      transports: [],
      deviceType: "singleDevice",
      backedUp: false,
      label: "bad\u0000name",
    }],
  };
  assert.throws(() => new PasswordAuth(configuration), /passkey configuration is invalid/);
});

test("removing a passkey signs out every session made before it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  const configuration = await createPasswordConfiguration("secret");
  configuration.passkeys = [{
    id: "lost-phone",
    publicKey: "a2V5",
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
  }];
  await writeFile(authFile, JSON.stringify(configuration));
  const auth = new PasswordAuth(configuration, { authFile });
  const before = auth.createSession();
  const beforeLaunch = auth.createLaunchToken();
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), true);

  assert.equal(await auth.removePasskey(passkeyHandle("lost-phone")), true);
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), false);
  assert.equal(auth.hasValidLaunchToken(beforeLaunch), false);
  const after = auth.createSession();
  assert.equal(auth.hasValidSession(`herdr_session=${after}`), true);
  // The ending survives a restart.
  await auth.writeQueue;
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasValidSession(`herdr_session=${before}`), false);
  assert.equal(reloaded.hasValidSession(`herdr_session=${after}`), true);
});

test("a few wrong passwords are free, then each locks for twice as long", () => {
  let clock = 0;
  const attempts = new PasswordAttempts({ now: () => clock, free: 2, maxLockMs: 4_000 });
  attempts.failed();
  attempts.failed();
  assert.equal(attempts.retryAfterMs(), 0);
  attempts.failed();
  assert.equal(attempts.retryAfterMs(), 1_000);
  attempts.failed();
  assert.equal(attempts.retryAfterMs(), 2_000);
  attempts.failed();
  attempts.failed();
  assert.equal(attempts.retryAfterMs(), 4_000);
  clock += 4_000;
  assert.equal(attempts.retryAfterMs(), 0);
  attempts.succeeded();
  attempts.failed();
  assert.equal(attempts.retryAfterMs(), 0);
});

test("lists sign-ins, ends one, and keeps that across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  let ended = 0;
  auth.onSessionsEnded(() => { ended += 1; });
  const phone = auth.createSession({ agent: "Chrome · Android" });
  const laptop = auth.createSession({ agent: "Firefox · Linux" });
  assert.equal(auth.hasValidSession(`herdr_session=${phone}`), true, "listed at once");
  assert.deepEqual(auth.sessionSummaries().map((item) => item.agent).sort(), ["Chrome · Android", "Firefox · Linux"]);
  const phoneId = auth.currentSessionId(`herdr_session=${phone}`);
  assert.equal(auth.sessionSummaries().some((item) => item.id === phoneId), true);

  assert.equal(await auth.endSession(phoneId), true);
  assert.equal(ended, 1);
  assert.equal(auth.hasValidSession(`herdr_session=${phone}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${laptop}`), true);
  assert.equal(await auth.endSession(phoneId), false, "an ended session is gone");
  await auth.writeQueue;
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasValidSession(`herdr_session=${phone}`), false);
  assert.equal(reloaded.hasValidSession(`herdr_session=${laptop}`), true);
  assert.doesNotMatch(await readFile(authFile, "utf8"), new RegExp(laptop.split(".")[0]), "the file keeps no token");
});

// A cookie as HerdRabbit signed it before sessions were listed.
function unlistedCookie(configuration, expiresAt) {
  const payload = `nonce-${Math.random().toString(16).slice(2)}.${expiresAt}`;
  return `${payload}.${createHmac("sha256", configuration.sessionSecret).update(`cookie.${payload}`).digest("base64url")}`;
}

test("a sign-in made before sessions were listed lasts until it expires; ending all ends it too", async () => {
  const now = 1_000_000_000;
  const configuration = await createPasswordConfiguration("secret");
  const before = unlistedCookie(configuration, now / 1000 + SESSION_DURATION_SECONDS);
  const auth = new PasswordAuth(configuration, { now: () => now });
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), true);
  const listed = auth.createSession();
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), true, "the upgrade signs no one out");
  await auth.endAllSessions();
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${listed}`), false);
  assert.deepEqual(auth.sessionSummaries(), []);
});

test("the signature, not the second it was made, tells an older sign-in from an ended one", async () => {
  const now = 1_000_000_000;
  const configuration = await createPasswordConfiguration("secret");
  const auth = new PasswordAuth(configuration, { now: () => now });
  const ended = auth.createSession();
  const before = unlistedCookie(configuration, now / 1000 + SESSION_DURATION_SECONDS);
  await auth.endSession(auth.currentSessionId(`herdr_session=${ended}`));
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), true, "made in the same second, still an older sign-in");
  assert.equal(auth.hasValidSession(`herdr_session=${ended}`), false);
});

test("signing out of an older sign-in ends it alone, across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const phone = unlistedCookie(auth.configuration, expiresAt);
  const laptop = unlistedCookie(auth.configuration, expiresAt);
  let ended = 0;
  auth.onSessionsEnded(() => { ended += 1; });
  assert.equal(await auth.endCurrentSession(`herdr_session=${phone}`), true);
  assert.equal(ended, 1, "open connections check again");
  assert.equal(auth.hasValidSession(`herdr_session=${phone}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${laptop}`), true);
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasValidSession(`herdr_session=${phone}`), false);
  assert.equal(reloaded.hasValidSession(`herdr_session=${laptop}`), true);
  assert.doesNotMatch(await readFile(authFile, "utf8"), new RegExp(phone.split(".")[0]), "the file keeps no token");
});

test("an unlisted token signed after sessions were listed is refused", async () => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const kept = auth.createSession();
  assert.equal(await auth.endCurrentSession(`herdr_session=${kept}`), true);
  assert.equal(auth.hasValidSession(`herdr_session=${kept}`), false);
});

test("a passkey change that could not be written is not kept in memory either", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  const passkey = { id: "credential-id", publicKey: Uint8Array.from([1, 2, 3]), counter: 0, transports: [], deviceType: "singleDevice", backedUp: false };
  auth.authFile = join(authFile, "not-a-directory", "auth.json");
  await assert.rejects(auth.addPasskey(passkey));
  assert.equal(auth.hasPasskeys, false);
  auth.authFile = authFile;
  await auth.addPasskey(passkey);
  assert.equal((await loadPasswordAuth(authFile)).hasPasskeys, true, "a retry is not mistaken for a duplicate");
});

test("a sign-in that happens while a passkey is being written is kept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  const adding = auth.addPasskey({ id: "credential-id", publicKey: Uint8Array.from([1]), counter: 0, transports: [], deviceType: "singleDevice", backedUp: false });
  await Promise.resolve();
  const phone = auth.createSession();
  await adding;
  await auth.writeQueue;
  assert.equal(auth.hasPasskeys, true);
  assert.equal(auth.hasValidSession(`herdr_session=${phone}`), true);
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasPasskeys, true);
  assert.equal(reloaded.hasValidSession(`herdr_session=${phone}`), true);
});

test("wrong passwords lock only the caller that made them", () => {
  let clock = 0;
  const attempts = new PasswordAttemptsByKey({ now: () => clock, free: 1, maxLockMs: 4_000, overallFree: 3 });
  attempts.failed("phone");
  attempts.failed("phone");
  assert.equal(attempts.retryAfterMs("phone"), 1_000);
  assert.equal(attempts.retryAfterMs("laptop"), 0, "another device can still sign in");
  attempts.succeeded("laptop");
  assert.equal(attempts.retryAfterMs("phone"), 1_000, "someone else's success does not clear the phone");
  for (const key of ["a", "b", "c", "d"]) attempts.failed(key);
  assert.ok(attempts.retryAfterMs("laptop") > 0, "many keys together still hit the instance-wide limit");
});

test("ending a session while another write is in flight stays ended, on disk too", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  const kept = auth.createSession();
  const ended = auth.createSession();
  const id = auth.currentSessionId(`herdr_session=${ended}`);
  assert.equal(await auth.endSession(id), true);
  const everywhere = auth.createSession();
  await auth.writeQueue;
  assert.equal(auth.hasValidSession(`herdr_session=${ended}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${kept}`), true);
  const reloaded = await loadPasswordAuth(authFile);
  assert.equal(reloaded.hasValidSession(`herdr_session=${ended}`), false);
  assert.equal(reloaded.hasValidSession(`herdr_session=${everywhere}`), true);

  void auth.createSession();
  await auth.endAllSessions();
  await auth.writeQueue;
  assert.equal(auth.hasValidSession(`herdr_session=${kept}`), false, "a write in flight does not undo the epoch");
  assert.equal((await loadPasswordAuth(authFile)).hasValidSession(`herdr_session=${kept}`), false);
});

test("a running server never writes its old password over one changed from the command line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "old");
  const auth = await loadPasswordAuth(authFile);
  await writePasswordConfiguration(authFile, "new");
  await assert.rejects(auth.endAllSessions(), /changed outside this server/);
  const session = auth.createSession();
  await auth.writeQueue;
  assert.equal(await (await loadPasswordAuth(authFile)).verifyPassword("new"), true);
  assert.equal(auth.hasValidSession(`herdr_session=${session}`), true, "this server keeps working until it restarts");

  await unlink(authFile);
  auth.createSession();
  await auth.writeQueue;
  assert.equal((await loadPasswordAuth(authFile)).required, false, "a password turned off stays off");
});

test("without a password there is no current session to name", () => {
  const auth = new PasswordAuth(null);
  assert.equal(auth.currentSessionId(undefined), null);
  assert.equal(auth.currentSessionId("herdr_session=anything"), null);
});

test("a browser signing in again replaces its own earlier sign-ins, not others'", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-auth-"));
  const authFile = join(directory, "auth.json");
  await writePasswordConfiguration(authFile, "secret");
  const auth = await loadPasswordAuth(authFile);
  let ended = 0;
  auth.onSessionsEnded(() => { ended += 1; });
  const phoneDevice = auth.browserDevice("");
  const laptopDevice = auth.browserDevice(undefined);
  assert.notEqual(phoneDevice, laptopDevice);
  assert.equal(auth.browserDevice(`herdr_device=${phoneDevice}`), phoneDevice, "a browser keeps its device");
  assert.notEqual(auth.browserDevice("herdr_device=short"), "short", "a malformed device is replaced");

  const first = auth.createSession({ agent: "Chrome · Android", device: phoneDevice });
  const laptop = auth.createSession({ agent: "Firefox · Linux", device: laptopDevice });
  assert.equal(ended, 0, "another browser adds a row");
  assert.equal(auth.sessionSummaries().length, 2);

  // Signed out, or the cookie lost: only the device cookie is left.
  const second = auth.createSession({ agent: "Chrome · Android", device: phoneDevice, cookieHeader: `herdr_device=${phoneDevice}` });
  assert.equal(ended, 1, "open connections of the replaced sign-in check again");
  assert.equal(auth.hasValidSession(`herdr_session=${first}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${second}`), true);
  assert.equal(auth.hasValidSession(`herdr_session=${laptop}`), true);
  assert.deepEqual(auth.sessionSummaries().map((item) => item.agent).sort(), ["Chrome · Android", "Firefox · Linux"]);
  for (const summary of auth.sessionSummaries()) {
    assert.deepEqual(Object.keys(summary).sort(), ["agent", "createdAt", "expiresAt", "id", "lastUsedAt"], "the device is never listed");
  }

  await auth.writeQueue;
  const source = await readFile(authFile, "utf8");
  assert.equal(source.includes(phoneDevice), false, "the file keeps only a hash of the device");
  const reloaded = await loadPasswordAuth(authFile);
  reloaded.createSession({ device: phoneDevice });
  assert.equal(reloaded.hasValidSession(`herdr_session=${second}`), false, "replaced across a restart too");
  assert.equal(reloaded.sessionSummaries().length, 2);
});

test("a sign-in that still carries a valid session replaces it", async () => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const other = auth.createSession({ agent: "Other" });
  const before = auth.createSession({ agent: "Old" });
  let ended = 0;
  auth.onSessionsEnded(() => { ended += 1; });
  const after = auth.createSession({ agent: "New", cookieHeader: `herdr_session=${before}` });
  assert.equal(ended, 1);
  assert.equal(auth.hasValidSession(`herdr_session=${before}`), false);
  assert.equal(auth.hasValidSession(`herdr_session=${after}`), true);
  assert.equal(auth.hasValidSession(`herdr_session=${other}`), true);
  assert.deepEqual(auth.sessionSummaries().map((item) => item.agent).sort(), ["New", "Other"]);
  auth.createSession({ agent: "Third" });
  assert.equal(ended, 1, "a sign-in that replaces nothing ends nothing");
});

test("sessions saved without a device stay valid; a malformed device is refused", async () => {
  const configuration = await createPasswordConfiguration("secret");
  const now = Math.floor(Date.now() / 1000);
  const legacy = { id: "A".repeat(22), createdAt: now, expiresAt: now + 60, lastUsedAt: now, agent: "Old browser" };
  const auth = new PasswordAuth({ ...configuration, sessions: [legacy] });
  auth.createSession({ device: auth.browserDevice("") });
  assert.deepEqual(auth.sessionSummaries().map((item) => item.agent).sort(), ["Old browser", "Unknown browser"]);
  assert.equal(new PasswordAuth({ ...configuration, sessions: [{ ...legacy, device: "B".repeat(22) }] }).sessionSummaries().length, 1);
  for (const device of ["", "short", "x".repeat(23), "A".repeat(21) + "!", 7, null]) {
    assert.throws(() => new PasswordAuth({ ...configuration, sessions: [{ ...legacy, device }] }), /session configuration is invalid/u);
  }
});
