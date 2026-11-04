import test from "node:test";
import assert from "node:assert/strict";
import { integrationAction, integrationConfirmText, integrationStateText } from "../public/app/herdr-settings-model.js";

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
