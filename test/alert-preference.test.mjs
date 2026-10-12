import test from "node:test";
import assert from "node:assert/strict";
import { readAlertSound, writeAlertSound } from "../public/alert-preference.js";

test("alert sound is on until turned off, and survives broken storage", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readAlertSound(storage), true);
  writeAlertSound(storage, false);
  assert.equal(readAlertSound(storage), false);
  writeAlertSound(storage, true);
  assert.equal(readAlertSound(storage), true);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readAlertSound(broken), true);
  assert.doesNotThrow(() => writeAlertSound(broken, false));
  assert.equal(readAlertSound(null), true);
});
