// Keys pressed on the page while a prompt card waits.
import test from "node:test";
import assert from "node:assert/strict";
import { cardKeyOption } from "../public/chat/prompt-card.js";

test("a key pressed off any text box answers the fallback card's button it names", () => {
  const card = { fallback: true, customOptionIndex: null, keyOptions: [3, 4, 5, 6, 7, 8, 9, 10],
    options: ["Staging", "Production", "Cancel", "↑", "↓", "←", "→", "Tab", "Space", "Enter", "Esc"].map((label) => ({ label })) };
  assert.equal(cardKeyOption(card, { key: "Enter" }), 9);
  assert.equal(cardKeyOption(card, { key: "Escape" }), 10);
  assert.equal(cardKeyOption(card, { key: "ArrowDown" }), 4);
  // a digit is the menu row it names, never a key button
  assert.equal(cardKeyOption(card, { key: "2" }), 1);
  assert.equal(cardKeyOption(card, { key: "5" }), null);
  // y and n only where the card has Yes (y) / No (n)
  assert.equal(cardKeyOption(card, { key: "y" }), null);
  const yesNo = { fallback: true, customOptionIndex: null, keyOptions: [2, 3], options: ["Yes (y)", "No (n)", "Enter", "Esc"].map((label) => ({ label })) };
  assert.equal(cardKeyOption(yesNo, { key: "Y" }), 0);
  assert.equal(cardKeyOption(yesNo, { key: "n" }), 1);
  // never in a text box or on a button, with a modifier, mid-composition (229 too)
  for (const extra of [{ typingTarget: true }, { ctrlKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(cardKeyOption(card, { key: "Enter", ...extra }), null, JSON.stringify(extra));
  }
  // a card a reader knows is answered from its buttons and the composer only
  assert.equal(cardKeyOption({ options: [{ label: "Yes" }, { label: "Enter" }] }, { key: "Enter" }), null);
  assert.equal(cardKeyOption(null, { key: "Enter" }), null);
  assert.equal(cardKeyOption(card, { key: "a" }), null);
});

test("a fallback card's key buttons are no numbered answer, and the composer's numbers skip them", async () => {
  const { composerPlaceholder, numberedChoice } = await import("../public/chat/prompt-card.js");
  const card = { fallback: true, customOptionIndex: null, keyOptions: [2, 3], options: [{ label: "Yes (y)" }, { label: "No (n)" }, { label: "Enter" }, { label: "Esc" }] };
  assert.equal(composerPlaceholder(card), "Type 1–2 to answer, or a message");
  assert.equal(numberedChoice(card, "2"), 1);
  assert.equal(numberedChoice(card, "3"), null);
  const keysOnly = { fallback: true, customOptionIndex: null, keyOptions: [0, 1], options: [{ label: "Enter" }, { label: "Esc" }] };
  assert.equal(composerPlaceholder(keysOnly), "");
  assert.equal(numberedChoice(keysOnly, "1"), null);
});
