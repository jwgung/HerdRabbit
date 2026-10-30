import test from "node:test";
import assert from "node:assert/strict";
import { reconcileLiveStatus, seenCompletions } from "../public/ui-model.js";

// A snapshot over HTTP can arrive after a newer status event over the socket,
// and must not undo it. These are the rules for what each pending event does
// when a snapshot arrives, and for which finished work the page had already seen.

const pane = (id, fields = {}) => ({ pane_id: id, ...fields });
const event = (id, status, sequence) => ({ pane_id: id, agent_status: status, sequence });
const pending = (...events) => new Map(events.map((item) => [item.pane_id, item]));

function reconcile({ events = [], requestedAfter = 5, panes = [], agents = [], seen = new Set() } = {}) {
  return reconcileLiveStatus({ pending: pending(...events), requestedAfter, panes, agents, seen });
}

test("an event the snapshot already shows, from before it was asked for, is settled", () => {
  const next = reconcile({
    events: [event("p1", "working", 3)],
    panes: [pane("p1", { agent_status: "working" })],
  });
  assert.deepEqual(next, { drop: ["p1"], apply: [], acknowledge: [] });
});

test("an event the snapshot disagrees with is put back, so a slow response cannot undo it", () => {
  const stale = event("p1", "done", 4);
  const next = reconcile({ events: [stale], panes: [pane("p1", { agent_status: "working" })] });
  assert.deepEqual(next, { drop: [], apply: [stale], acknowledge: [] });
});

test("an event that came after the snapshot was asked for is put back even when the snapshot agrees", () => {
  const newer = event("p1", "working", 6);
  const next = reconcile({ events: [newer], requestedAfter: 5, panes: [pane("p1", { agent_status: "working" })] });
  assert.deepEqual(next, { drop: [], apply: [newer], acknowledge: [] });
});

test("the event that was the newest when the snapshot was asked for counts as before it", () => {
  const next = reconcile({
    events: [event("p1", "idle", 5)], requestedAfter: 5,
    panes: [pane("p1", { agent_status: "idle" })],
  });
  assert.deepEqual(next.drop, ["p1"]);
});

test("an event for a pane that is gone is dropped and not applied", () => {
  const next = reconcile({ events: [event("p9", "working", 1)], panes: [pane("p1")] });
  assert.deepEqual(next, { drop: ["p9"], apply: [], acknowledge: [] });
});

test("the agent's own record outranks the pane's when reading the status", () => {
  const next = reconcile({
    events: [event("p1", "blocked", 1)],
    panes: [pane("p1", { agent_status: "idle" })],
    agents: [{ pane_id: "p1", agent_status: "blocked" }],
  });
  assert.deepEqual(next.drop, ["p1"]);
});

test("an agent record is found by either spelling of the pane id", () => {
  const next = reconcile({
    events: [event("p1", "blocked", 1)],
    panes: [pane("p1")],
    agents: [{ paneId: "p1", agent_status: "blocked" }],
  });
  assert.deepEqual(next.drop, ["p1"]);
});

test("a finished pane whose finish the page had already seen is acknowledged again under the new snapshot's identity", () => {
  const next = reconcile({
    events: [event("p1", "done", 2)],
    panes: [pane("p1", { agent_status: "done", state_change_seq: 41 })],
    seen: new Set(["p1"]),
  });
  assert.deepEqual(next, { drop: ["p1"], apply: [], acknowledge: [["p1", "seq:41"]] });
});

test("a finish the page had not seen stays unseen, and only a done event can acknowledge", () => {
  const unseen = reconcile({
    events: [event("p1", "done", 2)],
    panes: [pane("p1", { agent_status: "done", state_change_seq: 41 })],
    seen: new Set(),
  });
  assert.deepEqual(unseen.acknowledge, []);
  const notDone = reconcile({
    events: [event("p1", "working", 2)],
    panes: [pane("p1", { agent_status: "working", state_change_seq: 41 })],
    seen: new Set(["p1"]),
  });
  assert.deepEqual(notDone.acknowledge, []);
});

test("every pane is decided on its own, in the order the events are held", () => {
  const kept = event("p2", "done", 9);
  const next = reconcile({
    events: [event("p1", "idle", 1), kept, event("p3", "working", 2), event("p4", "idle", 1)],
    requestedAfter: 5,
    panes: [
      pane("p1", { agent_status: "idle" }),
      pane("p2", { agent_status: "done" }),
      pane("p3", { agent_status: "idle" }),
    ],
  });
  assert.deepEqual(next.drop, ["p1", "p4"]);
  assert.deepEqual(next.apply, [kept, event("p3", "working", 2)]);
});

test("reconciling does not change what it was given", () => {
  const events = pending(event("p1", "done", 1));
  const panes = Object.freeze([Object.freeze(pane("p1", { agent_status: "done" }))]);
  const agents = Object.freeze([]);
  const seen = Object.freeze(new Set(["p1"]));
  assert.doesNotThrow(() => reconcileLiveStatus({ pending: events, requestedAfter: 5, panes, agents, seen }));
  assert.equal(events.size, 1);
});

test("a finish is seen when the page acknowledged exactly the identity it has now", () => {
  const panes = [
    pane("p1", { state_change_seq: 7 }),
    pane("p2", { state_change_seq: 8 }),
    pane("p3", { state_change_seq: 9 }),
    pane("p4"),
  ];
  const agents = [{ pane_id: "p3", state_change_seq: 90 }];
  const acknowledged = new Map([["p1", "seq:7"], ["p2", "seq:1"], ["p3", "seq:90"]]);
  assert.deepEqual([...seenCompletions({ panes, agents, acknowledged })].sort(), ["p1", "p3"]);
});

test("a pane never acknowledged, or with no identity, is not seen", () => {
  const panes = [pane("p1", { state_change_seq: 7 }), pane("p2")];
  assert.deepEqual([...seenCompletions({ panes, agents: [], acknowledged: new Map() })], []);
});
