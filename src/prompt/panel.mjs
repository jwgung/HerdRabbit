// A panel one of an agent's own `/` commands opens in its pane: Claude Code's
// settings panel (/usage, /status, /config), its /mcp or /plugin lists,
// Codex's /usage or /config, Kiro's /usage between its rules, Antigravity's
// /help or /usage, OpenCode's /status dialog. Such a panel waits for keys,
// but herdr calls the pane idle, so no prompt reader nor the fallback (only
// for blocked panes) gives it a card: this one does. The card shows the
// panel's text, its tabs when it has some, and one button per key its hint
// line names (`←/→/tab to switch · Esc to close`); a button sends its key as
// it is, and the card stays while the panel does.
//
// Read from the pane's screen with its styles: the tab shown is known only by
// its colour. Kept to what a key cannot lose: no button for a key whose hint
// says it kills, deletes or removes something, nor for the lists whose Enter
// saves a default (Claude's and Codex's /model, Claude's /effort), nor for an
// OpenCode picker (its own search box takes the typing). Esc, which closes
// every panel, is always there.
import { secretPrompt } from "../secret-prompt.mjs";
import { claudeListWaits } from "./claude.mjs";
import { codexListWaits } from "./codex.mjs";
import { KEY, finishPrompt } from "./screen.mjs";

// The agents whose panels are known (checked on Claude Code 2.1.322, Codex
// 0.167.0, Kiro CLI 2.35.1, Antigravity 1.5.2 and OpenCode 2.2.6).
export const PANEL_AGENTS = Object.freeze(["claude", "codex", "kiro", "agy", "opencode"]);

// Claude's links (OSC 8) are no text. CSI_RE is screen.mjs's ANSI_RE with its
// parameters and final byte captured: a style (`m`) is told from any other
// sequence, and its parameters are read (styled()).
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const CSI_RE = /\u001b\[([0-?]*)[ -/]*([@-~])/gu;
// A rule across the pane: a field's short underline (Antigravity's search box) is none.
const RULE_RE = /^[─━]{40,}$/u;
// A hint line: one of its parts is the Esc that closes the panel. "esc to
// interrupt" (a working line) is no panel's.
const ESC_HINT_RE = /(?:^|·|\s{2}|:)\s*esc(?:ape)?\s+(?:to\s+)?(?:cancel|close|back|go back|exit|clear search\/(?:close|exit)|save\/close)\b/iu;
// Antigravity's hint lines that name no Esc (its /tasks)
const KEYBOARD_HINT_RE = /^Keyboard:\s+\S/u;
// What a hint line's key does that no card button does.
// Nor what ends the agent itself (`ctrl+c to quit`): Esc closes the panel.
const HARMFUL_RE = /\b(?:kill|delete|remove|uninstall|log ?out|sign ?out|reset|purchase|buy|quit|exit|interrupt|stop|suspend)\b/iu;
// Keys a card never sends whatever a hint calls them: they stop, end or
// suspend the program in the pane.
const NEVER_KEYS = new Set(["ctrl+c", "ctrl+d", "ctrl+z", "ctrl+\\"]);
// OpenCode's dialog title row: its title, then its keys at the right edge.
const OPENCODE_TITLE_RE = /^(\s*)(\S(?:.*\S)?)\s{2,}(esc(?:\/enter)?)\s*$/u;
// Lines of a panel the card shows at most, and characters.
const MAX_BODY_LINES = 80;
const MAX_BODY_CHARS = 12_000;

const strip = (text) => String(text ?? "").replace(OSC_RE, "").replace(CSI_RE, "");
const plainLines = (screen) => strip(screen).split(/\r?\n/u).map((line) => line.trimEnd());
const isRule = (line) => RULE_RE.test(line.trim());
const isBlank = (line) => line.trim() === "";

// --- styles ------------------------------------------------------------------

function sgr(state, params) {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  const next = { ...state };
  for (let at = 0; at < codes.length; at += 1) {
    const code = codes[at];
    if (code === 0) { for (const key of Object.keys(next)) delete next[key]; }
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = String(code);
    else if (code === 39) delete next.fg;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.bg = String(code);
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const size = codes[at + 1] === 2 ? 4 : 2;
      const value = codes.slice(at + 1, at + 1 + size).join(";");
      if (code === 38) next.fg = value; else next.bg = value;
      at += size;
    }
  }
  return next;
}

// A screen line as its text and the style of each of its characters.
function styled(raw) {
  const line = raw.replace(OSC_RE, "");
  let text = "";
  const marks = [];
  let state = {};
  let at = 0;
  const add = (chunk) => { text += chunk; for (let index = 0; index < chunk.length; index += 1) marks.push(state); };
  for (const match of line.matchAll(CSI_RE)) {
    add(line.slice(at, match.index));
    if (match[2] === "m") state = sgr(state, match[1]);
    at = match.index + match[0].length;
  }
  add(line.slice(at));
  return { text: text.trimEnd(), marks };
}

const styleKey = (mark) => JSON.stringify([mark?.bold, mark?.dim, mark?.underline, mark?.inverse, mark?.fg, mark?.bg]);
const highlighted = (mark) => Boolean(mark?.inverse || mark?.bg || mark?.underline);

// A tab row: three or more labels apart, exactly one of them drawn as the one
// shown. A first label drawn unlike every other is the panel's name (Claude's
// "Settings", Antigravity's "Antigravity CLI"); a closing "(…)" is a hint.
function tabRow(raw) {
  const { text, marks } = styled(raw);
  const parts = [...text.matchAll(/\S+(?: \S+)*/gu)].map((match) => ({ label: match[0], mark: marks[match.index] }))
    .filter((part) => !part.label.startsWith("("));
  if (parts.length < 3) return null;
  const shown = parts.filter((part) => highlighted(part.mark));
  if (shown.length !== 1) return null;
  let name = null;
  const [first] = parts;
  const rest = parts.slice(1).filter((part) => part !== shown[0]);
  if (first !== shown[0] && rest.length >= 2 && rest.every((part) => styleKey(part.mark) === styleKey(rest[0].mark))
      && styleKey(first.mark) !== styleKey(rest[0].mark)) {
    name = first.label;
    parts.shift();
  }
  return { name, tabs: parts.map((part) => ({ label: part.label, selected: part === shown[0] })) };
}

// --- keys --------------------------------------------------------------------

const KEY_NAMES = new Map([
  ["esc", KEY.escape], ["escape", KEY.escape], ["enter", KEY.enter], ["return", KEY.enter], ["↵", KEY.enter], ["⏎", KEY.enter],
  ["tab", KEY.tab], ["space", "space"], ["↑", KEY.up], ["↓", KEY.down], ["←", KEY.left], ["→", KEY.right],
  ["up", KEY.up], ["down", KEY.down], ["left", KEY.left], ["right", KEY.right],
  ["pgup", "pageup"], ["pgdown", "pagedown"], ["pgdn", "pagedown"], ["home", "home"], ["end", "end"],
]);
const KEY_LABELS = new Map([
  [KEY.escape, "Esc"], [KEY.enter, "Enter"], [KEY.tab, "Tab"], ["space", "Space"], [KEY.up, "↑"], [KEY.down, "↓"],
  [KEY.left, "←"], [KEY.right, "→"], ["pageup", "PgUp"], ["pagedown", "PgDn"], ["home", "Home"], ["end", "End"],
]);

// The keys one hint part names (`↑/↓`, `←/→/tab`, `^J/K`, `ctrl+end`, `d`,
// `/`), each as a key or a typed character; null when a word is no key.
function keysOf(spec) {
  if (spec === "/" || spec === "?") return [{ text: spec }];
  const words = /^[↑↓←→]+$/u.test(spec) ? [...spec] : spec.split("/");
  let ctrl = false;
  const keys = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    const caret = /^\^([a-z])$/iu.exec(word);
    const combo = /^ctrl\+([a-z0-9]+)$/iu.exec(word);
    if (caret) { ctrl = true; keys.push({ key: `ctrl+${caret[1].toLowerCase()}` }); }
    else if (combo) keys.push({ key: `ctrl+${KEY_NAMES.get(combo[1].toLowerCase()) ?? combo[1].toLowerCase()}` });
    else if (KEY_NAMES.has(lower)) keys.push({ key: KEY_NAMES.get(lower) });
    else if (/^[a-z]$/iu.test(word)) keys.push(ctrl ? { key: `ctrl+${lower}` } : { text: word });
    else return null;
  }
  return keys.length > 0 ? keys : null;
}

function labelOf(item) {
  if (item.text !== undefined) return item.text;
  if (KEY_LABELS.has(item.key)) return KEY_LABELS.get(item.key);
  return item.key.split("+").map((part) => (KEY_LABELS.get(part) ?? `${part[0].toUpperCase()}${part.slice(1)}`)).join("+");
}

const sentence = (words) => words ? `${words[0].toUpperCase()}${words.slice(1)}` : null;

// The card's buttons from a hint line, in its order, Esc last (and always).
function hintKeys(hint) {
  const found = [];
  for (const part of hint.replace(/^Keyboard:\s*/u, "").split(/\s+·\s+|\s{2,}/u)) {
    const match = /^(\S+)\s+(?:to\s+)?(.+)$/u.exec(part.trim());
    if (!match) continue;
    const keys = keysOf(match[1]);
    if (!keys || HARMFUL_RE.test(match[2]) || keys.some((item) => NEVER_KEYS.has(item.key))) continue;
    for (const item of keys) found.push({ ...item, description: sentence(match[2].trim()) });
  }
  return finishKeys(found);
}

function finishKeys(found) {
  const seen = new Set();
  const kept = found.filter((item) => {
    const id = item.key ?? `text:${item.text}`;
    if (seen.has(id) || item.key === KEY.escape) return false;
    seen.add(id);
    return true;
  });
  return [...kept, { key: KEY.escape, description: "Close" }];
}

// The arrows first, always in one order, then the hint's other keys as it
// names them, Esc last: the buttons stand where they stood on the last panel.
const ARROWS = [KEY.left, KEY.right, KEY.up, KEY.down];
function inOrder(keys) {
  const arrows = ARROWS.flatMap((key) => keys.filter((item) => item.key === key));
  const rest = keys.filter((item) => !ARROWS.includes(item.key) && item.key !== KEY.escape);
  return [...arrows, ...rest, ...keys.filter((item) => item.key === KEY.escape)];
}

// --- the panel ---------------------------------------------------------------

// The hint line's index among `lines`: one of the last two lines with text
// that are no rule (Antigravity writes its model under it), or -1.
function hintIndex(lines) {
  let seen = 0;
  for (let index = lines.length - 1; index >= 0 && seen < 2; index -= 1) {
    const line = lines[index].trim();
    if (!line || isRule(line)) continue;
    seen += 1;
    if (ESC_HINT_RE.test(line) || KEYBOARD_HINT_RE.test(line)) return index;
  }
  return -1;
}

// Kiro's panel opens with its command alone on a line (` /usage` between two
// rules, `› /model`).
const KIRO_TITLE_RE = /^\s*(?:›\s*)?\/[\w-]+\s*$/u;
// …or with its state after it (`/mcp list · 2 configured`), between two rules.
const KIRO_RULED_TITLE_RE = /^\s*\/[\w-]+\s+\S/u;

// Codex draws no rule: its panel opens with a bold title under two or more
// blank lines (inside the panel, blank lines come one or two at a time, and
// never above a bold line).
function codexTop(lines, raws, end) {
  let blanks = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (isBlank(lines[index])) { blanks += 1; continue; }
    const below = index + blanks + 1;
    if (blanks >= 2 && below < end) {
      const { text, marks } = styled(raws[below]);
      const mark = marks[text.search(/\S/u)];
      if (mark?.bold && !mark.inverse && !mark.underline) return below;
    }
    blanks = 0;
  }
  return blanks >= 2 && end > blanks ? blanks : -1;
}

// Where the panel starts above `end`, and its title when the start names it:
// Kiro's command line, Codex's bold title; else under the last rule (Claude's,
// Antigravity's), else after three blank lines in a row, else the screen's top.
function panelTop(lines, raws, end, agent) {
  if (agent === "kiro") {
    for (let index = end - 1; index >= 0; index -= 1) {
      const ruled = index > 0 && isRule(lines[index - 1]) && isRule(lines[index + 1] ?? "");
      if (KIRO_TITLE_RE.test(lines[index]) || (ruled && KIRO_RULED_TITLE_RE.test(lines[index]))) {
        return { top: index + 1, title: lines[index].trim().replace(/^›\s*/u, "") };
      }
    }
  }
  if (agent === "codex") {
    const top = codexTop(lines, raws, end);
    if (top >= 0) return { top, title: null };
  }
  for (let index = end - 1; index >= 0; index -= 1) if (isRule(lines[index])) return { top: index + 1, title: null };
  let blanks = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    blanks = isBlank(lines[index]) ? blanks + 1 : 0;
    if (blanks >= 3) return { top: index + blanks, title: null };
  }
  return { top: 0, title: null };
}

// A panel's first line as its title: Antigravity's "└ Models & Quota", its
// "Antigravity CLI  credits" header, and no more than the first of a line's
// columns (Codex's /agents: "Tasks  │ Task details").
function titleOf(line) {
  const text = line.replace(/^└\s*/u, "");
  const header = /^Antigravity CLI\s{2,}(\S.*)$/u.exec(text);
  if (header) return header[1].trim();
  return text.split(/\s{2,}|\s*│\s*/u).find(Boolean) ?? text;
}

function bodyOf(lines) {
  const kept = lines.map((line) => line.trimEnd());
  while (kept.length > 0 && (isBlank(kept[0]) || isRule(kept[0]))) kept.shift();
  while (kept.length > 0 && (isBlank(kept.at(-1)) || isRule(kept.at(-1)))) kept.pop();
  const indent = Math.min(...kept.filter((line) => !isBlank(line)).map((line) => line.search(/\S/u)));
  const text = kept.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n").replace(/\n{3,}/gu, "\n\n");
  return text.split("\n").slice(-MAX_BODY_LINES).join("\n") || null;
}

function finishPanel(agent, { name, title, question = null, tabs = null, body, keys }) {
  const options = keys.map((item) => ({ label: labelOf(item), description: item.description ?? null }));
  const optionSteps = keys.map((item) => [item.key ? { keys: [item.key] } : { text: item.text }]);
  // The id is the panel's, not its words' nor its tab's: a key goes to the
  // same panel whichever tab it shows and however its figures tick.
  const parsed = finishPrompt(agent, {
    kind: "panel", title: tabs ? null : title, question: null, body: null, options, multiSelect: false, customOptionIndex: null,
  }, {
    panel: true, responder: "panel-keys", menuLabels: options.map((option) => option.label), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, optionSteps,
  }, { name, tabs: tabs?.map((tab) => tab.label) ?? null });
  return { ...parsed, title, question, body: body?.slice(0, MAX_BODY_CHARS) ?? null, panelName: name, ...(tabs ? { tabs } : {}) };
}

const threeLabels = (line) => line.trim().split(/\s{2,}/u).length >= 3;

// Claude's settings panel on a tab that draws no hint line (Stats): the last
// rule on screen opens a row of three or more labels, with no rule just above
// it: Claude's input box, back once the panel closes, is a line between two
// rules, its footer under them. The rule's index, or -1.
function claudeTabsRule(lines) {
  const rule = lines.findLastIndex(isRule);
  if (rule < 0 || lines.slice(Math.max(0, rule - 2), rule).some(isRule)) return -1;
  const next = lines.findIndex((line, index) => index > rule && !isBlank(line));
  if (next < 0 || !threeLabels(lines[next])) return -1;
  return rule;
}

function parseTerminalPanel(screen, agent) {
  const raws = String(screen).split(/\r?\n/u);
  const lines = raws.map((raw) => strip(raw).trimEnd());
  const hint = hintIndex(lines);
  // no hint: Claude's tab with none, or no panel
  const tabsRule = hint < 0 && agent === "claude" ? claudeTabsRule(lines) : -1;
  if (hint < 0 && tabsRule < 0) return null;
  // Kiro closes its panel with a rule above the hint
  let end = hint >= 0 ? hint : lines.findLastIndex((line) => !isBlank(line)) + 1;
  let above = end - 1;
  while (above >= 0 && isBlank(lines[above])) above -= 1;
  if (hint >= 0 && above >= 0 && isRule(lines[above])) end = above;
  const { top, title: commandTitle } = tabsRule >= 0 ? { top: tabsRule + 1, title: null } : panelTop(lines, raws, end, agent);
  let start = top;
  while (start < end && (isBlank(lines[start]) || isRule(lines[start]))) start += 1;
  if (start >= end && !commandTitle) return null;
  let name = null;
  let title = commandTitle;
  let question = null;
  let tabs = null;
  let bodyStart = start;
  // a tab row among the panel's first lines (Codex's /config has its name and a line above it)
  const firstLines = [];
  for (let index = start; index < end && firstLines.length < 3; index += 1) if (!isBlank(lines[index])) firstLines.push(index);
  for (const [position, index] of firstLines.entries()) {
    const row = tabRow(raws[index]);
    if (!row) continue;
    tabs = row.tabs;
    title = tabs.find((tab) => tab.selected).label;
    name = row.name ?? (position > 0 ? lines[firstLines[0]].trim() : null);
    if (position > 1) question = firstLines.slice(1, position).map((at) => lines[at].trim()).join("\n");
    bodyStart = index + 1;
    break;
  }
  if (!title) {
    const first = lines[start].trim();
    if (/^[›❯>]\s+\S/u.test(first)) {
      // the panel opens with its list, a row picked: it has no title of its own
      title = "Panel";
      bodyStart = start;
    } else {
      title = titleOf(first);
      bodyStart = start + 1;
    }
  }
  // a panel known by its tab row alone has one
  if (tabsRule >= 0 && !tabs) return null;
  const body = bodyOf(lines.slice(bodyStart, end));
  let keys = hint >= 0 ? hintKeys(lines[hint].trim()) : finishKeys([]);
  // a panel with tabs takes ← and → whatever its hint says (Claude's /usage
  // says Esc alone), a list with a row picked ↑ and ↓ (Codex's /usage says
  // Enter and Esc)
  const has = (key) => keys.some((item) => item.key === key);
  if (tabs && !has(KEY.left)) keys.push({ key: KEY.left, description: "Previous tab" }, { key: KEY.right, description: "Next tab" });
  if (body && /^\s*[›❯>]\s+\S/mu.test(body)) {
    if (!has(KEY.up)) keys.push({ key: KEY.up, description: "Move" });
    if (!has(KEY.down)) keys.push({ key: KEY.down, description: "Move" });
  }
  return finishPanel(agent, { name, title, question, tabs, body, keys: inOrder(keys) });
}

// OpenCode's dialog: a box of its own background over the screen, its title
// row naming its keys at the right edge. A picker (a Search box under the
// title) is no panel: what is typed goes to its search.
function parseOpencodePanel(screen) {
  const raws = String(screen).split(/\r?\n/u);
  for (let index = raws.length - 1; index >= 0; index -= 1) {
    const { text, marks } = styled(raws[index]);
    const match = OPENCODE_TITLE_RE.exec(text);
    if (!match) continue;
    const left = match[1].length;
    const right = text.length + 3;
    // the box's own margin, left of its title: the dim screen around it has another background
    const edge = Math.max(0, left - 3);
    const box = marks[edge]?.bg;
    if (!box) continue;
    const rows = [];
    for (let at = index + 1; at < raws.length; at += 1) {
      const line = styled(raws[at]);
      if (line.marks[edge]?.bg !== box) break;
      const shown = line.text.slice(left, right).trimEnd();
      // a row drawn on another colour than the box's is the one picked
      const picked = line.marks[left]?.bg && line.marks[left].bg !== box;
      rows.push(picked && shown.trim() ? `› ${shown}` : shown);
    }
    if (rows.find((row) => !isBlank(row))?.trim().startsWith("Search")) return null;
    const keys = finishKeys(match[3].split("/").map((word) => ({ key: KEY_NAMES.get(word), description: word === "enter" ? "OK" : null })));
    return finishPanel("opencode", { name: null, title: match[2], body: bodyOf(rows), keys });
  }
  return null;
}

// Whether the plain screen (no styles) shows a panel's hint where one ends a
// panel: worth reading the screen again with its styles. OpenCode's screen is
// read with them already.
export function panelShown(screen, agent) {
  if (!PANEL_AGENTS.includes(agent)) return false;
  const lines = plainLines(screen);
  if (agent === "opencode") return lines.some((line) => OPENCODE_TITLE_RE.test(line));
  return hintIndex(lines) >= 0 || (agent === "claude" && claudeTabsRule(lines) >= 0);
}

// The panel card for `screen` (read with its styles), or null.
export function parsePanel(screen, { agent } = {}) {
  if (!PANEL_AGENTS.includes(agent)) return null;
  const text = String(screen ?? "");
  const plain = plainLines(text);
  if (plain.every(isBlank) || secretPrompt(strip(text)) !== null) return null;
  if (claudeListWaits(plain) || codexListWaits(plain)) return null;
  return agent === "opencode" ? parseOpencodePanel(text) : parseTerminalPanel(text, agent);
}
