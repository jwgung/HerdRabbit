import test from "node:test";
import assert from "node:assert/strict";
import { herdrUpdateLine, integrationAction, integrationConfirmText, integrationStateText } from "../public/app/herdr-settings-model.js";

test("an integration reads as Herdr says it, with its version", () => {
  assert.equal(integrationStateText({ state: "current", detail: "v11" }), "Installed (v11)");
  assert.equal(integrationStateText({ state: "not_installed" }), "Not installed");
  assert.equal(integrationStateText({ state: "outdated", detail: "v2 < v4" }), "Outdated (v2 < v4)");
  assert.equal(integrationStateText({ state: "needs_repair", detail: "v13" }), "Needs repair (v13)");
  assert.equal(integrationStateText({ state: "other", label: "disabled" }), "disabled");
});

test("an installed integration is uninstalled; any other is installed, which also updates and repairs", () => {
  assert.deepEqual(integrationAction({ state: "current" }), { action: "uninstall", label: "Uninstall…" });
  assert.deepEqual(integrationAction({ state: "not_installed" }), { action: "install", label: "Install…" });
  assert.deepEqual(integrationAction({ state: "outdated" }), { action: "install", label: "Update…" });
  assert.deepEqual(integrationAction({ state: "needs_repair" }), { action: "install", label: "Repair…" });
});

test("the question names the integration and the machine", () => {
  assert.match(integrationConfirmText({ name: "claude" }, "uninstall", "Laptop"), /^Uninstall Herdr's claude integration on Laptop\?/u);
  assert.match(integrationConfirmText({ name: "pi" }, "install", "This PC"), /^Install Herdr's pi integration on This PC\?/u);
});

const herdrCheck = (fields = {}) => ({
  supported: true, herdr: { current: "0.9.12", latest: "0.9.14", channel: "stable", available: true, blocked: null, error: null, notes: "Faster.", ...fields },
});

test("Herdr's row: its versions, what its update would do, and its run", () => {
  assert.deepEqual(herdrUpdateLine(herdrCheck()),
    { text: "0.9.12 → 0.9.14 · Stable", error: false, available: true, canUpdate: true, notes: "Faster.", latest: "0.9.14" });
  assert.equal(herdrUpdateLine(herdrCheck({ channel: "preview" })).text, "0.9.12 → 0.9.14 · Preview");
  assert.deepEqual(herdrUpdateLine(herdrCheck({ available: false, current: "0.9.14" })),
    { text: "0.9.14 · Up to date · Stable", error: false, available: false, canUpdate: false, notes: null, latest: "0.9.14" });
  const blocked = herdrUpdateLine(herdrCheck({ blocked: "managed_install" }));
  assert.equal(blocked.canUpdate, false);
  assert.equal(blocked.error, true);
  assert.match(blocked.text, /^0\.9\.12 → 0\.9\.14 · Stable\. Herdr was installed with a package manager/u);
  assert.deepEqual(herdrUpdateLine(herdrCheck({ error: "manifest_failed" })),
    { text: "Could not reach herdr.dev to check for a new Herdr.", error: true, available: false, canUpdate: false, notes: null, latest: null });
  assert.equal(herdrUpdateLine({ supported: true }).text, "Could not check Herdr.");
  assert.equal(herdrUpdateLine({ supported: false }).text, "Herdr cannot be updated from the page there.");
  assert.equal(herdrUpdateLine(null).text, "Not checked yet.");
  assert.equal(herdrUpdateLine(null, { error: "offline" }).text, "offline");
  // A run says how it goes in place of the versions.
  const running = herdrUpdateLine(herdrCheck(), { run: { status: { state: "running" }, tracking: true } });
  assert.equal(running.text, "Updating Herdr…");
  assert.equal(running.canUpdate, false);
});
