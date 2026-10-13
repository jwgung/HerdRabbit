import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const page = await read("../public/index.html");
const app = await read("../public/app.js");
const worker = await read("../public/sw.js");
const server = await read("../src/http-server.mjs");
const styles = await read("../public/chat/chat-view.css");
const view = await read("../public/chat/chat-view.js");

const CHAT_FILES = [
  "/lens-preference.js",
  "/chat/markdown.js",
  "/chat/diff.js",
  "/chat/work-blocks.js",
  "/chat/conversation-refresh.js",
  "/chat/chat-view.js",
  "/chat/chat-view.css",
  "/chat/chat-activity.js",
  "/chat/prompt-card.js",
  "/chat/prompt-card.css",
  "/chat-font-preference.js",
];

test("the pane header has a Chat / Terminal switch, and both lenses share the stage", () => {
  const heading = page.match(/<div class="terminal-heading">[\s\S]*?\n {8}<\/div>/u)?.[0] ?? "";
  assert.match(heading, /<div id="lens-switch" class="lens-switch" role="group" aria-label="Pane view" hidden>/u);
  assert.match(heading, /<button id="lens-chat" type="button" aria-pressed="false" aria-disabled="true">Chat<\/button>/u);
  assert.match(heading, /<button id="lens-terminal" type="button" aria-pressed="true">Terminal<\/button>/u);
  const stage = page.match(/<div class="terminal-stage"[\s\S]*?<div id="terminal-held"/u)?.[0] ?? "";
  assert.match(stage, /data-lens="terminal"/u);
  assert.match(stage, /<div id="chat-host" class="chat-host"/u);
  assert.match(stage, /<div id="terminal-xterm" class="terminal-xterm" hidden><\/div>/u);
  // one composer below the stage serves both lenses, so a draft stays across a switch
  assert.equal(page.match(/<textarea\s+id="terminal-input"/gu)?.length, 1);
  assert.match(page, /<link rel="stylesheet" href="\/chat\/chat-view\.css\?v=[^"]+" \/>/u);
});

test("every chat file is served and cached with the app", () => {
  for (const path of CHAT_FILES) {
    assert.ok(server.includes(`["${path}", { path: \`\${PUBLIC_DIR}${path}\``), `${path} is served`);
    assert.match(worker, new RegExp(`"${path.replace(/[.]/gu, "\\.")}\\?v=`, "u"), `${path} is in the app shell`);
  }
});

test("switching lenses only hides one: the terminal stays attached and xterm fits once shown", () => {
  // hidden by the stage's lens, not by the terminal's own `hidden`, which means detached
  assert.match(styles, /\.terminal-stage\[data-lens="chat"\] \.terminal-xterm,[\s\S]*?display: none;/u);
  assert.match(styles, /\.terminal-stage\[data-lens="chat"\] \.chat-host \{\s*display: flex;/u);
  assert.doesNotMatch(view, /attachedTerminal|\.detach\(/u, "the chat never touches the terminal's attachment");
  // a hidden chat keeps its scroll: it is hidden while its place can still be read
  assert.match(view, /if \(id !== paneId \|\| lens !== "chat"\) chat\.hide\(\);\s*stage\.dataset\.lens = lens;/u);
  assert.match(view, /savedScrollTop = scroller\.scrollTop;/u);
});

test("the page wires the lens: selection, sending, Mod+J, and reads with If-None-Match", () => {
  assert.match(app, /chatLens\.select\(paneId, \{ claude: isClaudePane\(pane, agent\), status: agentStatus\(agent, pane\) \}\);/u);
  // shown on its way and followed to the end at once; taken back if the send fails
  assert.match(app, /chatLens\.sent\(paneId, text\);\s*try \{/u);
  assert.match(app, /catch \(error\) \{\s*chatLens\.unsent\(paneId\);/u);
  const shortcut = app.match(/function activateLensShortcut\(event\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(shortcut, /event\.key\.toLowerCase\(\) !== "j"/u);
  assert.match(shortcut, /chatLens\.toggle\(\);/u);
  assert.match(app, /if \(activateLensShortcut\(event\)\) return;/u);
  const request = app.match(/async function conversationRequest\(path, \{ etag \} = \{\}\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(request, /headers\.set\("If-None-Match", etag\)/u);
  assert.match(request, /response\.status === 304/u);
  // long in the chat, the terminal is let go; it comes back on return
  assert.match(app, /const TERMINAL_PARK_MS = 5 \* 60_000;/u);
  assert.match(app, /if \(state\.terminalParked === paneId\) return;/u);
  assert.match(app, /if \(lens === "terminal" && state\.terminalParked\) \{\s*state\.terminalParked = null;\s*void refreshTerminal\(\);/u);
});

test("the chat is watched over the socket only while it is on screen", () => {
  assert.match(view, /watch\(lens === "chat" \? paneId : null\);/u);
});

test("a dropped chat lets go of its resize observer, and any conversation message re-reads the chat", () => {
  assert.match(view, /const resizes = typeof ResizeObserver === "function"/u);
  assert.match(view, /destroy\(\) \{[^}]*resizes\?\.disconnect\(\);/su);
  assert.doesNotMatch(view, /new ResizeObserver\([^)]*\)\.observe/u, "no observer is left without a handle");
  assert.match(view, /connection\.onConversation\(\(message\) => \{[^}]*chat\.refresh\(\);/su);
  assert.doesNotMatch(view, /message\.type === "conversation-changed"\) chat\.refresh/u);
});

test("the key bar is the terminal's: the Chat lens hides it and keeps the composer", async () => {
  const main = await read("../public/styles.css");
  assert.match(main, /\.terminal-panel\[data-lens="chat"\] \.quick-keys \{\s*display: none;/u);
  assert.match(main, /\.terminal-panel\[data-lens="chat"\] \{\s*grid-template-rows: auto minmax\(0, 1fr\) auto;/u);
  assert.match(app, /elements\.terminalPanel\.dataset\.lens = lens;/u);
  assert.match(app, /if \(lens === "terminal"\) window\.requestAnimationFrame\(\(\) => attachedTerminal\.refit\(\)\);/u);
});

test("the prompt dock sits in the stage, so the card shares the lens and the banner floats over the terminal", async () => {
  const stage = page.match(/<div class="terminal-stage"[\s\S]*?<div id="prompt-dock"[^>]*><\/div>/u)?.[0] ?? "";
  assert.match(stage, /<div id="prompt-dock" class="prompt-dock" data-mode="hidden" hidden><\/div>/u);
  assert.match(page, /<link rel="stylesheet" href="\/chat\/prompt-card\.css\?v=[^"]+" \/>/u);
  const css = await read("../public/chat/prompt-card.css");
  assert.match(css, /\.prompt-dock\[data-mode="banner"\] \{\s*position: absolute;/u);
  assert.match(css, /\.prompt-dock\[data-mode="overlay"\] \{\s*position: absolute;/u);
});

test("an answer to a password prompt does not stay on show as a pending message", () => {
  assert.match(app, /if \(sent\?\.secret\) chatLens\.withdraw\(paneId\);/u);
  assert.match(view, /withdraw\(\) \{\s*pending = pending\.slice\(0, -1\);/u);
});
