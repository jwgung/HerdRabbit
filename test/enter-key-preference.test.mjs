import test from "node:test";
import assert from "node:assert/strict";
import {
  ENTER_KEY_MODES,
  ENTER_KEY_STORAGE_KEY,
  enterKeyModeHint,
  enterKeyModeName,
  looksLikePhysicalKey,
  readEnterKeyMode,
  writeEnterKeyMode,
} from "../public/enter-key-preference.js";

const physical = { isTrusted: true, key: "a", code: "KeyA", keyCode: 65, isComposing: false };

test("counts a letter or digit from a physical keyboard", () => {
  assert.equal(looksLikePhysicalKey(physical), true);
  assert.equal(looksLikePhysicalKey({ ...physical, key: "A", shiftKey: true }), true);
  assert.equal(looksLikePhysicalKey({ ...physical, key: "1", code: "Digit1", keyCode: 49 }), true);
  // A Korean layout typed without an input method still reports the physical code.
  assert.equal(looksLikePhysicalKey({ ...physical, key: "ㅁ", code: "KeyA" }), true);
});

test("does not count an on-screen keyboard", () => {
  // Android (Gboard and the like): keyCode 229, key Unidentified, no code.
  assert.equal(looksLikePhysicalKey({ isTrusted: true, key: "Unidentified", code: "", keyCode: 229, isComposing: false }), false);
  // iOS: a real key but an empty code.
  assert.equal(looksLikePhysicalKey({ isTrusted: true, key: "a", code: "", keyCode: 65, isComposing: false }), false);
  // An on-screen Enter is not evidence either.
  assert.equal(looksLikePhysicalKey({ isTrusted: true, key: "Enter", code: "Enter", keyCode: 13 }), false);
});

test("does not count an input method's composition", () => {
  assert.equal(looksLikePhysicalKey({ ...physical, isComposing: true }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, key: "Process", keyCode: 229 }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, keyCode: 229 }), false);
});

test("does not count shortcuts, named keys or synthetic events", () => {
  assert.equal(looksLikePhysicalKey({ ...physical, ctrlKey: true }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, metaKey: true }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, altKey: true }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, key: "Tab", code: "Tab", keyCode: 9 }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, key: " ", code: "Space", keyCode: 32 }), false);
  assert.equal(looksLikePhysicalKey({ ...physical, isTrusted: false }), false);
  assert.equal(looksLikePhysicalKey({ key: "a", code: "KeyA", keyCode: 65 }), false);
  assert.equal(looksLikePhysicalKey(null), false);
});

test("keeps the Enter mode per browser, and names and explains each choice", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readEnterKeyMode(storage), "auto");
  writeEnterKeyMode(storage, "send");
  assert.equal(store.get(ENTER_KEY_STORAGE_KEY), "send");
  assert.equal(readEnterKeyMode(storage), "send");
  writeEnterKeyMode(storage, "bogus");
  assert.equal(readEnterKeyMode(storage), "send");
  store.set(ENTER_KEY_STORAGE_KEY, "bogus");
  assert.equal(readEnterKeyMode(storage), "auto");
  // Edit keys offers the three as one choice, in this order, each with what it does.
  assert.deepEqual(ENTER_KEY_MODES, ["auto", "newline", "send"]);
  assert.deepEqual(ENTER_KEY_MODES.map(enterKeyModeName), ["Auto", "New line", "Send"]);
  assert.match(enterKeyModeHint("auto"), /physical keyboard/u);
  assert.match(enterKeyModeHint("newline"), /new line/u);
  assert.match(enterKeyModeHint("send"), /Shift\+Enter/u);
  assert.equal(enterKeyModeName("bogus"), "Auto");
});

test("survives storage that is missing or throws", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readEnterKeyMode(null), "auto");
  assert.equal(readEnterKeyMode(broken), "auto");
  assert.doesNotThrow(() => writeEnterKeyMode(broken, "send"));
  assert.doesNotThrow(() => writeEnterKeyMode(null, "send"));
});
