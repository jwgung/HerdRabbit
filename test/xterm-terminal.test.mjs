import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// Only as much of a browser as the module touches.
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.ResizeObserver = class { observe() {} };
// Frames never come: the link underlines are not drawn here.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { createAttachedTerminal, mirrorFrame } = await import("../public/xterm-terminal.js");

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
    this.buffer = { active: { viewportY: 0, baseY: 0 } };
    // The private hook the page overrides, as xterm 5.5 has it.
    const coreService = { inputs: [], triggerDataEvent(data, wasUserInput) { this.inputs.push([data, wasUserInput]); } };
    this._core = {
      _selectionService: { shouldForceSelection: (event) => event.shiftKey },
      coreService,
      coreMouseService: { triggerMouseEvent: () => { coreService.triggerDataEvent("\x1b[<35;1;1M", true); return true; } },
    };
    this.element = {
      querySelector: () => ({
        offsetHeight: 480, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
        ownerDocument: { createElement: () => ({ append() {}, replaceChildren() {} }) }, append() {},
      }),
      dispatchEvent: () => true,
    };
  }
  loadAddon(addon) { addon.term = this; }
  open() {}
  registerLinkProvider() {}
  attachCustomKeyEventHandler() {}
  attachCustomWheelEventHandler(handler) { this.wheelHandler = handler; }
  onSelectionChange(listener) { this.selectionListeners = [...(this.selectionListeners ?? []), listener]; }
  select(col, row, length) { this.selection = "x".repeat(length); for (const listener of this.selectionListeners ?? []) listener(); }
  getSelection() { return this.selection ?? ""; }
  clearSelection() { this.selection = ""; for (const listener of this.selectionListeners ?? []) listener(); }
  onData(listener) { this.listeners.data.push(listener); }
  onBinary() {}
  onResize(listener) { this.listeners.resize.push(listener); }
  onScroll(listener) { this.scrollListeners = [...(this.scrollListeners ?? []), listener]; }
  scrollTo(viewportY, baseY = this.buffer.active.baseY) {
    this.buffer.active = { ...this.buffer.active, viewportY, baseY };
    for (const listener of this.scrollListeners ?? []) listener(viewportY);
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    for (const listener of this.listeners.resize) listener({ cols, rows });
  }
  onRender() {}
  reset() { this.resets += 1; }
  write(data, done = () => {}) { if (data === "\x1bc") this.resets += 1; this.written.push(data); this.pending.push(done); }
  finishWrites() { for (const done of this.pending.splice(0)) done(); }
  type(data) { for (const listener of this.listeners.data) listener(data); }
  hasSelection() { return Boolean(this.selection); }
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
  const element = () => {
    const children = [];
    const listeners = {};
    return {
      hidden: false, children, listeners, style: {}, setAttribute() {},
      append: (...items) => children.push(...items),
      contains: (item) => children.includes(item),
      addEventListener: (type, listener) => { listeners[type] = listener; },
      click() { listeners.click?.(); },
    };
  };
  const body = element();
  const ownerDocument = {
    createElement: (tag) => Object.assign(element(), tag === "textarea" ? { select() { this.selected = true; }, remove() { this.removed = true; } } : {}),
    body,
    execCommand: (command) => { ownerDocument.executed.push(command); return ownerDocument.copyWorks; },
    executed: [],
    copyWorks: true,
  };
  const host = {
    ...element(), ownerDocument,
    hidden: true, clientWidth: 800, clientHeight: 400,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), remove: (name) => classes.delete(name) },
  };
  const fallbacks = [];
  const states = [];
  const retries = [];
  const copies = [];
  let term;
  const view = createAttachedTerminal({
    host, connection, fontSize: 12,
    xterm: { Terminal: class extends Terminal { constructor(options) { super(options); term = this; } }, FitAddon, UnicodeGraphemesAddon, WebLinksAddon },
    onFallback: (paneId) => fallbacks.push(paneId),
    onStateChange: (state) => states.push(state),
    onRetry: (paneId) => retries.push(paneId),
    onCopy: (ok) => copies.push(ok),
  });
  const receive = (message) => { for (const listener of listeners.attach) listener(message); };
  const reconnect = () => { for (const listener of listeners.reconnect) listener(); };
  return { view, sent, host, body, ownerDocument, classes, fallbacks, states, retries, copies, receive, reconnect, connection, term: () => term };
}

test("shows a pane at the frame's size, writes only its stream, and acknowledges once xterm has drawn it", () => {
  const { view, sent, host, receive, term } = setup();
  assert.equal(view.show("a"), true);
  assert.equal(host.hidden, false);
  assert.deepEqual(sent.at(-1), ["attach", "a", { cols: 100, rows: 30 }]);
  receive({ type: "pty-data", pane_id: "a", data: "screen", flow: { stream_id: "s", offset: 6 } });
  receive({ type: "pty-data", pane_id: "b", data: "another pane" });
  assert.deepEqual(term().written, ["\x1bc", "screen"], "a clean screen, then the pane's stream only");
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

test("a pane that failed for now asks to be shown again once its wait is over", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { view, receive, retries } = setup();
  view.show("a");
  receive({ type: "pty-exit", pane_id: "a", code: 0 });
  context.mock.timers.tick(4_000);
  assert.deepEqual(retries, []);
  context.mock.timers.tick(2_000);
  assert.deepEqual(retries, ["a"]);
  assert.equal(view.show("a"), true, "and it attaches then");
  receive({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
  context.mock.timers.tick(60_000);
  assert.deepEqual(retries, ["a"], "a pane that can never attach is not tried again");
});

test("a pane mirrored after a passing attach error attaches again once its wait is over, and the mirror ends", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { view, sent, host, receive, fallbacks, retries, term } = setup();
  view.show("a");
  receive({ type: "attach-error", pane_id: "a", code: "attach_failed" });
  assert.deepEqual(fallbacks, ["a"]);
  assert.equal(view.show("a"), false, "while the wait lasts the page mirrors it");
  assert.equal(view.mirror("a", "$ polled"), true);
  term().finishWrites();
  assert.ok(term().options.scrollback > 0);

  context.mock.timers.tick(5_100);
  assert.deepEqual(retries, ["a"]);
  const before = sent.length;
  assert.equal(view.show("a"), true, "the retry attaches the same pane");
  assert.deepEqual(sent.slice(before), [["attach", "a", { cols: 100, rows: 30 }]]);
  assert.equal(host.hidden, false);
  assert.equal(term().options.scrollback, 0, "herdr owns the scrollback again");
  assert.equal(view.mirror("a", "$ late poll"), false, "a poll that lands after the attach draws nothing");
  assert.notEqual(term().written.at(-1), mirrorFrame("$ late poll"));
});

test("a write that finishes after the page moved to another pane acknowledges nothing", () => {
  const { view, sent, receive, term } = setup();
  view.show("a");
  receive({ type: "pty-data", pane_id: "a", data: "screen", flow: { stream_id: "s", offset: 6 } });
  view.show("b");
  term().finishWrites();
  assert.ok(!sent.some(([kind]) => kind === "ack"));
});

test("output still being drawn when the socket reconnects is cleared and acknowledges nothing", () => {
  const { view, sent, receive, reconnect, term } = setup();
  view.show("a");
  receive({ type: "pty-data", pane_id: "a", data: "old", flow: { stream_id: "s1", offset: 3 } });
  reconnect();
  receive({ type: "pty-data", pane_id: "a", data: "new", flow: { stream_id: "s2", offset: 3 } });
  term().finishWrites();
  const written = term().written;
  assert.ok(written.indexOf("\x1bc", written.indexOf("old")) > written.indexOf("old"), "the reset comes after the old output, in the same queue");
  assert.ok(written.indexOf("new") > written.lastIndexOf("\x1bc"));
  assert.deepEqual(sent.filter(([kind]) => kind === "ack"), [["ack", "a", "s2", 3]]);
});

test("Ctrl+wheel stays on the page to size the font, and a selection offers a Copy button", async () => {
  const { view, host, copies, term } = setup();
  view.show("a");
  const wheel = term().wheelHandler;
  assert.equal(wheel({ ctrlKey: true, metaKey: false }), false, "xterm leaves Ctrl+wheel to the page");
  assert.equal(wheel({ ctrlKey: false, metaKey: true }), false);
  assert.equal(wheel({ ctrlKey: false, metaKey: false }), true, "a plain wheel still scrolls herdr");
  const bar = host.children.find((child) => child.className === "terminal-copy-bar");
  assert.equal(bar.hidden, true);
  term().select(0, 0, 5);
  assert.equal(bar.hidden, false, "shown over a selection");
  const written = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { written.push(text); } } } });
  try {
    const [copy] = bar.children;
    copy.click();
    await sleep(0);
  } finally {
    Object.defineProperty(globalThis, "navigator", original);
  }
  assert.deepEqual(written, ["xxxxx"]);
  assert.deepEqual(copies, [true]);
  assert.equal(bar.hidden, true, "gone once copied");
  term().select(0, 0, 2);
  bar.children[1].click();
  assert.equal(term().hasSelection(), false, "Cancel lets go of the selection");
});

test("a plain left drag selects text instead of reaching the program; other buttons keep xterm's own rule", () => {
  const { view, term } = setup();
  view.show("a");
  const forced = term()._core._selectionService.shouldForceSelection;
  assert.equal(forced({ button: 0, shiftKey: false }), true);
  assert.equal(forced({ button: 2, shiftKey: false }), false, "a right click still goes to the program");
  assert.equal(forced({ button: 2, shiftKey: true }), true, "Shift still forces it, as in xterm");
});

test("a mouse report reaches the program without counting as typing, so a selection survives the mouse moving", () => {
  const { view, term } = setup();
  view.show("a");
  const { coreService, coreMouseService } = term()._core;
  assert.equal(coreMouseService.triggerMouseEvent({}), true);
  coreService.triggerDataEvent("x", true);
  assert.deepEqual(coreService.inputs, [["\x1b[<35;1;1M", false], ["x", true]]);
});

test("the pinned xterm bundle still has the selection hook the page overrides", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile(new URL("../public/vendor/xterm.mjs", import.meta.url), "utf8");
  assert.match(bundle, /shouldForceSelection\(e\)\{return/u);
  assert.match(bundle, /this\._selectionService\.shouldForceSelection\(/u);
  // Mouse reports go out as typing, which clears the selection; the page marks them otherwise.
  assert.match(bundle, /triggerMouseEvent\(e\)\{/u);
  assert.match(bundle, /this\._coreService\.triggerDataEvent\(t,!0\)/u);
  assert.match(bundle, /this\._coreService\.onUserInput\(\(\)=>\{this\.hasSelection&&this\.clearSelection\(\)\}\)/u);
});

test("over plain HTTP the copy falls back to the copy command and leaves nothing behind", async () => {
  const { view, host, body, ownerDocument, copies, term } = setup();
  view.show("a");
  const bar = host.children.find((child) => child.className === "terminal-copy-bar");
  term().select(0, 0, 3);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("insecure"); } } } });
  try {
    bar.children[0].click();
    await sleep(0);
    ownerDocument.copyWorks = false;
    term().select(0, 0, 3);
    bar.children[0].click();
    await sleep(0);
  } finally {
    Object.defineProperty(globalThis, "navigator", original);
  }
  assert.deepEqual(ownerDocument.executed, ["copy", "copy"]);
  assert.deepEqual(copies, [true, false], "a copy that did not work says so");
  assert.ok(body.children.every((scratch) => scratch.selected && scratch.removed), "each scratch field was used and removed");
});

test("a held finger selects as it moves, a moving one scrolls, two fingers or a pane change cancel the hold", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.WheelEvent ??= class { constructor(type, init) { Object.assign(this, init, { type }); } };
  const { view, host, term } = setup();
  host.getBoundingClientRect = () => ({ top: 0 });
  host.dispatchEvent = () => true;
  view.show("a");
  const bar = host.children.find((child) => child.className === "terminal-copy-bar");
  const target = (() => {
    const listeners = {};
    return { addEventListener: (type, listener) => { listeners[type] = listener; }, fire: (type, event) => listeners[type]?.(event) };
  })();
  const touches = (...points) => points.map(([clientX, clientY]) => ({ clientX, clientY }));
  const event = (...points) => ({ target, touches: touches(...points), preventDefault() {} });
  const start = (...points) => host.listeners.touchstart(event(...points));

  // 800x480 screen, 100x30 grid: cells are 8 by 16 pixels.
  start([20, 40]);
  context.mock.timers.tick(450);
  assert.equal(term().hasSelection(), true, "held still: selecting from that cell");
  target.fire("touchmove", event([100, 40]));
  assert.equal(term().getSelection().length, 11, "cells 2 to 12 of the row");
  assert.equal(bar.hidden, true, "no bar while the finger is down");
  target.fire("touchend", { type: "touchend", touches: [] });
  assert.equal(bar.hidden, false, "the bar once it lifts");

  start([20, 40]);
  assert.equal(term().hasSelection(), false, "a new touch lets go of the selection");
  target.fire("touchmove", event([20, 80]));
  context.mock.timers.tick(450);
  assert.equal(term().hasSelection(), false, "a finger that moved scrolls, it does not select");
  target.fire("touchend", { type: "touchend", touches: [] });

  start([20, 40]);
  start([20, 40], [200, 200]);
  context.mock.timers.tick(450);
  assert.equal(term().hasSelection(), false, "a second finger is a pinch");
  target.fire("touchend", { type: "touchend", touches: [] });

  start([20, 40]);
  view.show("b");
  context.mock.timers.tick(450);
  assert.equal(term().hasSelection(), false, "the hold ends with the pane");
});

test("a mirrored screen is redrawn whole, with every line break returning to the first column", () => {
  assert.equal(mirrorFrame("one\ntwo\r\nthree\n"), "\x1b[0m\x1b[3J\x1b[H\x1b[2Jone\r\ntwo\r\nthree");
  assert.equal(mirrorFrame(""), "\x1b[0m\x1b[3J\x1b[H\x1b[2J");
  assert.equal(mirrorFrame(null), "\x1b[0m\x1b[3J\x1b[H\x1b[2J");
  // Colours in the polled text are passed through for xterm to draw.
  assert.equal(mirrorFrame("\x1b[32mok\x1b[0m\n\n"), "\x1b[0m\x1b[3J\x1b[H\x1b[2J\x1b[32mok\x1b[0m\r\n");
});

test("a mirror fits its own frame even after following another page's grid", () => {
  const { view, receive, classes, term } = setup();
  view.show("a");
  receive({ type: "pane-geometry", pane_id: "a", cols: 160, rows: 50, owner: false });
  assert.equal(term().cols, 160);
  receive({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
  assert.equal(view.mirror("a", "text"), true);
  assert.ok(!classes.has("is-adopted"));
  assert.equal(term().cols, 100);
  assert.equal(term().rows, 30);
});

test("a mirror keeps a scrollback to read back through, and holds new frames while the reader is scrolled up", () => {
  const { view, receive, term } = setup();
  view.show("a");
  assert.equal(term().options.scrollback, 0, "an attached pane scrolls in herdr");
  receive({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
  view.mirror("a", "one");
  term().finishWrites();
  assert.ok(term().options.scrollback >= 200, "the polled lines above the screen can be scrolled back to");

  term().scrollTo(10, 40);
  const written = term().written.length;
  view.mirror("a", "two");
  view.mirror("a", "three");
  assert.equal(term().written.length, written, "nothing is redrawn under a reader scrolled up");
  term().scrollTo(20, 40);
  assert.equal(term().written.length, written);
  term().scrollTo(40, 40);
  assert.equal(term().written.at(-1), mirrorFrame("three"), "back at the bottom, only the newest frame is drawn");
  assert.equal(term().written.length, written + 1);

  view.show("b");
  assert.equal(term().options.scrollback, 0);
});

test("frames that come faster than xterm draws them collapse to the newest", () => {
  const { view, receive, term } = setup();
  view.show("a");
  receive({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
  term().finishWrites();
  view.mirror("a", "one");
  const written = term().written.length;
  for (const text of ["two", "three", "four"]) view.mirror("a", text);
  assert.equal(term().written.length, written, "nothing more is queued while a frame is drawing");
  term().finishWrites();
  assert.deepEqual(term().written.slice(written - 1), [mirrorFrame("one"), mirrorFrame("four")]);
  term().finishWrites();
  assert.equal(term().written.length, written + 1);
});

test("a pane that cannot attach is mirrored read-only, and attaching again takes over the screen", () => {
  const { view, sent, host, receive, fallbacks, term } = setup();
  view.show("a");
  receive({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
  assert.deepEqual(fallbacks, ["a"]);
  assert.equal(host.hidden, true, "nothing is on screen until the mirror draws");
  assert.equal(view.show("a"), false);

  assert.equal(view.mirror("a", "$ ls\nfile"), true);
  assert.equal(host.hidden, false);
  assert.equal(term().written.at(-1), mirrorFrame("$ ls\nfile"));
  assert.equal(term().written.at(-2), "\x1bc", "the attach's modes are reset before the first frame");
  const resets = term().resets;
  term().finishWrites();
  view.mirror("a", "$ ls\nfile\n$");
  assert.equal(term().resets, resets, "later frames redraw without a reset");
  assert.equal(term().written.at(-1), mirrorFrame("$ ls\nfile\n$"));

  // Keystrokes in the mirror reach nothing; the page's composer sends instead.
  const before = sent.length;
  term().type("x");
  receive({ type: "input-ready", pane_id: "a" });
  term().type("y");
  assert.deepEqual(sent.slice(before).filter(([kind]) => kind === "input"), []);

  // Another pane that can attach replaces the mirror.
  assert.equal(view.show("b"), true);
  assert.deepEqual(sent.at(-1), ["attach", "b", { cols: 100, rows: 30 }]);
  assert.equal(view.mirror("b", "text"), false, "an attached pane is never overdrawn by polled text");
  // No pane at all hides the terminal.
  view.show(null);
  assert.equal(host.hidden, true);
  view.mirror("a", "again");
  view.show(null);
  assert.equal(host.hidden, true);
});

