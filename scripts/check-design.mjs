// The machine-checkable rules of docs/design.md, over every stylesheet the app
// ships: colors, font sizes, spacing, radii, layers, shadows and transition times come
// from the tokens in public/ui/tokens.css, and an endless animation does not
// step. Run directly, it prints each break as file:line and exits 1.
// Spacing (padding, margin, gap) comes from the --space-* steps too; a
// calc() of the layout's own variables is geometry and is left alone.
// Not checked: touch sizes, named colors (`white`), the `font` shorthand,
// and `transition-delay` / `animation-*` times.
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
const SPACE_LENGTH = new RegExp(String.raw`(?<![\w.-])(-?)(${NUMBER})(?:px|rem|em)(?![\w-])`, "giu");
const SHADOW_LENGTH = new RegExp(String.raw`(?<![\w.-])-?${NUMBER}(?:px|rem|em)?(?![\w%.])`, "giu");

// The custom properties each kind of value may come from. A font size may
// also be multiplied by the chat's scale, which is not a size on its own.
const TOKENS = {
  "font-size": /^--(?:font-[\w-]+|terminal-font-size|composer-font-size|chat-font-size)$/u,
  radius: /^--radius-[\w-]+$/u,
  "z-index": /^--layer-[\w-]+$/u,
  shadow: /^--shadow-[\w-]+$/u,
  motion: /^--(?:motion-[\w-]+|sidebar-motion|sidebar-ease)$/u,
  spacing: /^--space-[\w-]+$/u,
};
const SPACING = /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)*$/u;

// A value with its calc() / min() / max() / clamp() groups taken out.
function withoutMath(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const fn = value.slice(i).match(/^(?:calc|min|max|clamp)\(/iu);
    if (fn) {
      let open = 0;
      for (; i < value.length; i += 1) {
        if (value[i] === "(") open += 1;
        else if (value[i] === ")" && --open === 0) break;
      }
      out += "math";
      continue;
    }
    out += value[i];
  }
  return out;
}

// Comments out, line breaks kept, so a match's offset still gives its line.
// One pass, and a "/*" inside a quoted string is text, not a comment.
function stripComments(css) {
  let out = "";
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (quote) {
      if (char === "\\") { out += css.slice(i, i + 2); i += 1; continue; }
      // a string ends at its quote, or (unclosed) at the end of the line
      if (char === quote || char === "\n") quote = null;
      out += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/gu, " ");
      i = stop - 1;
    } else {
      out += char;
    }
  }
  return out;
}

// Each var(...) in a value replaced by the word "var", nested parentheses and
// all, so what is left is the value's own literals. The names come back too,
// and the literal part of any fallback (var(--x, 12px) falls back to 12px).
// Fallbacks are followed 16 levels deep; one nested deeper is reported as such.
function splitVars(value, depth = 0) {
  let bare = "";
  let fallbacks = "";
  const names = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value.startsWith("var(", i)) {
      const start = i;
      let open = 0;
      for (; i < value.length; i += 1) {
        if (value[i] === "(") open += 1;
        else if (value[i] === ")" && --open === 0) break;
      }
      const inner = value.slice(start + 4, i);
      const name = inner.match(/^\s*(--[\w-]+)/u)?.[1] ?? "";
      names.push(name);
      const comma = inner.indexOf(",");
      if (comma !== -1) {
        if (depth >= 16) names.push("--too-deep");
        else {
          const fallback = splitVars(inner.slice(comma + 1), depth + 1);
          names.push(...fallback.names);
          fallbacks += ` ${fallback.bare} ${fallback.fallbacks}`;
        }
      }
      bare += "var";
      continue;
    }
    bare += value[i];
  }
  return { bare, names, fallbacks };
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
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const violations = [];
  const report = (index, rule, detail) => violations.push({ file, line: lineOf(index), rule, detail });
  // a var() of the wrong kind is as much a break as a literal
  const wrongTokens = (names, kind, index, rule) => {
    for (const name of names) if (!TOKENS[kind].test(name)) report(index, rule, `var(${name}) is not a ${kind} token`);
  };

  for (const { property, value, index } of declarations(text)) {
    for (const color of value.match(COLOR) ?? []) report(index, "color", `${color} is not a color token`);
    const { bare: own, names, fallbacks } = splitVars(value);
    const bare = `${own} ${fallbacks}`;
    if (property === "font-size") {
      const sizes = names.filter((name) => name !== "--chat-scale");
      if (FONT_LENGTH.test(bare)) report(index, "font-size", `${value} is not a --font-* token`);
      else if (EM.test(bare)) { if (!EM_ALLOWED.has(file)) report(index, "font-size", `${value}: em only inside the chat's markdown and the prompt card`); }
      else if (names.length > 0 && sizes.length === 0) report(index, "font-size", "var(--chat-scale) scales a size; it is not one");
      wrongTokens(sizes, "font-size", index, "font-size");
    } else if (/^border(?:-[a-z]+)*-radius$/u.test(property)) {
      if (RADIUS_LENGTH.test(bare)) report(index, "radius", `${value} is not a --radius-* token`);
      wrongTokens(names, "radius", index, "radius");
    } else if (property === "z-index") {
      // a layer, an order inside one ("var + 2" once the var is out), or a reset
      const layer = own.replace(/\s+/gu, "").replace(/!important$/iu, "");
      if (!/^(?:0|auto|var|calc\(var[+-]\d+\))$/u.test(layer) || /\d/u.test(fallbacks)) report(index, "z-index", `${value} is not a --layer-* token`);
      wrongTokens(names, "z-index", index, "z-index");
    } else if (property === "box-shadow") {
      for (const part of splitTopLevel(value.replace(/!important\s*$/iu, ""))) {
        const lone = part.match(/^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/u);
        if (lone) {
          wrongTokens([lone[1]], "shadow", index, "shadow");
          if (/\d/u.test(lone[2] ?? "")) report(index, "shadow", `${part}: a token takes no literal fallback`);
        } else if (!isLineShadow(part)) {
          report(index, "shadow", `${part} is not a --shadow-* token`);
        }
      }
    } else if (SPACING.test(property)) {
      // 0 and a 1px nudge for a border are not steps; geometry in calc() is the layout's
      const top = splitVars(withoutMath(value));
      for (const match of `${top.bare} ${top.fallbacks}`.matchAll(SPACE_LENGTH)) {
        if (Number.parseFloat(match[2]) > 1) report(index, "spacing", `${match[0]} is not a --space-* token`);
      }
      wrongTokens(top.names, "spacing", index, "spacing");
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

  // A pseudo-element inside :is() or :where() is not allowed there: the
  // browser drops it from the list without a word, and its styles with it.
  for (const rule of text.matchAll(/(?:^|[{};])([^{};]*):(?:is|where)\(/gu)) {
    const start = rule.index + rule[0].length - 1;
    let open = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") open += 1;
      else if (text[end] === ")" && --open === 0) break;
    }
    if (text.slice(start, end).includes("::")) report(start, "selector", "a pseudo-element inside :is()/:where() is dropped; list it on its own");
  }

  // An endless animation that steps looks like a stuck screen.
  for (const block of text.matchAll(/\{[^{}]*\}/gu)) {
    if (/\bsteps\(/iu.test(block[0]) && /\binfinite\b/iu.test(block[0])) {
      report(block.index + block[0].search(/steps\(/iu), "animation", "an endless animation does not use steps()");
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
