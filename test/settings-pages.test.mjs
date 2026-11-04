import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_PAGES,
  notificationStateText,
  settingsPageList,
  settingsPageTitle,
} from "../public/settings-pages.js";

test("lists the settings pages in order", () => {
  assert.deepEqual(SETTINGS_PAGES.map((page) => page.id),
    ["appearance", "chat", "terminal", "notifications", "security", "pcs", "plugins", "updates", "about"]);
  assert.deepEqual(SETTINGS_PAGES.map((page) => page.title),
    ["Appearance", "Chat", "Terminal & keys", "Notifications", "Security", "PCs", "Plugins", "Updates", "About"]);
  assert.equal(settingsPageTitle("pcs"), "PCs");
  assert.equal(settingsPageTitle("nowhere"), null);
});

test("Security shows only with sign-in on, PCs only where Connect PC is", () => {
  const ids = (options) => settingsPageList(options).map((page) => page.id);
  assert.deepEqual(ids({ security: true, pcs: true, plugins: true }), SETTINGS_PAGES.map((page) => page.id));
  assert.deepEqual(ids({ security: true, pcs: true }), ["appearance", "chat", "terminal", "notifications", "security", "pcs", "updates", "about"]);
  assert.deepEqual(ids({ security: false, pcs: true }), ["appearance", "chat", "terminal", "notifications", "pcs", "updates", "about"]);
  assert.deepEqual(ids({ security: true, pcs: false }), ["appearance", "chat", "terminal", "notifications", "security", "updates", "about"]);
  assert.deepEqual(ids({}), ["appearance", "chat", "terminal", "notifications", "updates", "about"]);
});

test("Plugins shows only with sign-in on, where this HerdRabbit can manage them", () => {
  const ids = (options) => settingsPageList(options).map((page) => page.id);
  assert.ok(ids({ security: true, plugins: true }).includes("plugins"));
  assert.ok(!ids({ security: false, plugins: true }).includes("plugins"));
  assert.ok(!ids({ security: true, plugins: false }).includes("plugins"));
});

test("Updates shows always: HerdRabbit's and Herdr's updates need no sign-in", () => {
  for (const options of [{}, { security: true, plugins: true }, { security: false, plugins: true }]) {
    const ids = settingsPageList(options).map((page) => page.id);
    assert.deepEqual(ids.slice(-2), ["updates", "about"]);
  }
});

test("says what state notifications are in", () => {
  assert.equal(notificationStateText(null), "Notifications aren't supported in this browser.");
  assert.equal(notificationStateText({ hidden: true, state: "unavailable" }), "Notifications aren't supported in this browser.");
  assert.equal(notificationStateText({ hidden: false, state: "enabled" }), "On: this browser is told when an agent needs you or is done.");
  assert.equal(notificationStateText({ hidden: false, state: "disabled" }), "Off.");
  assert.equal(notificationStateText({ hidden: false, state: "denied" }), "Blocked: allow notifications for this site in your browser settings.");
});
