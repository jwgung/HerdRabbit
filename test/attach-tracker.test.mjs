import test from "node:test";
import assert from "node:assert/strict";
import { createAttachTracker } from "../public/terminal-status.js";

// Where the pane on screen is in attaching, and why each pane last failed to.

test("nothing is known of a pane until its attach is noted or has failed", () => {
  const tracker = createAttachTracker();
  assert.equal(tracker.of("p1"), null);
  assert.equal(tracker.of(null), null);
});

test("a noted attach is the pane's, from when it was noted", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "attaching", 1_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "attaching", since: 1_000, problem: null });
  assert.equal(tracker.of("p2"), null);
});

test("the same state noted again keeps its time, another state starts a new one", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "attaching", 1_000);
  tracker.note("p1", "attaching", 5_000);
  assert.equal(tracker.of("p1").since, 1_000);
  tracker.note("p1", "live", 6_000);
  assert.equal(tracker.of("p1").since, 6_000);
  tracker.note("p1", "held", 7_000);
  assert.equal(tracker.of("p1").since, 7_000);
});

test("only the pane on screen has an attach: noting another pane replaces it", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "live", 1_000);
  tracker.note("p2", "attaching", 2_000);
  assert.equal(tracker.of("p1"), null);
  assert.equal(tracker.of("p2").state, "attaching");
  tracker.note("p1", "attaching", 3_000);
  assert.equal(tracker.of("p1").since, 3_000, "back on p1 it starts again");
});

test("a pane that could not attach is remembered, even when it is not on screen", () => {
  const tracker = createAttachTracker();
  tracker.failed("p1", "herdr_silent", 4_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "failed", since: 0, problem: "herdr_silent" });
});

test("a failure of the pane on screen is its attach, from when it failed", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "attaching", 1_000);
  tracker.failed("p1", "herdr_failed", 4_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "failed", since: 4_000, problem: "herdr_failed" });
});

test("a failure of another pane leaves the one on screen as it is", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "live", 1_000);
  tracker.failed("p2", "busy", 4_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "live", since: 1_000, problem: null });
  assert.equal(tracker.of("p2").problem, "busy");
});

test("trying again carries the reason along until the pane is live", () => {
  const tracker = createAttachTracker();
  tracker.note("p1", "attaching", 1_000);
  tracker.failed("p1", "herdr_failed", 2_000);
  tracker.note("p1", "attaching", 3_000);
  assert.equal(tracker.of("p1").problem, "herdr_failed");
  tracker.note("p1", "held", 4_000);
  assert.equal(tracker.of("p1").problem, "herdr_failed");
});

test("a remembered reason is the pane's when it comes back on screen", () => {
  const tracker = createAttachTracker();
  tracker.failed("p1", "busy", 1_000);
  tracker.note("p2", "live", 2_000);
  tracker.note("p1", "attaching", 3_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "attaching", since: 3_000, problem: "busy" });
});

test("a live pane has no reason, and forgets the one it had", () => {
  const tracker = createAttachTracker();
  tracker.failed("p1", "busy", 1_000);
  tracker.note("p1", "live", 2_000);
  assert.deepEqual(tracker.of("p1"), { paneId: "p1", state: "live", since: 2_000, problem: null });
  tracker.note("p2", "attaching", 3_000);
  assert.equal(tracker.of("p1"), null, "nothing left of the old reason");
});

test("trackers do not share what they know", () => {
  const first = createAttachTracker();
  const second = createAttachTracker();
  first.note("p1", "live", 1);
  assert.equal(second.of("p1"), null);
});
