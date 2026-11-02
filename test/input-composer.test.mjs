import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readAppSource } from "./app-source.mjs";

const appSource = await readAppSource();
const page = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../public/styles.css", import.meta.url),
  "utf8",
);

test("grows the terminal composer without measuring layout inside the input event", () => {
  const scheduledResizeSource = appSource.match(
    /function scheduleTerminalInputResize\(\) \{[\s\S]*?\n\}\n\nfunction touchDistance/,
  )?.[0] || "";
  assert.match(page, /id="terminal-input"[\s\S]*?rows="1"/);
  assert.match(styles, /\.input-form textarea \{[\s\S]*?max-height: calc\(7\.5em \+ 24px\)/);
  assert.match(styles, /\.input-form textarea \{[\s\S]*?resize: none/);
  assert.match(styles, /\.input-form textarea \{[\s\S]*?field-sizing: content/);
  assert.match(styles, /\.input-form textarea \{[\s\S]*?overflow-y: auto/);
  assert.match(appSource, /function supportsNativeTerminalInputSizing\(\)/);
  assert.match(appSource, /function resizeTerminalInput\(\)/);
  assert.match(appSource, /function scheduleTerminalInputResize\(\)/);
  assert.match(
    appSource,
    /terminalInput\.addEventListener\("input", \(\) => \{[\s\S]*?scheduleTerminalInputResize\(\)/,
  );
  assert.doesNotMatch(
    appSource,
    /terminalInput\.addEventListener\("input", \(\) => \{\s+resizeTerminalInput\(\)/,
  );
  assert.match(
    appSource,
    /if \(usesTouchInputEnvironment\(\)\) \{\s+resizeTerminalInput\(\);\s+\} else \{[\s\S]*?scheduleTerminalInputResize\(\)/,
  );
  assert.match(appSource, /const COMPOSER_RESIZE_DELAY_MS = 300/);
  assert.match(
    appSource,
    /window\.setTimeout\([\s\S]*?COMPOSER_RESIZE_DELAY_MS\)/,
  );
  assert.doesNotMatch(
    scheduledResizeSource,
    /refreshOutput\(\)/,
  );
  // Typing must not hold back terminal output: the composer is a separate
  // element, so re-rendering the terminal does not disturb it.
  assert.doesNotMatch(appSource, /composerActive/);
  assert.match(appSource, /contentHeight > nextHeight \? "auto" : "hidden"/);
});

test("puts the caret in the composer on desktop load and pane switching", () => {
  assert.match(appSource, /function focusComposer\(\) \{\s+if \(!desktopMedia\.matches \|\| usesTouchInputEnvironment\(\) \|\|[\s\S]*?return;\s+elements\.terminalInput\.focus\(\{ preventScroll: true \}\);/);
  // Ctrl+Tab and Ctrl+1..9 activate the same pane button, so one call covers both.
  assert.match(
    appSource,
    /closeMobileSidebar\(\);\s+focusComposer\(\);/,
    "choosing a pane should leave the composer ready to type in",
  );
  assert.match(appSource, /void dismissDeliveredNotifications\(\);\s+focusComposer\(\);/);
  assert.match(
    appSource,
    /!state\.authenticated \|\| elements\.terminalInput\.disabled\) return;/,
    "the login screen keeps its own focus",
  );
});
