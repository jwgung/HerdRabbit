import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_PAGES,
  notificationStateText,
  settingsPageList,
  settingsPageTitle,
  updateBadges,
} from "../public/settings-pages.js";

test("lists the settings pages in order", () => {
  assert.deepEqual(SETTINGS_PAGES.map((page) => page.id),
    ["appearance", "chat", "terminal", "notifications", "security", "pcs", "plugins", "herdr", "about"]);
  assert.deepEqual(SETTINGS_PAGES.map((page) => page.title),
    ["Appearance", "Chat", "Terminal & keys", "Notifications", "Security", "PCs", "Plugins", "Herdr", "About"]);
  assert.equal(settingsPageTitle("pcs"), "PCs");
  assert.equal(settingsPageTitle("nowhere"), null);
});

test("Security shows only with sign-in on, PCs only where Connect PC is", () => {
  const ids = (options) => settingsPageList(options).map((page) => page.id);
  assert.deepEqual(ids({ security: true, pcs: true, plugins: true, herdr: true }), SETTINGS_PAGES.map((page) => page.id));
  assert.deepEqual(ids({ security: true, pcs: true }), ["appearance", "chat", "terminal", "notifications", "security", "pcs", "about"]);
  assert.deepEqual(ids({ security: false, pcs: true }), ["appearance", "chat", "terminal", "notifications", "pcs", "about"]);
  assert.deepEqual(ids({ security: true, pcs: false }), ["appearance", "chat", "terminal", "notifications", "security", "about"]);
  assert.deepEqual(ids({}), ["appearance", "chat", "terminal", "notifications", "about"]);
});

test("Plugins shows only with sign-in on, where this HerdRabbit can manage them", () => {
  const ids = (options) => settingsPageList(options).map((page) => page.id);
  assert.ok(ids({ security: true, plugins: true }).includes("plugins"));
  assert.ok(!ids({ security: false, plugins: true }).includes("plugins"));
  assert.ok(!ids({ security: true, plugins: false }).includes("plugins"));
});

test("Herdr shows only with sign-in on, where this HerdRabbit can change Herdr's settings", () => {
  const ids = (options) => settingsPageList(options).map((page) => page.id);
  assert.deepEqual(ids({ security: true, plugins: true, herdr: true }).slice(-3), ["plugins", "herdr", "about"]);
  assert.ok(!ids({ security: false, herdr: true }).includes("herdr"));
  assert.ok(!ids({ security: true, herdr: false }).includes("herdr"));
});

test("there is no Updates page: its updates are in Plugins and Herdr", () => {
  for (const options of [{}, { security: true, plugins: true, herdr: true }, { security: false, plugins: true }]) {
    assert.ok(!settingsPageList(options).some((page) => page.id === "updates"));
  }
  assert.equal(settingsPageTitle("updates"), null);
});

test("Plugins counts HerdRabbit's updates and the plugins' it has read; Herdr counts Herdr's", () => {
  const app = (available, herdr = false) => ({ supported: true, available, herdr: { available: herdr } });
  assert.deepEqual(updateBadges([app(true, true), app(false, true), app(true), { supported: false, available: true }, null], [2, 0]),
    { plugins: 4, herdr: 2 });
  assert.deepEqual(updateBadges([], []), { plugins: 0, herdr: 0 });
  assert.deepEqual(updateBadges([app(false)]), { plugins: 0, herdr: 0 });
});

test("says what state notifications are in", () => {
  assert.equal(notificationStateText(null), "Notifications aren't supported in this browser.");
  assert.equal(notificationStateText({ hidden: true, state: "unavailable" }), "Notifications aren't supported in this browser.");
  assert.equal(notificationStateText({ hidden: false, state: "enabled" }), "On: this browser is told when an agent needs you or is done.");
  assert.equal(notificationStateText({ hidden: false, state: "disabled" }), "Off.");
  assert.equal(notificationStateText({ hidden: false, state: "denied" }), "Blocked: allow notifications for this site in your browser settings.");
});
