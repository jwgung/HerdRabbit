import test from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATIONS_NOTE, RECENT_RUN_MS, dismissRun, needsIntegrations, runDismissed, showFinishedRun,
} from "../public/app-update.js";

const memory = () => {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
};
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
const now = Date.parse("2026-10-19T10:00:00Z");
const ended = (agoMs, extra = {}) => ({ state: "succeeded", finishedAt: new Date(now - agoMs).toISOString(), log: "", ...extra });

test("a finished run shows until it was seen, per PC and kind", () => {
  const storage = memory();
  const status = ended(60_000);
  assert.equal(showFinishedRun(status, { serverId: "local", kind: "herdr", storage, now }), true);
  dismissRun(storage, "local", "herdr", status.finishedAt);
  assert.equal(runDismissed(storage, "local", "herdr", status.finishedAt), true);
  assert.equal(showFinishedRun(status, { serverId: "local", kind: "herdr", storage, now }), false);
  // another kind, another PC, and a newer run are separate
  assert.equal(showFinishedRun(status, { serverId: "local", kind: "app", storage, now }), true);
  assert.equal(showFinishedRun(status, { serverId: "link_1", kind: "herdr", storage, now }), true);
  assert.equal(showFinishedRun(ended(1_000), { serverId: "local", kind: "herdr", storage, now }), true);
});

test("idle, running and old runs are not shown", () => {
  const storage = memory();
  const options = { serverId: "local", kind: "app", storage, now };
  assert.equal(showFinishedRun({ state: "idle", finishedAt: null }, options), false);
  assert.equal(showFinishedRun({ state: "running", finishedAt: null }, options), false);
  assert.equal(showFinishedRun(ended(RECENT_RUN_MS + 1), options), false);
});

test("without working storage the recent window decides", () => {
  const options = { serverId: "local", kind: "app", storage: broken, now };
  dismissRun(broken, "local", "app", "x");
  assert.equal(showFinishedRun(ended(60_000), options), true);
  assert.equal(showFinishedRun(ended(RECENT_RUN_MS + 1), options), false);
  assert.equal(showFinishedRun(ended(60_000), { ...options, storage: null }), true);
});

test("Herdr's integration notice is found in a finished log only", () => {
  const log = "installed herdr integrations need updating; run herdr integration install claude";
  assert.equal(needsIntegrations(ended(0, { log })), true);
  assert.equal(needsIntegrations(ended(0, { log: "all fine" })), false);
  assert.equal(needsIntegrations({ state: "running", log }), false);
  assert.match(INTEGRATIONS_NOTE, /herdr integration install/u);
});
