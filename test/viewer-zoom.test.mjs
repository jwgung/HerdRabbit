import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SCALE, clampPan, zoomAt } from "../public/app/viewer-zoom.js";

const size = { width: 400, height: 300 };
const start = { scale: 1, x: 0, y: 0 };

test("zooming keeps the spot under the fingers where it was", () => {
  // 2x about a point 100px right of the middle: that spot was at +100 and
  // would be drawn at +200, so the picture moves 100px left to keep it at +100.
  assert.deepEqual(zoomAt(start, 2, { x: 100, y: 0 }, size), { scale: 2, x: -100, y: 0 });
  // About the middle, nothing moves.
  assert.deepEqual(zoomAt(start, 3, { x: 0, y: 0 }, size), { scale: 3, x: 0, y: 0 });
});

test("zoom stays between the picture's own size and 8x", () => {
  assert.equal(zoomAt(start, 0.2, { x: 0, y: 0 }, size).scale, 1);
  assert.equal(zoomAt(start, 50, { x: 0, y: 0 }, size).scale, MAX_SCALE);
  // Back at its own size it is back in the middle, wherever it was dragged.
  assert.deepEqual(zoomAt({ scale: 2, x: -150, y: 90 }, 1, { x: 30, y: 30 }, size), { scale: 1, x: 0, y: 0 });
});

test("a zoomed picture cannot be dragged past its edges", () => {
  // At 2x a 400px-wide picture is 800px: 200px may go off each side.
  assert.deepEqual(clampPan({ scale: 2, x: 500, y: -500 }, size), { scale: 2, x: 200, y: -150 });
  assert.deepEqual(clampPan({ scale: 2, x: -120, y: 40 }, size), { scale: 2, x: -120, y: 40 });
});
