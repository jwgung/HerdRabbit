import test from "node:test";
import assert from "node:assert/strict";
import {
  updateAllConfirmText, updateAllCount, updateAllPlan, updateAllResultText,
} from "../public/app/plugin-model.js";
import { appVersionText, herdrRunSummary, runSummary } from "../public/app-update.js";
import { RUN_STEPS } from "../src/app-update.mjs";

const plugin = (id, fields = {}) => ({ id, name: id.toUpperCase(), updatable: true, protected: false, updateAvailable: true, ...fields });
const check = (fields = {}) => ({
  supported: true, available: true, blocked: null, error: null, mode: "plugin",
  current: { version: "1.4.29", sha: "abc1234" }, latest: { version: "1.4.30", sha: "def5678" }, ...fields,
});

test("Update all takes the plugins marked behind, in list order, and HerdRabbit last", () => {
  const plugins = [
    plugin("herdrabbit", { protected: true, updatable: false }), plugin("a"), plugin("b", { updateAvailable: false }),
    plugin("c", { updateAvailable: null }), plugin("d"), plugin("linked", { updatable: false }),
  ];
  const plan = updateAllPlan(plugins, appVersionText(check()));
  assert.deepEqual(plan.plugins.map((item) => item.id), ["a", "d"]);
  assert.equal(plan.app, true);
  assert.equal(updateAllCount(plan), 3);
  assert.equal(updateAllPlan(plugins, appVersionText(check({ available: false }))).app, false);
  assert.equal(updateAllPlan(plugins, appVersionText(check({ blocked: "local_changes" }))).app, false);
  assert.equal(updateAllPlan(plugins, null).app, false);
  assert.equal(updateAllCount(updateAllPlan([], null)), 0);
});

test("Update all asks once, naming each update and HerdRabbit last", () => {
  const plan = updateAllPlan([plugin("a")], appVersionText(check()));
  const text = updateAllConfirmText("Laptop", plan, { appLine: "1.4.29 → 1.4.30 available", appDetails: "Herdr restarts it." });
  assert.deepEqual(text.split("\n"), [
    "Update these 2 on Laptop, one at a time?", "• A", "• HerdRabbit (1.4.29 → 1.4.30), last: it restarts", "",
    "Update all stops at the first update that fails.",
    "Herdr downloads and builds each plugin's new version, which runs its own code there.", "Herdr restarts it.",
  ]);
  assert.match(updateAllConfirmText("Laptop", { plugins: [plugin("a")], app: false }), /^Update this on Laptop/u);
});

test("Update all's last word: all done, or where it stopped and what was left", () => {
  assert.deepEqual(updateAllResultText(["A", "B"], []), { text: "Updated all 2.", error: false });
  assert.deepEqual(updateAllResultText(["A"], []), { text: "Updated A.", error: false });
  assert.deepEqual(updateAllResultText(["A"], ["C", "HerdRabbit"], "Couldn't update B: offline"),
    { text: "Update all stopped. Couldn't update B: offline. Not updated: C, HerdRabbit.", error: true });
  assert.equal(updateAllResultText([], [], "The update failed.").text, "Update all stopped. The update failed.");
});

test("HerdRabbit's versions in a line, from About's check", () => {
  assert.deepEqual(appVersionText(check()), { text: "1.4.29 → 1.4.30 available", error: false, note: null, canUpdate: true });
  assert.equal(appVersionText(check({ available: false })).text, "1.4.29 · Up to date");
  assert.equal(appVersionText(check({ current: { sha: "abc1234" } }), "1.4.28").text, "1.4.28 → 1.4.30 available");
  const blocked = appVersionText(check({ blocked: "local_changes" }));
  assert.equal(blocked.canUpdate, false);
  assert.match(blocked.note, /local changes/u);
  assert.deepEqual(appVersionText(check({ error: "fetch_failed" })),
    { text: "Could not reach origin to check for a new version.", error: true, note: null, canUpdate: false });
  assert.equal(appVersionText({ supported: false }), null);
  assert.equal(appVersionText(null), null);
});

test("a run in one line, as the Update window heads it", () => {
  const status = { state: "running", mode: "plugin", steps: RUN_STEPS.plugin, phase: "fetch" };
  assert.deepEqual(runSummary({ status, tracking: true, waiting: false }),
    { text: "Updating… Step 1 of 3: Download and build the new version.", error: false, running: true });
  assert.equal(runSummary({ status: { ...status, phase: "restart" }, tracking: true, waiting: true }).text,
    "Updating… Step 2 of 3: Restart HerdRabbit.");
  const failed = runSummary({ status: { ...status, state: "failed", reason: "update_failed" }, tracking: false });
  assert.equal(failed.error, true);
  assert.match(failed.text, /^Herdr could not update the plugin/u);
  assert.equal(runSummary(null), null);
  assert.equal(herdrRunSummary({ status: { state: "running" }, tracking: true }).text, "Updating Herdr…");
  assert.equal(herdrRunSummary({ status: { state: "running" }, tracking: true, waiting: true }).text, "Waiting for an answer…");
  assert.equal(herdrRunSummary(null), null);
});
