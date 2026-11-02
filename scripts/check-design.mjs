// The machine-checkable rules of docs/design.md, over every stylesheet the app
// ships: colors, font sizes, radii, layers, shadows and transition times come
// from the tokens in public/ui/tokens.css, and an endless animation does not
// step. Run directly, it prints each break as file:line and exits 1.
// Not checked: spacing, touch sizes, named colors (`white`), the `font`
// shorthand, and colors inside a data URL.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The tokens themselves, the catalog page's own layout, and the vendored
// terminal styles are not the app's to change.
const EXEMPT = new Set(["public/ui/tokens.css", "public/ui/examples.css", "public/vendor/xterm.css"]);
// Blocks that size their text from their own font size may use em.
const EM_ALLOWED = new Set(["public/chat/chat-view.css", "public/chat/prompt-card.css"]);

// One reading of a number, so a long run of digits cannot backtrack.
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/giu;
const FONT_LENGTH = new RegExp(String.raw`(?<![\w-])-?${NUMBER}(?:px|rem|pt|vw|vh|ch|ex|%)(?![\w-])`, "iu");
const RADIUS_LENGTH = new RegExp(String.raw`(?<![\w-])-?${NUMBER}(?:px|rem|em|pt)(?![\w-])`, "iu");
const EM = new RegExp(String.raw`(?<![\w-])${NUMBER}em(?![\w-])`, "iu");
const TIME = new RegExp(String.raw`(?<![\w-])${NUMBER}m?s(?![\w-])`, "giu");
const SHADOW_LENGTH = new RegExp(String.raw`-?${NUMBER}(?:px|rem|em)?(?![\w%.])`, "giu");

// The custom properties each kind of value may come from. A font size may
// also be multiplied by the chat's scale.
const TOKENS = {
  "font-size": /^--(?:font-[\w-]+|terminal-font-size|composer-font-size|chat-font-size|chat-scale)$/u,
  radius: /^--radius-[\w-]+$/u,
  "z-index": /^--layer-[\w-]+$/u,
  shadow: /^--shadow-[\w-]+$/u,
  motion: /^--(?:motion-[\w-]+|sidebar-motion|sidebar-ease)$/u,
};

// Comments out, line breaks kept, so a match's offset still gives its line.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

// Each var(...) in a value replaced by the word "var", nested parentheses and
// all, so what is left is the value's own literals. The names come back too.
function splitVars(value) {
  let bare = "";
  const names = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value.startsWith("var(", i)) {
      names.push(value.slice(i + 4).match(/^\s*(--[\w-]+)/u)?.[1] ?? "");
      let depth = 0;
      for (; i < value.length; i += 1) {
        if (value[i] === "(") depth += 1;
        else if (value[i] === ")" && --depth === 0) break;
      }
      bare += "var";
      continue;
    }
    bare += value[i];
  }
  return { bare, names };
}

// Top-level commas only: a shadow list, not the commas inside color-mix().
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "(") depth += 1;
    else if (value[i] === ")") depth -= 1;
    else if (value[i] === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// A shadow that draws a line rather than a shadow: a ring or glow (no offset)
// or a bar (no blur). One with neither length is a token's, or nothing.
function isLineShadow(part) {
  const lengths = splitVars(part).bare.replace(/\binset\b/giu, "").match(SHADOW_LENGTH) ?? [];
  const [x = 0, y = 0, blur = 0] = lengths.map((length) => Number.parseFloat(length));
  return (x === 0 && y === 0) || blur === 0;
}

// Every "property: value" inside a block. Text before a "{" is a selector or
// an at-rule, never a declaration, so an id in a selector is not a color.
function declarations(css) {
  const found = [];
  let start = 0;
  for (let i = 0; i <= css.length; i += 1) {
    const char = css[i];
    if (char === "{") start = i + 1;
    else if (char === ";" || char === "}" || i === css.length) {
      const text = css.slice(start, i);
      const colon = text.indexOf(":");
      if (colon > 0) {
        const property = text.slice(0, colon).trim().toLowerCase();
        const offset = start + text.length - text.trimStart().length;
        if (/^(?:--[\w-]+|-?[a-z][a-z-]*)$/u.test(property)) found.push({ property, value: text.slice(colon + 1).trim(), index: offset });
      }
      start = i + 1;
    }
  }
  return found;
}

export function designViolations(css, file) {
  const text = stripComments(css);
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const violations = [];
  const report = (index, rule, detail) => violations.push({ file, line: lineOf(index), rule, detail });
  // a var() of the wrong kind is as much a break as a literal
  const wrongTokens = (names, kind, index, rule) => {
    for (const name of names) if (!TOKENS[kind].test(name)) report(index, rule, `var(${name}) is not a ${kind} token`);
  };

  for (const { property, value, index } of declarations(text)) {
    for (const color of value.match(COLOR) ?? []) report(index, "color", `${color} is not a color token`);
    const { bare, names } = splitVars(value);
    if (property === "font-size") {
      if (FONT_LENGTH.test(bare)) report(index, "font-size", `${value} is not a --font-* token`);
      else if (EM.test(bare) && !EM_ALLOWED.has(file)) report(index, "font-size", `${value}: em only inside the chat's markdown and the prompt card`);
      wrongTokens(names, "font-size", index, "font-size");
    } else if (/^border(?:-[a-z]+)*-radius$/u.test(property)) {
      if (RADIUS_LENGTH.test(bare)) report(index, "radius", `${value} is not a --radius-* token`);
      wrongTokens(names, "radius", index, "radius");
    } else if (property === "z-index") {
      // a layer, an order inside one ("var + 2" once the var is out), or a reset
      if (!/^(?:0|auto|var|calc\(var[+-]\d+\))$/u.test(bare.replace(/\s+/gu, ""))) report(index, "z-index", `${value} is not a --layer-* token`);
      wrongTokens(names, "z-index", index, "z-index");
    } else if (property === "box-shadow") {
      for (const part of splitTopLevel(value)) {
        const lone = part.match(/^var\(\s*(--[\w-]+)\s*\)$/u)?.[1];
        if (lone) wrongTokens([lone], "shadow", index, "shadow");
        else if (!isLineShadow(part)) report(index, "shadow", `${part} is not a --shadow-* token`);
      }
    } else if (property === "transition" || property === "transition-duration") {
      // a zero delay is not motion; nor is the reduced-motion override, 0.01ms !important
      const important = /!important/iu.test(value);
      for (const time of bare.match(TIME) ?? []) {
        const ms = /ms$/iu.test(time) ? Number.parseFloat(time) : Number.parseFloat(time) * 1000;
        if (ms !== 0 && !(important && ms <= 0.01)) report(index, "motion", `${time} is not a --motion-* token`);
      }
      wrongTokens(names, "motion", index, "motion");
    }
  }

  // An endless animation that steps looks like a stuck screen.
  for (const block of text.matchAll(/\{[^{}]*\}/gu)) {
    if (/\bsteps\(/u.test(block[0]) && /\binfinite\b/u.test(block[0])) {
      report(block.index + block[0].indexOf("steps("), "animation", "an endless animation does not use steps()");
    }
  }
  return violations;
}

export async function stylesheets() {
  const entries = await readdir(join(root, "public"), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((file) => !EXEMPT.has(file))
    .sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = await stylesheets();
  const violations = [];
  for (const file of files) violations.push(...designViolations(await readFile(join(root, file), "utf8"), file));
  for (const { file, line, rule, detail } of violations) console.error(`${file}:${line} ${rule}: ${detail}`);
  if (violations.length > 0) {
    console.error(`${violations.length} design rule breaks; see docs/design.md`);
    process.exit(1);
  }
  console.log(`Design OK: ${files.length} stylesheets`);
}
