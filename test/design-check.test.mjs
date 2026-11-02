import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { designViolations, stylesheets } from "../scripts/check-design.mjs";

const rules = (css, file = "public/styles.css") => designViolations(css, file).map((v) => `${v.line} ${v.rule}`);

test("a literal color is a break, in a value or a fallback; an id selector is not", () => {
  assert.deepEqual(rules(".a { color: #fff; }\n.b { background: rgb(0 0 0 / 30%); }\n.c { color: var(--accent, #99ffe4); }"),
    ["1 color", "2 color", "3 color"]);
  assert.deepEqual(rules("#add-menu .x, .y:not(#bad) { color: var(--text); background: color-mix(in srgb, var(--danger) 15%, transparent); }"), []);
  assert.deepEqual(rules("/* #ffffff in a comment */ .a { color: currentColor; }"), []);
});

test("font sizes come from the scale; em only in the chat's markdown and the prompt card", () => {
  assert.deepEqual(rules(".a { font-size: 12px; }\n.b { font-size: 0.85rem; }\n.c { font-size: calc(15px * var(--chat-scale, 1)); }"),
    ["1 font-size", "2 font-size", "3 font-size"]);
  assert.deepEqual(rules(".a { font-size: var(--font-sm); }\n.b { font-size: calc(var(--font-lg) * var(--chat-scale, 1)); }\n.c { font-size: inherit; }"), []);
  assert.deepEqual(rules(".a { font-size: 0.86em; }"), ["1 font-size"]);
  assert.deepEqual(rules(".a { font-size: 0.86em; }", "public/chat/prompt-card.css"), []);
});

test("radii come from the scale; 0 and a circle need none", () => {
  assert.deepEqual(rules(".a { border-radius: 7px; }\n.b { border-top-left-radius: 3px; }"), ["1 radius", "2 radius"]);
  assert.deepEqual(rules(".a { border-radius: var(--radius-sm); }\n.b { border-radius: 0; }\n.c { border-radius: 50%; }\n.d { border-radius: var(--radius-control) 0 0 var(--radius-control); }"), []);
});

test("layers are tokens, with an order inside one; a reset to 0 is not a layer", () => {
  assert.deepEqual(rules(".a { z-index: var(--layer-toast) !important; }"), []);
  assert.deepEqual(rules(".a { z-index: 25; }\n.b { z-index: calc(25 + 1); }"), ["1 z-index", "2 z-index"]);
  assert.deepEqual(rules(".a { z-index: var(--layer-popover); }\n.b { z-index: calc(var(--layer-pane-chrome) + 2); }\n.c { z-index: calc(var(--layer-drag) - 1); }\n.d { z-index: 0; }"), []);
});

test("a shadow is a token; a ring, a glow or a bar is a line, not a shadow", () => {
  assert.deepEqual(rules(".a { box-shadow: 0 6px 18px var(--mobile-shadow); }\n.b { box-shadow: var(--shadow-float), 0 2px 4px var(--scrim); }"), ["1 shadow", "2 shadow"]);
  assert.deepEqual(rules([
    ".a { box-shadow: var(--shadow-popover); }",
    ".b { box-shadow: inset 0 0 0 1px var(--selected-border); }",
    ".c { box-shadow: 0 0 12px var(--online-glow); }",
    ".d { box-shadow: inset 3px 0 0 var(--accent); }",
    ".e { box-shadow: inset 0 -2px 0 var(--accent); }",
    ".f { box-shadow: none; }",
    ".g { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent); }",
  ].join("\n")), []);
});

test("transition times are tokens; a zero delay and the reduced-motion override are not motion", () => {
  assert.deepEqual(rules(".a { transition: opacity 140ms ease; }\n.b { transition-duration: 0.2s; }"), ["1 motion", "2 motion"]);
  assert.deepEqual(rules(".a { transition: opacity var(--motion-base) ease, visibility 0s linear var(--sidebar-motion); }\n.b { transition-duration: 0.01ms !important; }"), []);
});

test("an endless animation does not step", () => {
  assert.deepEqual(rules(".a { animation: blink 1s steps(2) infinite; }\n.b { animation: blink 1s STEPS(2) INFINITE; }"), ["1 animation", "2 animation"]);
  assert.deepEqual(rules(".a { animation: spin 0.9s linear infinite; }\n.b { animation: once 1s steps(4) 1; }"), []);
});

test("a token of another kind is a break, and so is a literal in another case or unit", () => {
  assert.deepEqual(rules(".a { font-size: var(--space-2); }\n.b { z-index: var(--font-sm); }\n.c { box-shadow: var(--mobile-shadow); }\n.d { border-radius: var(--layer-raised); }\n.e { transition: opacity var(--radius-sm); }"),
    ["1 font-size", "2 z-index", "3 shadow", "4 radius", "5 motion"]);
  assert.deepEqual(rules(".a { font-size: 12PX; }\n.b { font-size: 120%; }\n.c { border-radius: 1em; }\n.d { transition: opacity .2S; }"),
    ["1 font-size", "2 font-size", "3 radius", "4 motion"]);
});

test("declarations inside @media and custom properties are read too", () => {
  assert.deepEqual(rules("@media (hover: none) {\n  .a { font-size: 16px; }\n}\n:root { --accent-2: #abc; }"), ["2 font-size", "4 color"]);
});

test("only the reduced-motion override escapes the motion rule with !important", () => {
  assert.deepEqual(rules(".a { transition: opacity 300ms !important; }"), ["1 motion"]);
});

test("a literal fallback is a break; the chat's scale is not a size on its own", () => {
  assert.deepEqual(rules(".a { font-size: var(--font-sm, 12px); }\n.b { border-radius: var(--radius-sm, 7px); }\n.c { font-size: var(--chat-scale); }"),
    ["1 font-size", "2 radius", "3 font-size"]);
  assert.deepEqual(rules(".a { z-index: var(--layer-raised, 5); }\n.b { box-shadow: var(--shadow-popover, 0 6px 18px var(--scrim)); }\n.c { font-size: var(--font-sm, var(--font-xs, 12px)); }"),
    ["1 z-index", "2 shadow", "3 font-size"]);
});

test("a \"/*\" inside a string does not hide what follows", () => {
  assert.deepEqual(rules('.a { content: "/*"; }\n.b { color: #fff; }'), ["2 color"]);
  // a stray quote ends at its line; a later comment is still a comment
  assert.deepEqual(rules(".a { content: it's; }\n/* .b { color: #fff; } */\n.c { color: #000; }"), ["3 color"]);
});

test("long runs of digits and unclosed comments do not stall the check", () => {
  for (const css of [
    `.a { box-shadow: 0 ${"9".repeat(20000)} 1px var(--scrim); font-size: ${"1".repeat(20000)}; }`,
    `.a { box-shadow: 0 ${"9".repeat(20000)}x 1px var(--scrim); }`,
    `.a { box-shadow: 0 ${"9".repeat(20000)}. 1px var(--scrim); }`,
    "/*x".repeat(20000),
    ".a { color: #fff; }\n".repeat(20000),
    `.a { font-size: ${"var(--a, ".repeat(10000)}12px${")".repeat(10000)}; }`,
  ]) {
    const started = performance.now();
    designViolations(css, "public/styles.css");
    assert.ok(performance.now() - started < 1000, `linear in the input's length (${css.slice(0, 20)}…)`);
  }
});

test("line numbers count past comments that span lines", () => {
  assert.deepEqual(rules("/* one\n two\n three */\n.a { color: #000; }"), ["4 color"]);
});

test("every stylesheet the app ships follows the rules", async () => {
  const files = await stylesheets();
  assert.ok(files.includes("public/styles.css") && files.includes("public/chat/chat-view.css"), "found by walking public/");
  assert.ok(!files.includes("public/ui/tokens.css"), "the tokens are where the values live");
  const breaks = [];
  for (const file of files) breaks.push(...designViolations(await readFile(new URL(`../${file}`, import.meta.url), "utf8"), file));
  assert.deepEqual(breaks, []);
});
