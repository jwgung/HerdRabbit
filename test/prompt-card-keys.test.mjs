// Keys pressed on the page while a prompt card waits.
import test from "node:test";
import assert from "node:assert/strict";
import { cardKey } from "../public/chat/prompt-card.js";

test("a key pressed off any text box goes to the card's pane as the terminal would take it", () => {
  const fallback = { fallback: true, options: [] };
  const question = { options: [{ label: "A" }] };
  assert.equal(cardKey(fallback, { key: "Enter" }), "enter");
  assert.equal(cardKey(question, { key: "Escape" }), "esc");
  assert.equal(cardKey(fallback, { key: "ArrowDown" }), "down");
  assert.equal(cardKey(fallback, { key: "2" }), "2");
  assert.equal(cardKey(fallback, { key: "y" }), "y");
  // digits and letters only on a screen shown as is: a parsed card is answered by its numbers
  assert.equal(cardKey(question, { key: "2" }), null);
  // never in a text box or on a button, with a modifier, mid-composition, or without a card
  assert.equal(cardKey(fallback, { key: "Enter", typingTarget: true }), null);
  assert.equal(cardKey(fallback, { key: "Enter", ctrlKey: true }), null);
  assert.equal(cardKey(fallback, { key: "Enter", isComposing: true }), null);
  assert.equal(cardKey(null, { key: "Enter" }), null);
  assert.equal(cardKey(fallback, { key: "a" }), null);
});
