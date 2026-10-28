import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_FAILED_TEXT, confirmText, elapsedText, runFailedText, stepStates } from "../public/app-update.js";
import { RUN_STEPS } from "../src/app-update.mjs";

const states = (status, options) => stepStates(status, options).map((step) => `${step.id}:${step.state}`);

test("a running update.sh run shows the steps before its own as done", () => {
  const status = { state: "running", phase: "install", steps: RUN_STEPS.script };
  assert.deepEqual(states(status), [
    "fetch:done", "herdr:done", "install:current", "verify:pending", "restart:pending", "reload:pending",
  ]);
  // A server that does not answer is restarting.
  assert.deepEqual(states(status, { waiting: true }), [
    "fetch:done", "herdr:done", "install:done", "verify:done", "restart:current", "reload:pending",
  ]);
  // Nothing known yet: the first step.
  assert.deepEqual(states({ ...status, phase: null }).slice(0, 2), ["fetch:current", "herdr:pending"]);
});

test("a run that ended well leaves the reload, and is all done once the page reloaded", () => {
  const status = { state: "succeeded", phase: "reload", steps: RUN_STEPS.plugin };
  assert.deepEqual(states(status, { reloading: true }), ["fetch:done", "restart:done", "reload:current"]);
  assert.deepEqual(states(status), ["fetch:done", "restart:done", "reload:done"]);
  // A connected PC's page does not reload here: no such step.
  assert.deepEqual(states(status, { local: false }), ["fetch:done", "restart:done"]);
});

test("a failed run marks the step it failed in", () => {
  const status = { state: "failed", phase: "restart", reason: "restart_failed", mode: "plugin", steps: RUN_STEPS.plugin };
  assert.deepEqual(states(status), ["fetch:done", "restart:failed", "reload:pending"]);
  assert.deepEqual(stepStates({ state: "failed", phase: "x", steps: [] }), []);
  assert.deepEqual(stepStates({ state: "running" }), [], "a PC from before steps shows none");
});

test("a plugin run's failure never speaks of update.sh", () => {
  for (const reason of ["update_failed", "script_failed", "restart_failed", "interrupted", "start_failed", "unknown"]) {
    const text = runFailedText({ mode: "plugin", reason });
    assert.doesNotMatch(text, /update\.sh/u, reason);
  }
  assert.match(PLUGIN_FAILED_TEXT.restart_failed, /new version is installed/u);
  assert.match(runFailedText({ mode: "plugin", reason: "restart_failed" }), /herdr plugin action invoke herdrabbit\.restart/u);
  assert.match(runFailedText({ mode: "plugin", reason: "update_failed" }), /installed version keeps running/u);
  assert.match(runFailedText({ mode: "script", reason: "script_failed" }), /update\.sh put the previous version back/u);
  assert.match(runFailedText({ reason: "script_failed" }), /update\.sh/u, "a PC from before modes keeps its text");
  assert.doesNotMatch(confirmText("pc", { mode: "plugin", latest: { version: "2.0.1" } }), /update\.sh/u);
  assert.match(confirmText("pc", { latest: { version: "2.0.1" } }), /update\.sh/u);
});

test("the time beside a step reads as minutes and seconds", () => {
  assert.equal(elapsedText(0, 0), "0:00");
  assert.equal(elapsedText(0, 65_400), "1:05");
  assert.equal(elapsedText(0, 3_725_000), "1:02:05");
  assert.equal(elapsedText(10_000, 0), "0:00");
});
