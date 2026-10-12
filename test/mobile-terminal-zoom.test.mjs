import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const terminalSource = await readFile(new URL("../public/xterm-terminal.js", import.meta.url), "utf8");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("a two-finger pinch sizes the font on the xterm terminal, the only terminal view", () => {
  // The screen-text view and its own pinch handler are gone; every pane,
  // attached or mirrored, is drawn by xterm, which takes the pinch itself.
  assert.match(terminalSource, /if \(pinch && event\.touches\.length === 2\) \{\s+event\.preventDefault\(\);/u);
  assert.match(terminalSource, /if \(pinch\.size !== pinch\.start\) onFontSizeChange\(pinch\.size\);/u);
  assert.match(appSource, /onFontSizeChange: applyTerminalFontSize,/u);
  assert.doesNotMatch(appSource, /terminalOutput/u);
});
