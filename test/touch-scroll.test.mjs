import test from "node:test";
import assert from "node:assert/strict";
import { createTouchScroller } from "../public/touch-scroll.js";

function setup() {
  let time = 0;
  const frames = [];
  const notches = [];
  const scroller = createTouchScroller({
    step: () => 30,
    emit: (direction) => notches.push(direction),
    now: () => time,
    frame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => { frames.length = 0; },
  });
  const advance = (ms) => { time += ms; };
  const runFrames = (count, ms = 16) => {
    for (let i = 0; i < count && frames.length; i += 1) {
      advance(ms);
      frames.shift()();
    }
  };
  return { scroller, notches, frames, advance, runFrames };
}

test("the history follows the finger: one notch per step of travel, the rest carried over", () => {
  const { scroller, notches, advance } = setup();
  scroller.start(500);
  for (const y of [490, 480, 470, 460]) { advance(16); scroller.move(y); }
  assert.deepEqual(notches, [1], "40 px upward is one 30 px notch, 10 px kept");
  advance(16); scroller.move(440);
  assert.deepEqual(notches, [1, 1]);
  advance(16); scroller.move(520);
  assert.deepEqual(notches, [1, 1, -1, -1], "moving down turns the other way");
});

test("a flick keeps scrolling and slows down; a finger that stopped first does not", () => {
  const { scroller, notches, frames, advance, runFrames } = setup();
  scroller.start(800);
  for (let y = 760; y >= 560; y -= 40) { advance(16); scroller.move(y); }
  const during = notches.length;
  scroller.end();
  assert.equal(frames.length, 1, "a glide starts");
  runFrames(400);
  assert.ok(notches.length > during, "it kept going after the finger lifted");
  assert.equal(frames.length, 0, "and came to a stop");

  const still = setup();
  still.scroller.start(800);
  for (let y = 760; y >= 560; y -= 40) { still.advance(16); still.scroller.move(y); }
  still.advance(300);
  still.scroller.end();
  assert.equal(still.frames.length, 0);
});

test("a new touch stops a glide at once", () => {
  const { scroller, frames, advance, runFrames, notches } = setup();
  scroller.start(800);
  for (let y = 760; y >= 560; y -= 40) { advance(16); scroller.move(y); }
  scroller.end();
  runFrames(2);
  scroller.start(300);
  const count = notches.length;
  runFrames(50);
  assert.equal(frames.length, 0);
  assert.equal(notches.length, count);
});
