import test from "node:test";
import assert from "node:assert/strict";
import { paneSelectionAfterSnapshot } from "../public/ui-model.js";

const LINK = "link_4c139ff5-0dfb-4a6e-9d1c-2b3a4c5d6e7f";
const REMOTE = `${LINK}!hs_x~w1:p1`;
const LIMIT = 20_000;

const here = (...ids) => ids.map((pane_id) => ({ pane_id }));
const servers = (fields = {}) => [
  { id: "local", available: true, connecting: false },
  { id: LINK, available: true, connecting: false, ...fields },
];

// Everything a snapshot arrival decides from; a test overrides what it is about.
function plan(overrides = {}) {
  return paneSelectionAfterSnapshot({
    panes: here("w1:p1", "w2:p1"),
    servers: servers(),
    herdrSessions: [],
    selectedPaneId: null,
    preferredPaneId: null,
    pendingPaneId: null,
    pendingSince: 0,
    openedAt: 0,
    now: 1_000,
    waitLimitMs: LIMIT,
    ...overrides,
  });
}

test("with nothing chosen the first pane is selected and remembered", () => {
  assert.deepEqual(plan(), {
    selectedPaneId: "w1:p1",
    preferredPaneId: "w1:p1",
    pendingPaneId: null,
    adopted: false,
    giveUp: null,
    stop: null,
    remember: "w1:p1",
  });
});

test("a pane still in the snapshot stays selected, whatever else was preferred", () => {
  const next = plan({ selectedPaneId: "w2:p1", preferredPaneId: "w1:p1" });
  assert.equal(next.selectedPaneId, "w2:p1");
  assert.equal(next.preferredPaneId, "w2:p1");
  assert.equal(next.remember, "w2:p1");
});

test("a vanished local pane gives way to the first pane", () => {
  const next = plan({ selectedPaneId: "w9:p9", preferredPaneId: "w9:p9" });
  assert.equal(next.selectedPaneId, "w1:p1");
  assert.equal(next.remember, "w1:p1");
});

test("an old pane id is carried over to the default Herdr session it moved into", () => {
  const next = plan({
    panes: here("hs_ZGVmYXVsdA~w1:p1"),
    herdrSessions: [{ session_id: "hs_ZGVmYXVsdA", default: true }],
    selectedPaneId: "w1:p1",
  });
  assert.equal(next.selectedPaneId, "hs_ZGVmYXVsdA~w1:p1");
});

test("no panes at all selects nothing and keeps the preference for when they return", () => {
  const next = plan({ panes: [], preferredPaneId: "w1:p1" });
  assert.equal(next.selectedPaneId, null);
  assert.equal(next.preferredPaneId, "w1:p1");
  assert.equal(next.remember, null);
  assert.equal(next.stop, null);
});

test("a notification's pane is adopted once it is in the snapshot, over the current selection", () => {
  const next = plan({ selectedPaneId: "w1:p1", pendingPaneId: "w2:p1" });
  assert.equal(next.adopted, true);
  assert.equal(next.selectedPaneId, "w2:p1");
  assert.equal(next.preferredPaneId, "w2:p1");
  assert.equal(next.pendingPaneId, null);
  assert.equal(next.remember, "w2:p1");
  assert.equal(next.stop, null);
});

test("a notification's pane that is not in the snapshot is not adopted", () => {
  const next = plan({ selectedPaneId: "w1:p1", pendingPaneId: "w9:p9" });
  assert.equal(next.adopted, false);
  assert.equal(next.selectedPaneId, "w1:p1");
  // a local pane that is not there has nothing to wait for; it stays pending as before
  assert.equal(next.pendingPaneId, "w9:p9");
});

test("another server's pane is waited for while that server connects, and nothing else changes", () => {
  const next = plan({
    servers: servers({ available: false, connecting: true }),
    selectedPaneId: "w1:p1",
    pendingPaneId: REMOTE,
    pendingSince: 500,
  });
  assert.equal(next.stop, "waiting");
  assert.equal(next.selectedPaneId, "w1:p1");
  assert.equal(next.pendingPaneId, REMOTE);
  assert.equal(next.remember, null);
  assert.equal(next.giveUp, null);
});

test("the wait for a notification's pane is counted from when the notification arrived", () => {
  const connecting = servers({ available: false, connecting: true });
  const base = { servers: connecting, selectedPaneId: "w1:p1", pendingPaneId: REMOTE, pendingSince: 500, openedAt: 0 };
  assert.equal(plan({ ...base, now: 500 + LIMIT - 1 }).stop, "waiting");
  const gaveUp = plan({ ...base, now: 500 + LIMIT });
  assert.equal(gaveUp.stop, null);
  assert.equal(gaveUp.giveUp, REMOTE);
  assert.equal(gaveUp.pendingPaneId, null, "a pane given up on is not waited for again");
  assert.equal(gaveUp.selectedPaneId, "w1:p1");
});

test("a page opened on another server's pane waits from when the page opened", () => {
  const connecting = servers({ available: false, connecting: true });
  const base = { servers: connecting, preferredPaneId: REMOTE, selectedPaneId: null, openedAt: 100 };
  const waiting = plan({ ...base, now: 100 + LIMIT - 1 });
  assert.equal(waiting.stop, "waiting");
  assert.equal(waiting.selectedPaneId, null, "no other pane is opened in its place");
  const gaveUp = plan({ ...base, now: 100 + LIMIT });
  assert.equal(gaveUp.giveUp, REMOTE);
  assert.equal(gaveUp.selectedPaneId, "w1:p1");
  assert.equal(gaveUp.pendingPaneId, null);
});

test("a server that failed to answer is not waited for", () => {
  const next = plan({
    servers: servers({ available: false, connecting: false }),
    preferredPaneId: REMOTE,
  });
  assert.equal(next.stop, null);
  assert.equal(next.giveUp, REMOTE);
  assert.equal(next.selectedPaneId, "w1:p1");
});

test("the pane on screen stays while its server comes back", () => {
  const next = plan({
    servers: servers({ available: false, connecting: false }),
    selectedPaneId: REMOTE,
    preferredPaneId: REMOTE,
  });
  assert.equal(next.stop, "vanished");
  assert.equal(next.selectedPaneId, REMOTE);
  assert.equal(next.remember, null);
});

test("an adopted notification pane is no longer awaited, so a connecting server does not stop the run", () => {
  const next = plan({
    servers: servers({ available: false, connecting: true }),
    panes: here("w1:p1", "w2:p1"),
    selectedPaneId: REMOTE,
    pendingPaneId: "w2:p1",
  });
  assert.equal(next.adopted, true);
  assert.equal(next.selectedPaneId, "w2:p1");
  assert.equal(next.stop, null);
});

test("the plan does not change what it was given", () => {
  const panes = here("w1:p1");
  const frozen = Object.freeze({ panes: Object.freeze(panes), servers: Object.freeze(servers()), herdrSessions: Object.freeze([]) });
  assert.doesNotThrow(() => plan(frozen));
});
