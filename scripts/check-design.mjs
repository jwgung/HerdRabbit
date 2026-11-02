// The machine-checkable rules of docs/design.md, over every stylesheet the app
// ships: colors, font sizes, radii, layers, shadows and transition times come
// from the tokens in public/ui/tokens.css, and an endless animation does not
// step. Run directly, it prints each break as file:line and exits 1.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The tokens themselves, the catalog page's own layout, and the vendored
// terminal styles are not the app's to change.
const EXEMPT = new Set(["public/ui/tokens.css", "public/ui/examples.css", "public/vendor/xterm.css"]);
// Blocks that size their text from their own font size may use em.
const EM_ALLOWED = new Set(["public/chat/chat-view.css", "public/chat/prompt-card.css"]);

const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/giu;
const LENGTH = /(?<![\w-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem)\b/u;
const TIME = /(?<![\w-])(?:\d+\.?\d*|\.\d+)m?s\b/gu;

// Comments out, line breaks kept, so a match's offset still gives its line.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

// var(...) out of a value, nested parentheses and all.
function withoutVars(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      for (; i < value.length; i += 1) {
        if (value[i] === "(") depth += 1;
        else if (value[i] === ")" && --depth === 0) break;
      }
      out += "var";
      continue;
    }
    out += value[i];
  }
  return out;
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
// or a bar (no blur). Anything else is a shadow and takes a --shadow-* token.
function isLineShadow(part) {
  const lengths = withoutVars(part).replace(/\binset\b/gu, "").match(/-?(?:\d+\.?\d*|\.\d+)(?:px)?(?![\w%])/gu) ?? [];
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
        if (/^-{0,2}[a-z][a-z-]*$/u.test(property)) found.push({ property, value: text.slice(colon + 1).trim(), index: offset });
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

  for (const { property, value, index } of declarations(text)) {
    for (const color of value.match(COLOR) ?? []) report(index, "color", `${color} is not a color token`);
    const bare = withoutVars(value);
    if (property === "font-size") {
      if (LENGTH.test(bare)) report(index, "font-size", `${value} is not a --font-* token`);
      else if (/\d\s*em\b/u.test(bare) && !EM_ALLOWED.has(file)) report(index, "font-size", `${value}: em only inside the chat's markdown and the prompt card`);
    } else if (/^border(?:-[a-z]+)*-radius$/u.test(property)) {
      if (LENGTH.test(bare)) report(index, "radius", `${value} is not a --radius-* token`);
    } else if (property === "z-index") {
      if (!/^(?:0|auto|var|calc\(var[+-]\d+\))$/u.test(bare.replace(/\s+/gu, ""))) {
        report(index, "z-index", `${value} is not a --layer-* token`);
      }
    } else if (property === "box-shadow") {
      if (bare !== "none" && bare !== "var") {
        for (const part of splitTopLevel(value)) {
          if (part !== "var" && !/^var\(--shadow-[\w-]+\)$/u.test(part) && !isLineShadow(part)) {
            report(index, "shadow", `${part} is not a --shadow-* token`);
          }
        }
      }
    } else if (property === "transition" || property === "transition-duration") {
      // a zero delay, and the reduced-motion override, are not motion
      if (/!important/u.test(value)) continue;
      for (const time of bare.match(TIME) ?? []) {
        if (Number.parseFloat(time) !== 0) report(index, "motion", `${time} is not a --motion-* token`);
      }
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
