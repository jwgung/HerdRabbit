// Kiro has no prompt reader of its own: its pane is attached as a real
// terminal, so the approval or question it shows is already on screen, and the
// fallback card (parseFallbackPrompt, for any blocked pane) reads it and is
// answered by the same keys as the terminal. These tests check that a blocked
// Kiro pane's fallback card names Kiro, through the ASKERS entry in fallback.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFallbackPrompt } from "../src/prompt/fallback.mjs";

const labels = (card) => card?.options.map((option) => option.label);

test("a blocked Kiro pane gets a fallback card that speaks for Kiro by name", () => {
  const card = parseFallbackPrompt("Waiting\n\nContinue? (y/n)\n", { agent: "kiro" });
  assert.equal(card.agent, "kiro");
  assert.deepEqual(labels(card), ["Yes (y)", "No (n)", "Enter", "Esc"]);
});
