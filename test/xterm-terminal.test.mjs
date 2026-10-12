import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// Only as much of a browser as the module touches.
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.ResizeObserver = class { observe() {} };
const { createAttachedTerminal } = await import("../public/xterm-terminal.js");

// xterm stand-ins: writes wait until the test lets them finish, as xterm's do.
class Terminal {
  constructor(options) {
    this.options = options;
    this.cols = 80;
    this.rows = 24;
    this.written = [];
    this.pending = [];
    this.resets = 0;
    this.unicode = { register() {}, activeVersion: "" };
    this.listeners = { data: [], resize: [] };
  }
  loadAddon(addon) { addon.term = this; }
  open() {}
  registerLinkProvider() {}
  attachCustomKeyEventHandler() {}
  onData(listener) { this.listeners.data.push(listener); }
  onBinary() {}
  onResize(listener) { this.listeners.resize.push(listener); }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    for (const listener of this.listeners.resize) listener({ cols, rows });
  }
  reset() { this.resets += 1; }
  write(data, done) { this.written.push(data); this.pending.push(done); }
  finishWrites() { for (const done of this.pending.splice(0)) done(); }
  type(data) { for (const listener of this.listeners.data) listener(data); }
  hasSelection() { return false; }
}
class FitAddon {
  proposeDimensions() { return { cols: 100, rows: 30 }; }
  fit() { this.term.resize(100, 30); }
}
class UnicodeGraphemesAddon {
  activate(terminal) { terminal.unicode.register({ version: "15-graphemes", wcwidth: () => 1, charProperties: () => 0 }); }
}
class WebLinksAddon {}

function setup() {
  const sent = [];
  const listeners = { attach: [], reconnect: [] };
  const connection = {
    onAttach: (listener) => listeners.attach.push(listener),
    onReconnect: (listener) => listeners.reconnect.push(listener),
    attach: (paneId, size) => sent.push(["attach", paneId, size]),
    detach: (paneId) => sent.push(["detach", paneId]),
    online: true,
    ptyInput(paneId, data) { if (!this.online) return false; sent.push(["input", paneId, data]); return true; },
    resize: (paneId, cols, rows) => sent.push(["resize", paneId, cols, rows]),
    acknowledge: (paneId, streamId, offset) => sent.push(["ack", paneId, streamId, offset]),
    takeOver: (paneId) => sent.push(["take-over", paneId]),
    resume: () => sent.push(["resume"]),
  };
  const classes = new Set();
  const host = {
    hidden: true, clientWidth: 800, clientHeight: 400, addEventListener() {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), remove: (name) => classes.delete(name) },
  };
  const fallbacks = [];
  const states = [];
  let term;
  const view = createAttachedTerminal({
    host, connection, fontSize: 12,
    xterm: { Terminal: class extends Terminal { constructor(options) { super(options); term = this; } }, FitAddon, UnicodeGraphemesAddon, WebLinksAddon },
    onFallback: (paneId) => fallbacks.push(paneId),
    onStateChange: (state) => states.push(state),
  });
  const receive = (message) => { for (const listener of listeners.attach) listener(message); };
  const reconnect = () => { for (const listener of listeners.reconnect) listener(); };
  return { view, sent, host, classes, fallbacks, states, receive, reconnect, connection, term: () => term };
}

test("shows a pane at the frame's size, writes only its stream, and acknowledges once xterm has drawn it", () => {
  const { view, sent, host, receive, term } = setup();
  assert.equal(view.show("a"), true);
  assert.equal(host.hidden, false);
  assert.deepEqual(sent.at(-1), ["attach", "a", { cols: 100, rows: 30 }]);
  receive({ type: "pty-data", pane_id: "a", data: "screen", flow: { stream_id: "s", offset: 6 } });
  receive({ type: "pty-data", pane_id: "b", data: "another pane" });
  assert.deepEqual(term().written, ["screen"]);
  assert.ok(!sent.some(([kind]) => kind === "ack"), "not before it is drawn");
  term().finishWrites();
  assert.deepEqual(sent.at(-1), ["ack", "a", "s", 6]);
});

test("typing waits for the attach, a held pane does not take it, and a lost keystroke is reported", () => {
  const { view, sent, receive, states, term } = setup();
  view.show("a");
  term().type("early");
  receive({ type: "input-ready", pane_id: "a" });
  term().type("ls\r");
  receive({ type: "attach-held", pane_id: "a" });
  term().type("while held");
  assert.deepEqual(sent.filter(([kind]) => kind === "input"), [["input", "a", "ls\r"]]);
  view.takeOver();
  assert.deepEqual(sent.at(-1), ["take-over", "a"]);
  receive({ type: "pty-input-dropped", pane_id: "a" });
  assert.equal(states.at(-1).dropped, true);
});

test("switching panes leaves the old one, and its late messages draw nothing", () => {
  const { view, sent, receive, term } = setup();
  view.show("a");
  view.show("b");
  assert.deepEqual(sent.slice(-2), [["detach", "a"], ["attach", "b", { cols: 100, rows: 30 }]]);
  receive({ type: "pty-data", pane_id: "a", data: "stale" });
  assert.ok(!term().written.includes("stale"));
  assert.equal(view.show("b"), true);
  assert.deepEqual(sent.at(-1), ["resume"], "showing the same pane again reconnects a paused socket");
});

test("a new socket starts the pane from a clean screen", () => {
  const { view, sent, reconnect, term } = setup();
  view.show("a");
  const resets = term().resets;
  reconnect();
  assert.equal(term().resets, resets + 1);
  assert.deepEqual(sent.at(-1), ["attach", "a", { cols: 100, rows: 30 }]);
});

test("a pane that cannot attach falls back, for good only when it never can", async () => {
  const { view, receive, fallbacks } = setup();
  view.show("remote");
  receive({ type: "attach-unavailable", pane_id: "remote", code: "attach_unsupported" });
  assert.deepEqual(fallbacks, ["remote"]);
  assert.equal(view.show("remote"), false);

  const realNow = Date.now;
  try {
    view.show("busy");
    receive({ type: "attach-unavailable", pane_id: "busy", code: "busy" });
    assert.equal(view.show("busy"), false, "not again at once");
    const later = realNow() + 6_000;
    Date.now = () => later;
    assert.equal(view.show("busy"), true, "tried again later");
    receive({ type: "pty-exit", pane_id: "busy", code: 0 });
    assert.equal(view.show("busy"), false, "an ended attach is tried again later, too");
    assert.equal(view.show("remote"), false);
  } finally {
    Date.now = realNow;
  }
});

test("a page that does not set the size shows the other page's grid and never asks for that grid as its own", async () => {
  const { view, sent, receive, classes, term } = setup();
  view.show("a");
  receive({ type: "pane-geometry", pane_id: "a", cols: 160, rows: 50, owner: false });
  assert.equal(term().cols, 160);
  assert.ok(classes.has("is-adopted"));
  await sleep(120);
  assert.ok(!sent.some(([kind, , cols]) => kind === "resize" && cols === 160));
  receive({ type: "pane-geometry", pane_id: "a", cols: 100, rows: 30, owner: true });
  assert.ok(!classes.has("is-adopted"));
  assert.equal(term().cols, 100, "once it sets the size, it fits its own frame");
});

test("typing while the socket reconnects is reported, and waits for the pane to attach again", () => {
  const { view, sent, receive, reconnect, states, connection, term } = setup();
  view.show("a");
  receive({ type: "input-ready", pane_id: "a" });
  connection.online = false;
  term().type("lost");
  assert.equal(states.at(-1).dropped, true);
  connection.online = true;
  term().type("still waiting");
  assert.ok(!sent.some(([kind]) => kind === "input"), "nothing until the pane is ready again");
  reconnect();
  receive({ type: "input-ready", pane_id: "a" });
  term().type("ok");
  assert.deepEqual(sent.filter(([kind]) => kind === "input"), [["input", "a", "ok"]]);
});
