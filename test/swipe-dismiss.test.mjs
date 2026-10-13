import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { attachSwipeDismiss, decideSwipe, DRAG_CLICK_WINDOW } from "../public/swipe-dismiss.js";

const box = { width: 360, height: 60 };

test("a short sideways drag snaps back, a long one dismisses toward the drag", () => {
  assert.deepEqual(decideSwipe({ dx: 60, dy: 2, ...box }), { dismiss: false, direction: null });
  assert.deepEqual(decideSwipe({ dx: 130, dy: 0, ...box }), { dismiss: true, direction: "right" });
  assert.deepEqual(decideSwipe({ dx: -130, dy: 0, ...box }), { dismiss: true, direction: "left" });
  assert.equal(decideSwipe({ dx: 125, dy: 0, ...box }).dismiss, false, "just under 35% of the width");
});

test("a fast flick dismisses a short drag, but only in the direction of travel", () => {
  assert.deepEqual(decideSwipe({ dx: -50, vx: -0.9, ...box }), { dismiss: true, direction: "left" });
  assert.equal(decideSwipe({ dx: -50, vx: 0.9, ...box }).dismiss, false, "flicked back the other way");
  assert.equal(decideSwipe({ dx: -10, vx: -2, ...box }).dismiss, false, "a twitch is not a flick");
});

test("up dismisses the alert at the top; down never does", () => {
  assert.deepEqual(decideSwipe({ dx: 3, dy: -30, ...box }), { dismiss: true, direction: "up" });
  assert.equal(decideSwipe({ dx: 3, dy: -10, ...box }).dismiss, false);
  assert.deepEqual(decideSwipe({ dy: -40, vy: -1, ...box }), { dismiss: true, direction: "up" });
  assert.equal(decideSwipe({ dx: 3, dy: 200, vy: 2, ...box }).dismiss, false);
});

test("the in-app alert is wired for swiping", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(app, /attachSwipeDismiss\(appAlert/);
  assert.match(app, /appAlertSwipe\.consumedClick\(\)/);
  assert.match(css, /\.app-alert \{[^}]*touch-action: none/);
  assert.match(css, /--swipe-x/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.app-alert\.leaving/);
  assert.match(css, /\.pane-title-text \{\s*align-self: baseline/, "the title text sets the header baseline");
});

// Just enough of an element for attachSwipeDismiss: listeners, classes, style.
function fakeAlert() {
  const listeners = new Map();
  const classes = new Set();
  const props = new Map();
  return {
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)) },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), opacity: "" },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ width: 360, height: 60, bottom: 70 }),
    classes,
  };
}

function drag(element, dx, clock) {
  const base = { pointerType: "touch", isPrimary: true, pointerId: 1, clientY: 20 };
  element.fire("pointerdown", { ...base, clientX: 100 });
  clock.t += 50;
  element.fire("pointermove", { ...base, clientX: 100 + dx });
  clock.t += 50;
  element.fire("pointerup", { ...base, clientX: 100 + dx });
}

test("only the click right after a drag is swallowed", () => {
  globalThis.window ??= { innerWidth: 400 };
  const clock = { t: 0 };
  const element = fakeAlert();
  const swipe = attachSwipeDismiss(element, { onDismiss() {}, now: () => clock.t });
  drag(element, 20, clock);
  assert.ok(!element.classes.has("leaving"), "a short drag snaps back");
  assert.equal(swipe.consumedClick(), true, "the click after a snap-back is the drag's own");
  assert.equal(swipe.consumedClick(), false, "a second tap opens the pane");

  drag(element, 20, clock);
  clock.t += DRAG_CLICK_WINDOW + 1;
  assert.equal(swipe.consumedClick(), false, "a drag that ended with no click does not eat a later tap");

  drag(element, 20, clock);
  swipe.reset();
  assert.equal(swipe.consumedClick(), false, "a new alert forgets the old drag");
});

test("a new alert shown mid-leave is not hidden by the old swipe", async () => {
  globalThis.window ??= { innerWidth: 400 };
  const clock = { t: 0 };
  const element = fakeAlert();
  let dismissed = 0;
  const swipe = attachSwipeDismiss(element, { onDismiss: () => dismissed++, now: () => clock.t });
  drag(element, 200, clock);
  assert.ok(element.classes.has("leaving"));
  swipe.reset();
  element.fire("transitionend");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(dismissed, 0);

  drag(element, 200, clock);
  element.fire("transitionend");
  element.fire("transitionend");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(dismissed, 1, "a finished leave dismisses once");
});

test("a new alert drops a drag begun on the old one", () => {
  globalThis.window ??= { innerWidth: 400 };
  const clock = { t: 0 };
  const element = fakeAlert();
  let dismissed = 0;
  const swipe = attachSwipeDismiss(element, { onDismiss: () => dismissed++, now: () => clock.t, reducedMotion: () => true });
  const base = { pointerType: "touch", isPrimary: true, pointerId: 1, clientY: 20 };
  element.fire("pointerdown", { ...base, clientX: 100 });
  element.fire("pointermove", { ...base, clientX: 300 });
  swipe.reset();
  element.fire("pointerup", { ...base, clientX: 300 });
  assert.equal(dismissed, 0);
  assert.equal(swipe.consumedClick(), false);
});

test("a reduced-motion dismiss still swallows its click", () => {
  globalThis.window ??= { innerWidth: 400 };
  const clock = { t: 0 };
  const element = fakeAlert();
  let dismissed = 0;
  const swipe = attachSwipeDismiss(element, { onDismiss: () => dismissed++, now: () => clock.t, reducedMotion: () => true });
  drag(element, 200, clock);
  assert.equal(dismissed, 1);
  assert.equal(swipe.consumedClick(), true);
});
