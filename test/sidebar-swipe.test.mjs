import assert from "node:assert/strict";
import test from "node:test";
import { decideSidebarSwipe } from "../public/app/sidebar-swipe.js";

test("a rightward drag from the left edge opens the closed sidebar", () => {
  assert.equal(decideSidebarSwipe({ open: false, startX: 4, dx: 90, dy: 10 }), "open");
  assert.equal(decideSidebarSwipe({ open: false, startX: 24, dx: 60, dy: 0 }), "open");
});

test("a quick short flick from the edge opens it, a slow short drag does not", () => {
  assert.equal(decideSidebarSwipe({ open: false, startX: 4, dx: 30, dy: 0, vx: 0.8 }), "open");
  assert.equal(decideSidebarSwipe({ open: false, startX: 4, dx: 30, dy: 0, vx: 0.1 }), null);
});

test("a drag that starts past the edge zone, or goes left, does not open it", () => {
  assert.equal(decideSidebarSwipe({ open: false, startX: 25, dx: 120, dy: 0 }), null);
  assert.equal(decideSidebarSwipe({ open: false, startX: 4, dx: -120, dy: 0 }), null);
});

test("a leftward drag anywhere on the open sidebar closes it", () => {
  assert.equal(decideSidebarSwipe({ open: true, startX: 200, dx: -90, dy: 5 }), "close");
  assert.equal(decideSidebarSwipe({ open: true, startX: 200, dx: -30, dy: 0, vx: -0.8 }), "close");
  assert.equal(decideSidebarSwipe({ open: true, startX: 200, dx: 120, dy: 0 }), null);
});

test("a mostly vertical drag is a scroll, not a swipe", () => {
  assert.equal(decideSidebarSwipe({ open: false, startX: 4, dx: 60, dy: 80 }), null);
  assert.equal(decideSidebarSwipe({ open: true, startX: 200, dx: -60, dy: 80 }), null);
  assert.equal(decideSidebarSwipe({ open: true, startX: 200, dx: -20, dy: 0 }), null);
});
