import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const styles = (await Promise.all(["../public/ui/components.css", "../public/styles.css"].map(
  path => readFile(new URL(path, import.meta.url), "utf8"),
))).join("\n");
const page = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const app = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

function cssPixels(pattern, label) {
  const match = styles.match(pattern);
  assert.ok(match, `${label} CSS value must exist`);
  return Number(match[1]);
}

test("this machine's dot says whether the page is connected, instead of a footer dot", () => {
  // One dot for this machine, not two that mostly agree.
  assert.doesNotMatch(page, /id="connection-status"|id="connection-dot"/u);
  const set = app.match(/function setConnection\(kind, text\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(set, "setConnection must exist");
  assert.match(set, /state\.connection = \{ kind, text \};/u);
  assert.match(set, /\.server-heading\[data-server-id="local"\]/u);
  // The rule is serverConnectionState (ui-model.js, tested in nav-model.test.mjs); the in-place update and the redraw both read it.
  assert.match(app, /function serverConnection\(server\) \{\s*return serverConnectionState\(server, state\.connection\);/u);
  assert.match(app, /const connection = node\.connection;/u);
  assert.match(styles, /\.server-heading\.is-error \.server-icon \{ stroke: var\(--danger\); \}/u);
  // The rail keeps the footer's two controls (uploads, and settings with
  // Update), stacked in the rail's width, instead of hiding the footer.
  assert.match(styles, /body\.sidebar-collapsed \.navigator-footer \{\s*flex-direction: column;/u);
  assert.doesNotMatch(styles, /body\.sidebar-collapsed \.navigator-footer \{\s*display: none;/u);
  // The footer's two controls sit at opposite ends: uploads at the start, settings at the end.
  assert.match(styles, /:is\(\.navigator-footer, \.ui-sidebar-footer\) \{[^}]*justify-content: space-between;/u);
  assert.match(styles, /\.navigator \.navigator-footer \{\s*grid-row: 4;\s*justify-content: space-between;\s*\}/u);
});

test("slides the collapsed sidebar by its own width, not a fixed distance", () => {
  for (const pattern of [
    /body\.sidebar-collapsed \.navigator \{[\s\S]*?var\(--navigator-width/,
    /body\.sidebar-collapsed \.terminal-panel \{[\s\S]*?var\(--navigator-width/,
    /body\.sidebar-collapsed \.shell \{[\s\S]*?var\(--navigator-width/,
    /\.shell \{[\s\S]*?grid-template-columns: var\(--navigator-width/,
  ]) {
    assert.match(styles, pattern);
  }
});

test("uses the same fillable Herdr icon to toggle the sidebar", () => {
  assert.equal((page.match(/id="sidebar-toggle"/g) || []).length, 1);
  assert.doesNotMatch(page, /sidebar-toggle-symbol/);
  assert.match(page, /class="sidebar-toggle-mark"/);
  assert.match(
    styles,
    /\.sidebar-toggle:hover \.sidebar-toggle-mark path,[\s\S]*?fill: currentColor/,
  );
  assert.match(page, /class="mobile-sidebar-mark"/);
  assert.doesNotMatch(page, /M5 7h14M5 12h14M5 17h14/);
  assert.match(
    styles,
    /\.mobile-sidebar-open:hover \.mobile-sidebar-mark path,[\s\S]*?fill: currentColor/,
  );
});

test("shows the server row even when this machine is the only one", () => {
  // The row's menu is how a machine is managed, AI accounts included, so it
  // cannot wait for a second machine to be linked.
  // Every machine listed gets its row (navigationModel; test/nav-model.test.mjs), this one alone included.
  assert.match(app, /for \(const node of tree\.servers\) \{\s*const server = node\.record;/u);
  assert.match(app, /label: "AI accounts"[\s\S]*?onSelect: \(\) => showAiAccounts\(server\)/);
  // Herdr SSH machines are gone: nothing adds, renames, turns off or removes one.
  assert.doesNotMatch(app, /\/api\/machines|#add-machine|transport === "machine"/u);
  assert.doesNotMatch(page, /Add SSH machine|id="machine-dialog"/u);
});

test("a server's menu lines up with the project menus under it", () => {
  // Both headings end at the list's edge; right padding on one pushed its
  // menu inside the other's.
  // A zero is written without a unit, so the unit is optional on every value.
  const project = styles.match(/\.workspace-heading \{[^}]*padding: \d+(?:px)? (\d+)(?:px)?[ ;]/u);
  const server = styles.match(/\.server-heading \{ display: flex; align-items: center; gap: 8px; padding: \d+(?:px)? (\d+)(?:px)?[ ;]/u);
  assert.ok(project && server, "project and server headings must set their padding");
  assert.equal(server[1], project[1]);
});

test("the file tree shares the session list's skeleton", () => {
  // No box of its own, and out to the session list's edges.
  assert.match(styles, /\.browse-tree \{\s*padding: 4px 0;\s*\}/u);
  assert.equal(
    cssPixels(/\.file-panel \.browse-tree \{\s*margin: 0 -(\d+)px;/u, "tree pull"),
    cssPixels(/\.file-panel \{[^}]*padding: 0 (\d+)px/u, "panel padding"),
  );
  // A top-level arrow centres where a server heading's does: half its 28px button.
  // The twisty has one width for every pointer; a narrower one for the mouse
  // sat before the base rule and never applied.
  assert.equal((styles.match(/\.browse-twisty-gap \{/gu) || []).length, 1, "one twisty width");
  const twisty = cssPixels(/\.browse-twisty \{[^}]*width: (\d+)px;/u, "twisty");
  assert.equal(cssPixels(/\.browse-row \{[^}]*padding: 0 0 0 (\d+)px;/u, "row inset") + twisty / 2, 28 / 2);
  assert.doesNotMatch(styles, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.browse-row \{[^}]*padding/u, "one inset for every pointer");
  // On touch a row's buttons are always shown and nothing pads the row, so the
  // buttons set its height: 26px, not the 34px a 30px button with padding made.
  assert.equal(cssPixels(/\.browse-row \.transfer-row-actions button \{\s*width: \d+px;\s*height: (\d+)px;/u, "touch row button"), 26);
  // A level steps as far as a session level, on touch and with a mouse alike.
  assert.equal((styles.match(/\.browse-indent \{/gu) || []).length, 1, "one indent for every pointer");
  assert.equal(
    cssPixels(/\.browse-indent \{\s*width: (\d+)px;/u, "indent") +
      cssPixels(/\.browse-lead \{\s*display: flex;\s*align-items: center;\s*gap: (\d+)px;/u, "lead gap"),
    cssPixels(/\.server-body \{ padding-left: (\d+)px; \}/u, "session step"),
  );
  assert.doesNotMatch(styles, /\.browse-lead \{\s*gap:/u, "no second gap that the later rule silently overrides");
  // Names and colours are a session button's.
  assert.equal(
    cssPixels(/\.browse-row \.transfer-name \{\s*font-size: (\d+)px;/u, "file name size"),
    cssPixels(/:is\(\.pane-copy, \.ui-nav-copy\) strong \{[^}]*font-size: (\d+)px;/u, "session name size"),
  );
  assert.doesNotMatch(styles, /\.browse-row \.transfer-name \{\s*font-size: [\d.]+rem;/u);
  assert.match(styles, /\.browse-row:hover \{\s*background: var\(--surface-raised\);/u);
  assert.match(styles, /:is\(\.pane-button, \.ui-nav-item\):hover \{\s*background: var\(--surface-raised\);/u);
  assert.match(styles, /\.browse-row\[data-selected="true"\] \{\s*background: var\(--selected-surface\);\s*box-shadow: inset 0 0 0 1px var\(--selected-border\);/u);
  assert.match(styles, /\.browse-row \{[^}]*border-radius: var\(--radius-control\);/u);
  // Arrows and row buttons are a session heading's: the same arrow, and a
  // button drawn only under the pointer.
  const sessionArrow = styles.match(/\.workspace-action svg \{\s*width: (\d+)px;\s*height: \d+px;[^}]*stroke-width: ([\d.]+);/u);
  const fileArrow = styles.match(/\.browse-twisty svg \{\s*width: (\d+)px;\s*height: \d+px;[^}]*stroke-width: ([\d.]+);/u);
  assert.ok(sessionArrow && fileArrow, "both arrows must be sized");
  assert.deepEqual([fileArrow[1], fileArrow[2]], [sessionArrow[1], sessionArrow[2]]);
  assert.match(styles, /\.workspace-action \{[^}]*border: 1px solid transparent;[^}]*background: transparent;\s*color: var\(--muted\);/u);
  assert.match(styles, /\.browse-row \.transfer-row-actions button \{[^}]*border: 1px solid transparent;\s*border-radius: 7px;\s*background: transparent;\s*color: var\(--muted\);/u);
  assert.match(styles, /\.workspace-action:hover \{\s*border-color: var\(--line\);\s*background: var\(--surface-raised\);\s*color: var\(--control-text\);/u);
  assert.match(styles, /\.browse-row \.transfer-row-actions button:hover \{\s*border-color: var\(--line\);\s*background: var\(--surface-raised\);\s*color: var\(--control-text\);/u);
  assert.equal(
    cssPixels(/\.browse-row \.transfer-row-actions button svg \{\s*width: (\d+)px;/u, "row button icon"),
    Number(sessionArrow[1]),
  );
});

test("a folder opens with a project's arrow button and animation", () => {
  // The same button: drawn only under the pointer.
  assert.match(styles, /\.browse-twisty \{\s*border: 1px solid transparent;\s*border-radius: 7px;\s*background: transparent;\s*color: var\(--muted\);/u);
  assert.match(styles, /\.browse-twisty:hover \{\s*border-color: var\(--line\);\s*background: var\(--surface-raised\);\s*color: var\(--control-text\);/u);
  // The same turn of the arrow and the same slide of the rows.
  const turn = (selector) => styles.match(new RegExp(`${selector} svg \\{[^}]*transition: ([^;]+);`, "u"))?.[1];
  assert.equal(turn("\\.browse-twisty"), turn("\\.workspace-collapse"));
  const slide = (selector) => styles.match(new RegExp(`${selector} \\{\\s*min-height: 0;\\s*display: grid;\\s*grid-template-rows: 1fr;\\s*opacity: 1;\\s*transition:([^;]+);`, "u"))?.[1];
  assert.ok(slide("\\.workspace-children"), "projects slide open");
  assert.equal(slide("\\.browse-children"), slide("\\.workspace-children"));
  assert.match(styles, /\.browse-children\.is-collapsed \{\s*grid-template-rows: 0fr;\s*opacity: 0;/u);
  assert.match(app, /const BROWSE_FOLD_MS = 180;/u);
  // Opening and closing change only that folder's rows, or nothing could animate.
  const toggle = app.match(/async function toggleBrowseFolder\(path\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(toggle, "toggleBrowseFolder must exist");
  assert.match(toggle, /children\.classList\.add\("is-collapsed"\);[\s\S]*?window\.setTimeout\([\s\S]*?BROWSE_FOLD_MS\);\s*return;/u);
  assert.match(toggle, /row\.after\(children\);\s*\/\/[^\n]*\n\s*children\.getBoundingClientRect\(\);/u);
  assert.match(toggle, /children\.classList\.remove\("is-collapsed"\);\s*\}$/u);
});

test("the path to type sits at the foot of Files, with its suggestions opening up", () => {
  const panel = page.match(/<div id="file-panel"[\s\S]*?\n {10}<\/div>/u)?.[0];
  assert.ok(panel, "file panel must exist");
  const order = ["file-server", "file-tree", "file-feedback", "file-path"].map((id) => panel.indexOf(`id="${id}"`));
  assert.ok(order.every((at) => at >= 0), "every part of the panel is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // Hidden files are always listed, so there is no switch for them.
  assert.doesNotMatch(page, /file-hidden|Show hidden/u);
  assert.doesNotMatch(app, /fileHidden|entry\.hidden/u);
  assert.match(styles, /\.file-panel \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;/u);
  assert.match(styles, /\.file-suggestions \{[^}]*bottom: calc\(100% \+ 4px\);/u);
  assert.doesNotMatch(styles.match(/\.file-path-row \{[^}]*\}/u)[0], /overflow: hidden/u, "the row cannot clip the list it anchors");
});

test("on touch, heading rows are as short as rows in Files and session rows stay easy to press", () => {
  const touch = styles.match(/@media \(hover: none\) \{\s*\.workspace-action \{ height: (\d+)px; \}\s*\.workspace-heading \{ min-height: (\d+)px; padding-block: 0; \}\s*\.herdr-session-heading \{ height: (\d+)px; \}\s*\.server-heading \{ padding-block: 0; \}\s*\.session-action-menu \{ top: 8px; \}\s*\}/u);
  assert.ok(touch, "touch heading rows must be shortened");
  const row = cssPixels(/\.browse-row \.transfer-row-actions button \{\s*width: \d+px;\s*height: (\d+)px;/u, "file row");
  assert.deepEqual([touch[1], touch[2], touch[3]].map(Number), [row, row, row]);
  // A session row is a touch target: 40px at least, with or without a folder line.
  assert.ok(cssPixels(/\.pane-button \{ min-height: (\d+)px;/u, "session row height") >= 40);
  // Later than the rules it shortens, or they would win.
  for (const rule of [/\.server-heading \{ display: flex;/u, /\.workspace-heading \{\s*min-width: 0;/u, /\.herdr-session-heading \{\s*min-width: 0;/u]) {
    assert.ok(styles.search(rule) < styles.search(/@media \(hover: none\) \{\s*\.workspace-action \{ height/u));
  }
});

test("the collapsed rail leaves machines out", () => {
  // The rail is for jumping between sessions; a machine's icon there led nowhere.
  assert.match(styles, /body\.sidebar-collapsed :is\(\.server-heading, \.server-empty\) \{ display: none; \}/u);
  assert.doesNotMatch(styles, /body\.sidebar-collapsed[^{]*\.server-(icon|dot)/u, "nothing left to size or animate");
  assert.equal((styles.match(/body\.sidebar-collapsed[^{]*\.server-heading/gu) || []).length, 1, "one rule for the machine row in the rail");
});

test("the collapsed rail lines session markers up under the server's dot", () => {
  // Expanded, rows are indented under their server and Herdr session headings;
  // in the rail those headings are gone, so the indent must go too.
  assert.match(styles, /body\.sidebar-collapsed :is\(\.server-body, \.herdr-session-body, \.workspace-children-inner\) \{ padding-left: 0; \}/u);
});

test("the sidebar steps in one even level at a time, like the file tree", () => {
  // Every heading starts at the list's edge, so the indent under a heading is
  // the whole distance from its arrow to its children's.
  assert.match(styles, /\.server-heading \{ display: flex; align-items: center; gap: 8px; padding: \d+px 0; \}/u);
  assert.match(styles, /\.herdr-session-heading \{[^}]*padding: 0 \d+px 0 0;/u);
  assert.match(styles, /\.workspace-heading \{[^}]*padding: \d+px 0;/u);
  const step = 10;
  assert.equal(cssPixels(/\.server-body \{ padding-left: (\d+)px; \}/u, "server indent"), step);
  assert.equal(cssPixels(/\.herdr-session-body \{\s*padding-left: (\d+)px;/u, "session indent"), step);
  // A session's marker centres 1px border + 10px padding + half an 18px marker
  // in; a heading's arrow, half a 28px button. The rows make up the difference.
  const project = cssPixels(/\.workspace-children-inner \{[^}]*padding-left: (\d+)px;/u, "project indent");
  assert.equal(project + 1 + 10 + 18 / 2, 28 / 2 + step);
});

test("removes the empty heading action slot when the sidebar is collapsed", () => {
  assert.match(
    styles,
    /body\.sidebar-collapsed \.navigator-heading-actions \{[\s\S]*?display: none/,
  );
});

test("keeps sidebar scrolling without visible scrollbars or horizontal overflow", () => {
  assert.match(
    styles,
    /\.navigator-content \{[\s\S]*?overflow-x: hidden;[\s\S]*?scrollbar-width: none;/,
  );
  assert.match(
    styles,
    /\.navigator-content::\-webkit-scrollbar \{[\s\S]*?width: 0;[\s\S]*?height: 0;/,
  );
  assert.match(
    styles,
    /body\.sidebar-collapsed \.pane-copy \{[\s\S]*?display: none;/,
  );
});

test("session rows carry no status border; the status is a mark at the far right", () => {
  assert.match(app, /button\.dataset\.status = currentAgentStatus/);
  assert.match(app, /group\.dataset\.hasCompletion/);
  // Nothing colours a row's border or glow by status; selection is a soft background.
  assert.doesNotMatch(styles, /\.(pane-button|ui-nav-item)\)?\[data-status=/u);
  assert.doesNotMatch(styles, /completion-glow\)/u);
  assert.match(styles, /:is\(\.pane-button, \.ui-nav-item\)\[aria-pressed="true"\] \{\s*background: var\(--selected-surface\);\s*\}/u);
  // the status is Herdr's text symbol, coloured by the shared .ui-status.state-* rules
  assert.match(app, /className: `pane-status ui-status state-\$\{currentAgentStatus\}`/u);
  assert.match(app, /text: agentStatusIcon\(currentAgentStatus\)/u);
  assert.doesNotMatch(styles, /pane-spin|pane-pulse|data-kind="spinner"/u);
  assert.match(
    styles,
    /\.workspace-group\.is-collapsed\[data-has-completion="true"\] > \.workspace-heading/,
  );
});

test("machine rows show a monitor, a Host label for this PC and a connection dot", () => {
  assert.match(app, /className: "server-role", text: "Host"/u);
  assert.match(app, /className: "server-dot"/u);
  assert.match(styles, /\.server-heading\.is-online \.server-dot \{ background: var\(--status-ok\); \}/u);
});
