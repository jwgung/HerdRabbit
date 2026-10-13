import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decideSwipe } from "../public/swipe-dismiss.js";

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
