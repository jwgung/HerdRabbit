import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { passkeyDetails } from "../public/ui-model.js";

const styles = await readFile(
  new URL("../public/styles.css", import.meta.url),
  "utf8",
);
const page = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const app = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

test("keeps the password screen hidden when authentication is disabled", () => {
  assert.match(
    styles,
    /\.login-screen\[hidden\]\s*\{[\s\S]*?display:\s*none/,
  );
});

test("offers passkey login without removing the password fallback", () => {
  assert.match(page, /id="login-password"/);
  assert.match(page, /autocomplete="current-password webauthn"/);
  assert.match(page, /id="passkey-login"[^>]*>\s*Sign in with a passkey/s);
  assert.match(page, /id="passkey-dialog"/);
  assert.match(page, /id="passkey-register"/);
  assert.match(page, /simplewebauthn-browser\.js/);
  assert.match(app, /startAuthentication\(\{\s*optionsJSON:/);
  assert.match(app, /\/api\/auth\/passkeys\/login\/options/);
  assert.match(app, /startRegistration\(\{\s*optionsJSON:/);
  assert.match(app, /\/api\/auth\/passkeys\/register\/verify/);
});

test("renders Passkey before the password fallback in the login card", () => {
  assert.match(
    page,
    /id="passkey-login"[^>]*class="[^"]*primary-button[^"]*"[\s\S]*id="login-password"[\s\S]*class="[^"]*login-submit[^"]*secondary-button/,
  );
  assert.match(page, /id="login-instruction"/);
  assert.match(page, /id="login-password-label"/);
  assert.match(app, /loginMethodPresentation/);
});

test("starts a regular passkey ceremony once when the login screen opens", () => {
  assert.match(app, /passkeyAutoStarted: false,/);
  assert.match(app, /state\.passkeyAutoStarted = true;\s+void startPasskeyLogin\(\);/);
  assert.match(app, /elements\.loginScreen\.hidden = false;[\s\S]*?startAutomaticPasskeyLogin\(\);/);
  assert.doesNotMatch(app, /useBrowserAutofill: true/);
});

test("shares one verification path between automatic login and the passkey button", () => {
  assert.equal((app.match(/passkeys\/login\/verify/g) || []).length, 1);
  assert.match(app, /passkeyLogin\.addEventListener\("click", \(\) => \{\s+rememberLoginMethod\("passkey"\);\s+void startPasskeyLogin\(\);/);
});

test("guards concurrent passkey ceremonies", () => {
  assert.match(app, /async function startPasskeyLogin\(\) \{\s+if \(state\.passkeyBusy \|\| state\.authenticated/);
});

test("manages passkeys from this machine's menu only, with the password again", () => {
  assert.match(page, /id="passkeys-dialog"/);
  assert.match(page, /id="passkeys-list"/);
  // No password field under the list: Remove and Add ask in a window of their own.
  assert.doesNotMatch(page, /id="passkeys-password"/);
  assert.match(page, /id="passkey-password-dialog"/);
  assert.match(page, /id="passkey-password-input"[^>]*type="password"/);
  assert.doesNotMatch(app, /window\.confirm\(`Remove \$\{name\}/);
  assert.match(app, /function removePasskey\(passkey\) \{[\s\S]*?askPasskeyPassword\(\{/);
  assert.match(app, /querySelector\("#passkeys-add"\)\.addEventListener\("click", \(\) => \{[\s\S]*?askPasskeyPassword\(\{/);
  assert.match(page, /id="passkeys-add"/);
  assert.match(page, /id="passkey-dialog-password"[^>]*type="password"/);
  assert.match(
    app,
    /key: "passkeys",\s+label: "Passkeys",/,
  );
  // Both sign-in items follow the sign-in being on; the machine menu has none of them.
  assert.match(app, /for \(const key of \["passkeys", "sessions"\]\) item\(key\)\.hidden = !state\.authRequired;/);
  const machineMenu = app.slice(app.indexOf("function serverActionMenu"), app.indexOf("// This machine is not a connection"));
  assert.doesNotMatch(machineMenu, /Passkeys|Signed-in devices|Sign out/);
  assert.doesNotMatch(app, /function signOut\(/);
  // Without WebAuthn the list still opens, to remove; only adding is hidden.
  assert.match(app, /querySelector\("#passkeys-add"\)\.hidden = !supportsPasskeys\(\);/);
  // Escape cannot close either dialog under a running ceremony.
  assert.match(app, /passkeysDialog\.addEventListener\("cancel", \(event\) => \{ if \(state\.passkeyBusy\) event\.preventDefault\(\); \}\);/);
  assert.match(
    app,
    /elements\.passkeyDialog\.addEventListener\("cancel", \(event\) => \{\s+if \(state\.passkeyBusy\) event\.preventDefault\(\);/,
  );
  // One registration path, and both of its callers send the password.
  assert.equal((app.match(/passkeys\/register\/options/g) || []).length, 1);
  assert.match(app, /passkeys\/register\/options", \{\s+method: "POST",\s+body: \{ password \},/);
  assert.match(app, /passkeys\/remove", \{\s+method: "POST",\s+body: \{ handle: passkey\.handle, password \},/);
  // The password never outlives the dialog it was typed into.
  assert.match(app, /passkeyPasswordDialog\.addEventListener\("close", \(\) => \{\s+passkeyPasswordInput\.value = "";/);
  assert.match(app, /passkeyPasswordDialog\.addEventListener\("cancel", \(event\) => \{ if \(state\.passkeyBusy\) event\.preventDefault\(\); \}\);/);
  assert.match(app, /passkeyDialog\.addEventListener\("close", \(\) => \{\s+elements\.passkeyDialogPassword\.value = "";/);
});

test("describes a passkey by its dates, and an older one by nothing it cannot know", () => {
  const date = (value) => `day ${value}`;
  assert.equal(passkeyDetails({ createdAt: 1, lastUsedAt: 2, backedUp: true }, date), "Added day 1 · Last used day 2 · Synced");
  assert.equal(passkeyDetails({ createdAt: 1, lastUsedAt: null, backedUp: false }, date), "Added day 1 · Not used yet");
  assert.equal(passkeyDetails({ createdAt: null, lastUsedAt: null, backedUp: false }, date), "");
  assert.equal(passkeyDetails({ createdAt: null, lastUsedAt: 5, backedUp: true }, date), "Last used day 5 · Synced");
});
