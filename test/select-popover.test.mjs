import assert from "node:assert/strict";
import test from "node:test";
import { stepIndex, typeAheadIndex } from "../public/app/select-popover.js";

const options = ["Alpha", "Apple", "Beta", "Gamma"].map((label, i) => ({ label, disabled: i === 2 }));

test("arrow steps skip disabled options and stop at the ends", () => {
  assert.equal(stepIndex(options, 1, 1), 3);
  assert.equal(stepIndex(options, 3, 1), 3);
  assert.equal(stepIndex(options, 0, -1), 0);
  assert.equal(stepIndex(options, -1, 1), 0);
  assert.equal(stepIndex(options, options.length, -1), 3);
});

test("type-ahead cycles on one letter, holds on a longer word, and skips disabled options", () => {
  assert.equal(typeAheadIndex(options, 0, "a"), 1);
  assert.equal(typeAheadIndex(options, 1, "a"), 0);
  assert.equal(typeAheadIndex(options, 1, "ap"), 1);
  assert.equal(typeAheadIndex(options, 0, "b"), -1);
  assert.equal(typeAheadIndex(options, 0, "g"), 3);
});
