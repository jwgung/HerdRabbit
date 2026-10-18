// The Chat lens: an agent pane's conversation (Claude Code's or Codex's)
// drawn as turns, beside the
// pane's terminal in the same place. Switching lenses only shows one and hides
// the other: the terminal stays attached, and the chat keeps what it read.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/components/ChatView.tsx and
// ChatView.css, rewritten as plain DOM code without React.
import { COPY_ICONS, renderMarkdown } from "./markdown.js?v=1.2.71";
import { lineDiff } from "./diff.js?v=1.2.71";
import {
  formatWorkDuration,
  commandText,
  isCommandTool,
  isLiveWorkTurn,
  isTodoTool,
  parseToolInput,
  splitTurn,
  todoCallSummary,
  todoItems,
  toolVerb,
  workFailed,
  workStartsOpen,
  workSummary,
  workTitle,
} from "./work-blocks.js?v=1.2.71";
import { paneRenames } from "../pane-rename.js?v=1.2.71";
import { ConversationLoader } from "./conversation-refresh.js?v=1.2.71";
import { OPTIMISTIC_MS, pendingMessage, settlePending, showsWorking, workingText } from "./chat-activity.js?v=1.2.71";
import {
  chatMayBecomeAvailable,
  chatUnavailableText,
  chooseLens,
  readPaneLens,
  writePaneLens,
} from "../lens-preference.js?v=1.2.71";

// Scrolling this close to the top reads the page before it.
const LOAD_OLDER_PX = 400;
// This close to the end counts as at the end: new turns keep it there.
const FOLLOW_BOTTOM_PX = 48;
// Panes whose chat is kept while another is shown.
const KEPT_CHATS = 4;
// Answers kept per pane for If-None-Match.
const KEPT_ANSWERS = 16;
// While the chat is shown, a read now and then in case a change was missed.
const BACKSTOP_MS = 15_000;
// A pane whose chat may appear later (no session yet) is asked again after this.
const RECHECK_MS = 10_000;

function element(document, tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  return node;
}

function formatTime(ts) {
  if (typeof ts !== "string") return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const COPIED_MS = 1_500;

function formatCount(count) {
  return Number(count).toLocaleString("en-US");
}

// Copies text, over the clipboard API where the page is secure and by the
// older copy command elsewhere. Answers whether it worked.
export async function copyText(text, document = globalThis.document) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.append(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  scratch.remove();
  return ok;
}

// A stable name for each turn across reads: its role and time, and which of
// the turns with that same role and time it is.
export function turnKeys(turns) {
  const seen = new Map();
  return turns.map((turn) => {
    const base = `${turn.role}|${turn.ts ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}|${count}`;
  });
}

// ---------------------------------------------------------------------------
// One pane's chat.

function createPaneChat({ paneId, document, fetchJson, isLinkablePath, onOpenPath, onViewInTerminal, onCopy, onAvailability, onDrawn = () => {} }) {
  const root = element(document, "div", { className: "chat-pane", attrs: { "data-pane-id": paneId } });
  root.hidden = true;
  const scroller = element(document, "div", { className: "chat-scroll", attrs: { role: "log", "aria-live": "polite", "aria-label": "Conversation", tabindex: "0" } });
  const transcript = element(document, "div", { className: "chat-transcript" });
  const olderButton = element(document, "button", { className: "secondary-button chat-older", text: "Earlier messages", attrs: { type: "button", "data-action": "older" } });
  const beginning = element(document, "p", { className: "chat-endcap", text: "Beginning of conversation" });
  const turnsHost = element(document, "div", { className: "chat-turns" });
  // The message just sent, until the transcript has it, and the working row.
  const activity = element(document, "div", { className: "chat-activity" });
  const stateLine = element(document, "p", { className: "chat-state", attrs: { role: "status" } });
  const retryButton = element(document, "button", { className: "secondary-button chat-retry", text: "Try again", attrs: { type: "button", "data-action": "retry" } });
  const jumpButton = element(document, "button", { className: "chat-jump", text: "Jump to latest", attrs: { type: "button", "data-action": "jump" } });
  olderButton.hidden = true;
  beginning.hidden = true;
  retryButton.hidden = true;
  jumpButton.hidden = true;
  transcript.append(olderButton, beginning, turnsHost, activity, stateLine, retryButton);
  scroller.append(transcript);
  root.append(scroller, jumpButton);

  // Answers by query, for If-None-Match: an unchanged page is not sent again.
  const answers = new Map();
  async function fetchPage(query) {
    const params = new URLSearchParams();
    if (query.before) params.set("before", query.before);
    if (query.since) params.set("since", query.since);
    const key = params.toString();
    const known = answers.get(key);
    const path = `/api/panes/${encodeURIComponent(paneId)}/conversation${key ? `?${key}` : ""}`;
    const result = await fetchJson(path, { etag: known?.etag });
    if (result.notModified && known) return known.answer;
    if (result.notModified) return fetchJson(path, {}).then((fresh) => remember(key, fresh));
    return remember(key, result);
  }
  function remember(key, result) {
    answers.delete(key);
    if (result.etag) answers.set(key, { etag: result.etag, answer: result.payload });
    while (answers.size > KEPT_ANSWERS) answers.delete(answers.keys().next().value);
    return result.payload;
  }

  let status = null;
  // The agent the pane runs, for the working row's words.
  let agent = "claude";
  // When the agent began working, as this page saw it, and how long a send
  // alone keeps the working row up before any status answers it.
  let workingSince = null;
  let optimisticUntil = 0;
  let pending = [];
  let ticker = null;
  let activityKey = null;
  let visible = false;
  let stick = true;
  let savedScrollTop = 0;
  let olderState = "idle";
  let error = null;
  let backstop = null;
  let rendered = { revision: -1, status: null };
  // Turn elements by key, with what they were drawn from.
  const drawn = new Map();
  // What the reader opened or closed: work blocks by turn, rows by turn and part.
  const blockChoice = new Map();
  const openRows = new Set();
  // Whole tool outputs fetched on request, by tool id.
  const wholeOutputs = new Map();

  const loader = new ConversationLoader({
    fetchPage,
    onRead: () => {
      onAvailability({ available: true });
      // an unchanged answer after a failed read: the failure is over
      if (error) { error = null; render({}); }
    },
    onChange: (history, { older }) => {
      error = null;
      render({ older });
    },
    onError: (failure, { older }) => {
      if (failure?.code === "conversation_unavailable") {
        onAvailability({ available: false, reason: failure.details?.reason ?? null });
        return;
      }
      if (older) olderState = "failed";
      else error = failure;
      render({});
    },
  });

  // --- drawing --------------------------------------------------------------

  const markdown = (text, className = "markdown") => {
    const node = element(document, "div", { className });
    node.innerHTML = renderMarkdown(text, { isLinkablePath });
    return node;
  };

  function fileLine(path, suffix = "") {
    const line = element(document, "p", { className: "chat-tool-file" });
    if (isLinkablePath(path)) {
      const button = element(document, "button", { className: "md-file", text: path, attrs: { type: "button", "data-path": path, title: `Open ${path}` } });
      line.append(button);
    } else {
      line.append(document.createTextNode(path));
    }
    if (suffix) line.append(document.createTextNode(suffix));
    return line;
  }

  function diffView(before, after) {
    const pre = element(document, "pre", { className: "chat-diff" });
    for (const line of lineDiff(before, after)) {
      const span = element(document, "span", {
        className: line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : "",
        text: `${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}\n`,
      });
      pre.append(span);
    }
    return pre;
  }

  function todoList(items) {
    const list = element(document, "ul", { className: "chat-todos" });
    const words = { completed: "done", in_progress: "in progress", pending: "to do" };
    for (const item of items) {
      const row = element(document, "li", { className: `chat-todo is-${item.status}` });
      row.append(element(document, "span", { className: "chat-todo-mark", attrs: { "aria-hidden": "true" } }));
      row.append(element(document, "span", { text: item.label }));
      row.append(element(document, "span", { className: "sr-only", text: ` (${words[item.status]})` }));
      list.append(row);
    }
    return list;
  }

  function toolInput(part) {
    const io = element(document, "div", { className: "chat-tool-io" });
    const raw = () => element(document, "pre", { text: part.input ?? "" });
    if (part.input_truncated) {
      io.append(raw(), element(document, "p", { className: "chat-tool-meta", text: "The input is cut short here." }));
      return io;
    }
    if (isTodoTool(part.name)) {
      const items = todoItems(part.input);
      if (items !== null && items.length > 0) { io.append(todoList(items)); return io; }
    }
    const input = parseToolInput(part.input ?? "");
    if (input === null) { io.append(raw()); return io; }
    const text = (key) => (typeof input[key] === "string" ? input[key] : undefined);
    const path = text("file_path") ?? text("notebook_path") ?? text("path");
    // Claude's Bash and Codex's exec_command (`cmd`) or shell (an argv)
    const command = text("command") ?? text("cmd") ?? commandText(input.command);
    if (command !== undefined) {
      io.append(element(document, "pre", { text: command }));
      if (text("description")) io.append(element(document, "p", { className: "chat-tool-meta", text: text("description") }));
    } else if (text("old_string") !== undefined || text("new_string") !== undefined) {
      if (path) io.append(fileLine(path));
      io.append(diffView(text("old_string") ?? "", text("new_string") ?? ""));
    } else if (Array.isArray(input.edits) && input.edits.every((edit) => edit !== null && typeof edit === "object")) {
      if (path) io.append(fileLine(path));
      for (const edit of input.edits) {
        io.append(diffView(typeof edit.old_string === "string" ? edit.old_string : "", typeof edit.new_string === "string" ? edit.new_string : ""));
      }
    } else if (text("content") !== undefined) {
      if (path) io.append(fileLine(path));
      io.append(element(document, "pre", { text: text("content") }));
    } else if (path) {
      io.append(fileLine(path, text("pattern") ? ` (${text("pattern")})` : ""));
    } else {
      io.append(raw());
    }
    return io;
  }

  function toolOutput(part) {
    const whole = part.id ? wholeOutputs.get(part.id) : undefined;
    const output = whole?.text ?? part.output ?? "";
    if (!output && !part.output_truncated) return null;
    const section = element(document, "section", { className: "chat-tool-output" });
    section.append(element(document, "h5", { text: part.error ? "Error" : "Output" }));
    section.append(element(document, "pre", { className: "chat-tool-io", text: output }));
    if (part.output_truncated && part.id && whole?.text === undefined) {
      const label = whole?.state === "loading" ? "Loading the whole output…"
        : whole?.state === "failed" ? "Couldn't load the whole output. Try again"
          : `Show the whole output (${formatCount(part.output_size ?? 0)} characters)`;
      const button = element(document, "button", { className: "secondary-button chat-tool-more", text: label,
        attrs: { type: "button", "data-action": "whole-output", "data-tool-id": part.id } });
      button.disabled = whole?.state === "loading";
      section.append(button);
    }
    return section;
  }

  function rowDetail(part) {
    const detail = element(document, "div", { className: "work-row-detail" });
    const head = element(document, "div", { className: "work-row-tools" });
    head.append(element(document, "span", { className: "work-row-tool", text: part.name }));
    if (isCommandTool(part.name)) {
      head.append(element(document, "button", { className: "chat-link-button", text: "View in terminal",
        attrs: { type: "button", "data-action": "view-terminal" } }));
    }
    detail.append(head, toolInput(part));
    const output = toolOutput(part);
    if (output) detail.append(output);
    return detail;
  }

  function caret() {
    return element(document, "span", { className: "work-caret", attrs: { "aria-hidden": "true" } });
  }

  function toolRow(part, rowKey) {
    const open = openRows.has(rowKey);
    const row = element(document, "div", { className: `work-row${part.error ? " is-error" : ""}`, attrs: { "data-row": rowKey } });
    const summary = todoCallSummary(part) ?? part.summary ?? "";
    const verb = toolVerb(part);
    const head = element(document, "button", { className: "work-row-head", attrs: { type: "button", "aria-expanded": String(open), "data-action": "toggle-row" } });
    head.append(caret());
    head.append(element(document, "span", { className: `work-row-name${verb ? " is-verb" : ""}`, text: verb ?? part.name }));
    if (summary && summary !== part.name) head.append(document.createTextNode(" "), element(document, "span", { className: "work-row-summary", text: summary }));
    if (part.error) head.append(document.createTextNode(" "), element(document, "span", { className: "work-row-failed", text: "failed" }));
    row.append(head);
    if (open) row.append(rowDetail(part));
    return row;
  }

  function thinkingRow(part, rowKey) {
    const open = openRows.has(rowKey);
    const row = element(document, "div", { className: "work-row work-row-thinking", attrs: { "data-row": rowKey } });
    const head = element(document, "button", { className: "work-row-head", attrs: { type: "button", "aria-expanded": String(open), "data-action": "toggle-row" } });
    head.append(caret(), element(document, "span", { className: "work-row-name", text: "Thinking" }));
    row.append(head);
    if (open) row.append(element(document, "div", { className: "work-row-detail work-thinking", text: part.text }));
    return row;
  }

  function workBlock(turn, key, parts, live) {
    const chosen = blockChoice.get(key);
    const open = chosen ?? workStartsOpen(live, turn.parts);
    const block = element(document, "section", { className: `work-block${live ? " is-live" : ""}${live && status === "blocked" ? " is-waiting" : ""}`, attrs: { "data-block": key } });
    const head = element(document, "button", { className: "work-block-head", attrs: { type: "button", "aria-expanded": String(open), "data-action": "toggle-block" } });
    head.append(caret(), element(document, "span", { className: "work-block-title",
      text: workTitle({ live, status, duration: formatWorkDuration(turn.ts, turn.end_ts ?? null) }) }));
    const summary = workSummary(parts);
    if (summary) head.append(element(document, "span", { className: "work-block-summary", text: `· ${summary}` }));
    const failed = workFailed(parts);
    if (failed > 0) head.append(element(document, "span", { className: "work-block-failed", text: `· ${failed} failed` }));
    block.append(head);
    if (open) {
      const rows = element(document, "div", { className: "work-block-rows" });
      parts.forEach((part) => {
        const index = turn.parts.indexOf(part);
        const rowKey = `${key}#${index}`;
        if (part.kind === "thinking") rows.append(thinkingRow(part, rowKey));
        else if (part.kind === "text") rows.append(markdown(part.text, "markdown work-narration"));
        else if (part.kind === "tool") rows.append(toolRow(part, rowKey));
      });
      block.append(rows);
    }
    return block;
  }

  function copyButton(text, label) {
    const button = element(document, "button", { className: "chat-copy", attrs: { type: "button", "data-action": "copy-text", "aria-label": label, title: label } });
    button.innerHTML = COPY_ICONS;
    button.dataset.copy = text;
    return button;
  }

  // --- the end of the chat: the message on its way, and the working row ---

  function drawActivity() {
    const now = Date.now();
    pending = settlePending(pending, loader.history.turns, now);
    const working = showsWorking({ status, optimisticUntil, now });
    if (working && workingSince === null) workingSince = now;
    if (!working && status !== "working") workingSince = null;
    const text = working ? workingText(workingSince, now, agent) : "";
    const key = `${pending.map((item) => `${item.at}:${item.text}`).join("\n")}|${text}`;
    if (key !== activityKey) {
      activityKey = key;
      const nodes = pending.map((item) => {
        const article = element(document, "article", { className: "chat-turn chat-turn-user is-pending", attrs: { "aria-label": "Sending" } });
        const bubble = element(document, "div", { className: "chat-bubble" });
        bubble.append(element(document, "p", { className: "chat-pending-text", text: item.text }));
        article.append(bubble, element(document, "div", { className: "chat-turn-meta", text: "Sending…" }));
        return article;
      });
      if (working) {
        const row = element(document, "p", { className: "chat-working", attrs: { role: "status" } });
        row.append(element(document, "span", { className: "chat-working-dots", attrs: { "aria-hidden": "true" } }),
          element(document, "span", { text }));
        nodes.push(row);
      }
      activity.replaceChildren(...nodes);
    }
    // the time ticks while the row shows; a pending bubble is dropped on time
    const ticking = visible && (working || pending.length > 0);
    if (ticking && ticker === null) ticker = setInterval(() => { drawActivity(); keepAtEnd(); }, 1_000);
    if (!ticking && ticker !== null) { clearInterval(ticker); ticker = null; }
  }

  function keepAtEnd() {
    if (visible && stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function timeElement(ts) {
    const time = formatTime(ts);
    if (time === null) return null;
    return element(document, "time", { text: time, attrs: { datetime: ts } });
  }

  function folded(className, label, ts, body) {
    const details = element(document, "details", { className });
    const summary = element(document, "summary");
    summary.append(element(document, "span", { text: label }));
    const time = timeElement(ts);
    if (time) summary.append(document.createTextNode(" · "), time);
    details.append(summary, body);
    return details;
  }

  function turnElement(turn, key, live) {
    const compact = turn.parts.find((part) => part.kind === "compact");
    if (compact) return folded("chat-compact", "Conversation compacted", turn.ts, markdown(compact.text, "markdown chat-compact-text"));
    const notice = turn.parts.find((part) => part.kind === "notice");
    if (notice) {
      const first = notice.text.split("\n").find((line) => line.trim())?.trim() ?? "Notice";
      return folded("chat-compact chat-notice", first.length > 96 ? `${first.slice(0, 95)}…` : first, turn.ts,
        element(document, "pre", { className: "chat-compact-text", text: notice.text }));
    }
    if (turn.role === "user") {
      const article = element(document, "article", { className: "chat-turn chat-turn-user" });
      const text = turn.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n\n");
      const images = turn.parts.filter((part) => part.kind === "image").length;
      const bubble = element(document, "div", { className: "chat-bubble" });
      if (images > 0) bubble.append(element(document, "p", { className: "chat-image-note", text: images === 1 ? "Pasted image" : `${images} pasted images` }));
      if (text) bubble.append(markdown(text));
      const meta = element(document, "div", { className: "chat-turn-meta" });
      const time = timeElement(turn.ts);
      if (time) meta.append(time);
      if (text) meta.append(copyButton(text, "Copy message"));
      article.append(bubble, meta);
      return article;
    }
    const article = element(document, "article", { className: "chat-turn chat-turn-agent" });
    const { work, answer } = splitTurn(turn.parts);
    if (work.length > 0) article.append(workBlock(turn, key, work, live));
    for (const part of answer) article.append(markdown(part.text));
    const answerText = answer.map((part) => part.text).join("\n\n");
    if (answerText) {
      const meta = element(document, "div", { className: "chat-turn-meta" });
      meta.append(copyButton(answerText, "Copy answer"));
      const time = timeElement(turn.end_ts ?? turn.ts);
      if (time) meta.append(time);
      article.append(meta);
    }
    return article;
  }

  function atBottom() {
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - FOLLOW_BOTTOM_PX;
  }

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    stick = true;
    jumpButton.hidden = true;
  }

  function render({ older = false, force = false } = {}) {
    const history = loader.history;
    const anchor = older && !stick ? { top: scroller.scrollTop, height: scroller.scrollHeight } : null;
    const turns = history.turns;
    const keys = turnKeys(turns);
    const changed = force || rendered.revision !== history.revision || rendered.status !== status;
    if (changed) {
      let created = false;
      const nodes = turns.map((turn, index) => {
        const key = keys[index];
        const live = isLiveWorkTurn(turn, index === turns.length - 1, status);
        // the live turn's header follows the agent's status; others only their own turn
        const signature = `${live ? `live:${status}` : ""}|${JSON.stringify(turn)}`;
        const known = drawn.get(key);
        if (!force && known && known.signature === signature) return known.node;
        const node = turnElement(turn, key, live);
        drawn.set(key, { signature, node, turn, live });
        created = true;
        return node;
      });
      const kept = new Set(keys);
      for (const key of drawn.keys()) if (!kept.has(key)) drawn.delete(key);
      // moved into place one by one: turns already on the page stay where they are
      let cursor = turnsHost.firstChild;
      for (const node of nodes) {
        if (node === cursor) { cursor = cursor.nextSibling; continue; }
        turnsHost.insertBefore(node, cursor);
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
      rendered = { revision: history.revision, status };
      if (created && !stick && !older && history.loaded && turns.length > 0) {
        jumpButton.textContent = "New messages";
        jumpButton.hidden = false;
      }
    }
    olderButton.hidden = typeof history.olderCursor !== "string";
    olderButton.disabled = olderState === "loading";
    olderButton.textContent = olderState === "loading" ? "Loading earlier messages…"
      : olderState === "failed" ? "Couldn't load earlier messages. Try again" : "Earlier messages";
    beginning.hidden = !(history.loaded && history.olderCursor === null && turns.length > 0);
    const message = error ? `Couldn't load the conversation: ${error.message || "unknown error"}`
      : !history.loaded ? "Loading conversation…"
        : turns.length === 0 ? "No conversation yet. Send a message below." : "";
    stateLine.textContent = message;
    stateLine.hidden = !message;
    stateLine.classList.toggle("is-error", Boolean(error));
    retryButton.hidden = !error;
    drawActivity();
    // the find bar marks the turns again when they changed (chat-find.js)
    onDrawn({ turns: changed });
    if (!visible) return;
    if (anchor) scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
    else if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function redrawTurn(key) {
    const known = drawn.get(key);
    if (!known) return;
    const node = turnElement(known.turn, key, known.live);
    known.node.replaceWith(node);
    known.node = node;
    onDrawn({ turns: true });
  }

  async function loadWholeOutput(toolId) {
    const turnKey = [...drawn.entries()].find(([, value]) => value.turn.parts.some((part) => part.kind === "tool" && part.id === toolId))?.[0];
    wholeOutputs.set(toolId, { state: "loading" });
    if (turnKey) redrawTurn(turnKey);
    try {
      const result = await fetchJson(`/api/panes/${encodeURIComponent(paneId)}/conversation/tools/${encodeURIComponent(toolId)}`, {});
      wholeOutputs.set(toolId, { state: "done", text: String(result.payload?.output ?? "") });
    } catch {
      wholeOutputs.set(toolId, { state: "failed" });
    }
    if (turnKey) redrawTurn(turnKey);
  }

  async function loadOlder() {
    if (olderState === "loading" || typeof loader.history.olderCursor !== "string") return;
    olderState = "loading";
    render({});
    await loader.loadOlder();
    if (olderState === "loading") olderState = "idle";
    render({});
  }

  // --- events ---------------------------------------------------------------

  // Only the reader scrolling up lets go of the end. The view getting shorter
  // under the reader (the prompt card, the keyboard, a taller composer) is no
  // scroll of theirs: a scroll event that lands after it, before the end is
  // caught up with, must not stop the following.
  let lastTop = 0;
  scroller.addEventListener("scroll", () => {
    if (!visible) return;
    const top = scroller.scrollTop;
    if (atBottom()) stick = true;
    else if (top < lastTop - 1) stick = false;
    lastTop = top;
    if (stick && !atBottom()) scroller.scrollTop = scroller.scrollHeight;
    if (stick) jumpButton.hidden = true;
    else if (jumpButton.hidden) {
      jumpButton.textContent = "Jump to latest";
      jumpButton.hidden = false;
    }
    if (scroller.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  }, { passive: true });

  // A resized composer or a raised keyboard shrinks the view without a scroll:
  // a reader at the end stays there.
  const resizes = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => { if (visible && stick) scroller.scrollTop = scroller.scrollHeight; })
    : null;
  resizes?.observe(scroller);

  // A copy that worked shows a check on its button for a moment; one that
  // failed says why in the page's feedback line.
  function copied(button, ok) {
    if (!ok) { onCopy(false); return; }
    button.classList.add("is-copied");
    clearTimeout(button.copiedTimer);
    button.copiedTimer = setTimeout(() => button.classList.remove("is-copied"), COPIED_MS);
  }

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const path = target?.closest("[data-path]");
    if (path && root.contains(path)) {
      event.preventDefault();
      onOpenPath(path.dataset.path);
      return;
    }
    const action = target?.closest("[data-action]");
    if (!action || !root.contains(action)) return;
    switch (action.dataset.action) {
      case "older": void loadOlder(); break;
      case "retry": error = null; render({}); loader.refresh({ now: true }); break;
      case "jump": scrollToBottom(); break;
      case "view-terminal": onViewInTerminal(); break;
      case "copy-text": void copyText(action.dataset.copy ?? "", document).then((ok) => copied(action, ok)); break;
      case "copy-code": {
        const code = action.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
        void copyText(code, document).then((ok) => copied(action, ok));
        break;
      }
      case "unfold-code": {
        const block = action.closest(".md-code");
        const expanded = block.classList.toggle("is-expanded");
        action.setAttribute("aria-expanded", String(expanded));
        action.textContent = expanded ? "Show less" : `Show all ${action.dataset.lines} lines`;
        break;
      }
      case "toggle-block": {
        const key = action.closest("[data-block]")?.dataset.block;
        if (!key) break;
        blockChoice.set(key, action.getAttribute("aria-expanded") !== "true");
        redrawTurn(key);
        break;
      }
      case "toggle-row": {
        const key = action.closest("[data-row]")?.dataset.row;
        if (!key) break;
        if (openRows.has(key)) openRows.delete(key); else openRows.add(key);
        // reading inside the block is a choice to keep it open when the turn settles
        const blockKey = key.slice(0, key.lastIndexOf("#"));
        if (!blockChoice.has(blockKey)) blockChoice.set(blockKey, true);
        redrawTurn(blockKey);
        break;
      }
      case "whole-output": void loadWholeOutput(action.dataset.toolId); break;
      default: break;
    }
  });

  return {
    paneId,
    root,
    loader,
    // What find in the conversation searches (chat-find.js): the drawn turns,
    // the view they scroll in, and the pages before them not read yet.
    findRoot: turnsHost,
    scroller,
    older: () => ({ more: typeof loader.history.olderCursor === "string", state: olderState }),
    loadOlder: () => loadOlder(),
    // Reads the newest page (on first use, on a change, on a send).
    refresh({ now = false } = {}) { loader.refresh({ now }); },
    // Back to the end, and following it (a message was just sent).
    follow() {
      stick = true;
      jumpButton.hidden = true;
      if (visible) scroller.scrollTop = scroller.scrollHeight;
    },
    // A message the composer just sent: shown at the end as on its way, with
    // the working row, until the transcript has it.
    // Returns the pending message it shows, or null, so a failed send takes
    // back only its own.
    sent(text) {
      const now = Date.now();
      const message = typeof text === "string" && text.trim() ? pendingMessage(text, loader.history.turns, now) : null;
      if (message) pending = [...pending, message];
      optimisticUntil = now + OPTIMISTIC_MS;
      if (status !== "working") workingSince = now;
      drawActivity();
      stick = true;
      jumpButton.hidden = true;
      keepAtEnd();
      return message;
    },
    // The message answered a password prompt: it never shows, though the
    // pane still works on it.
    // The message sent, once known to be no password answer: shown on its way
    // until the transcript has it.
    pend(text) {
      if (typeof text !== "string" || !text.trim()) return null;
      const message = pendingMessage(text, loader.history.turns, Date.now());
      pending = [...pending, message];
      drawActivity();
      if (stick) keepAtEnd();
      return message;
    },
    // The send failed: nothing is on its way.
    unsent(message) {
      pending = pending.filter((item) => item !== message);
      optimisticUntil = 0;
      drawActivity();
    },
    setAgent(next) {
      if (!next || next === agent) return;
      agent = next;
      activityKey = null;
      drawActivity();
    },
    setStatus(next) {
      if (next === status) return;
      // a status that answers the send ends the guess
      if (next !== null) optimisticUntil = 0;
      if (next === "working" && status !== "working" && workingSince === null) workingSince = Date.now();
      status = next;
      if (loader.history.loaded) render({});
      else { drawActivity(); keepAtEnd(); }
    },
    show() {
      if (visible) return;
      visible = true;
      root.hidden = false;
      render({});
      if (stick) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = savedScrollTop;
      clearInterval(backstop);
      backstop = setInterval(() => loader.refresh(), BACKSTOP_MS);
      drawActivity();
      keepAtEnd();
    },
    hide() {
      if (!visible) return;
      savedScrollTop = scroller.scrollTop;
      visible = false;
      root.hidden = true;
      clearInterval(backstop);
      backstop = null;
      clearInterval(ticker);
      ticker = null;
    },
    get visible() { return visible; },
    get scrollTop() { return scroller.scrollTop; },
    destroy() {
      clearInterval(backstop);
      clearInterval(ticker);
      loader.stop();
      resizes?.disconnect();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// The lens switch for the selected pane.

// `connection` is the page's terminal socket (watchConversation /
// unwatchConversation / onConversation). `fetchJson(path, { etag })` answers
// { payload, etag } or { notModified: true }, and throws errors with status,
// code and details. `layout()` answers { compact, touch }.
export function createChatLens({ document = globalThis.document, stage, host, chatButton, terminalButton, group,
  storage, layout, connection, fetchJson, isLinkablePath = () => false, onOpenPath = () => {}, onCopy = () => {},
  onLensChange = () => {}, onChatDrawn = () => {} }) {
  const chats = new Map();
  // paneId -> { state: "checking" | "available" | "unavailable", reason, checkedAt }
  const availability = new Map();
  let paneId = null;
  // the agent whose conversation the pane shown has ("claude", "codex"), or null
  let agentName = null;
  let lens = "terminal";
  let watched = null;
  // The lens and pane last told to onLensChange.
  let reported = { lens: "terminal", paneId: null };
  // Lenses chosen on this page, ahead of storage (which may refuse to keep them).
  const chosen = new Map();
  const shortcut = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? "") ? "Cmd+J" : "Ctrl+J";

  function chatFor(id) {
    let chat = chats.get(id);
    if (chat) {
      chats.delete(id);
      chats.set(id, chat);
      return chat;
    }
    chat = createPaneChat({
      paneId: id, document, fetchJson, isLinkablePath, onOpenPath, onCopy,
      onViewInTerminal: () => setLens("terminal"),
      onDrawn: (drawn) => onChatDrawn(chat, drawn),
      onAvailability: ({ available, reason = null }) => {
        const before = availability.get(id);
        availability.set(id, available ? { state: "available", reason: null, checkedAt: Date.now() }
          : { state: "unavailable", reason, checkedAt: Date.now() });
        if (before?.state !== availability.get(id).state || before?.reason !== reason) apply();
      },
    });
    host.append(chat.root);
    chats.set(id, chat);
    while (chats.size > KEPT_CHATS) {
      const [oldest, dropped] = chats.entries().next().value;
      if (oldest === paneId) break;
      dropped.destroy();
      chats.delete(oldest);
      // read afresh if it is shown again
      availability.delete(oldest);
    }
    return chat;
  }

  function chatAvailable(id) {
    const known = availability.get(id);
    return known?.state === "available" || known?.state === "checking";
  }

  function unavailableReason(id) {
    if (!agentName) return "not_supported_agent";
    return availability.get(id)?.reason ?? null;
  }

  function watch(id) {
    if (watched === id) return;
    if (watched !== null) connection.unwatchConversation(watched);
    watched = id;
    if (id !== null) connection.watchConversation(id);
  }

  function apply() {
    const available = paneId !== null && agentName !== null && chatAvailable(paneId);
    const { compact, touch } = layout();
    const next = paneId === null ? "terminal"
      : chooseLens({ stored: chosen.get(paneId) ?? readPaneLens(storage, paneId), chatAvailable: available, compact, touch });
    const changed = next !== reported.lens || paneId !== reported.paneId;
    lens = next;
    // hidden first, while its place is still read: a hidden chat keeps its scroll
    for (const [id, chat] of chats) if (id !== paneId || lens !== "chat") chat.hide();
    stage.dataset.lens = lens;
    if (lens === "chat") chats.get(paneId)?.show();
    chatButton.setAttribute("aria-pressed", String(lens === "chat"));
    terminalButton.setAttribute("aria-pressed", String(lens === "terminal"));
    chatButton.setAttribute("aria-disabled", String(!available));
    chatButton.title = available ? `Show the conversation (${shortcut})` : chatUnavailableText(unavailableReason(paneId));
    terminalButton.title = `Show the terminal (${shortcut})`;
    group.hidden = paneId === null;
    watch(lens === "chat" ? paneId : null);
    if (changed) {
      const previous = reported;
      reported = { lens, paneId };
      onLensChange(lens, paneId, previous);
    }
  }

  function setLens(next) {
    if (paneId === null) return;
    if (next === "chat" && !(agentName !== null && chatAvailable(paneId))) return;
    chosen.set(paneId, next);
    writePaneLens(storage, paneId, next);
    apply();
  }

  chatButton.addEventListener("click", () => {
    if (chatButton.getAttribute("aria-disabled") === "true") return;
    setLens("chat");
  });
  terminalButton.addEventListener("click", () => setLens("terminal"));

  connection.onConversation((message) => {
    const chat = chats.get(message.pane_id);
    if (!chat) return;
    // Changed, or the server cannot watch it (too many watched, or no monitor):
    // read it now either way; a conversation that is gone answers 404 and the
    // pane falls back to its terminal.
    chat.refresh();
  });
  // A new socket watches nothing: the chat reads what changed meanwhile.
  connection.onReconnect(() => { if (watched !== null) chats.get(watched)?.refresh(); });

  return {
    // A pane carried to another project has a new id: its lens choice follows.
    // A chat is bound to the id it reads by, so the old one is let go and the
    // new id reads its conversation afresh when it is shown.
    renamePanes(moves) {
      for (const [from, to] of paneRenames(moves)) {
        if (chosen.has(from)) { chosen.set(to, chosen.get(from)); chosen.delete(from); }
        const old = chats.get(from);
        if (old) { old.destroy(); chats.delete(from); }
        availability.delete(from);
        if (watched === from) { connection.unwatchConversation(from); watched = null; }
        if (reported.paneId === from) reported = { ...reported, paneId: to };
        if (paneId === from) paneId = to;
      }
    },
    // The pane shown now, the agent the snapshot names for it when the chat
    // reads that agent ("claude", "codex"; `claude: true` is "claude"), and its status.
    select(nextPaneId, { agent = null, claude = false, status = null } = {}) {
      paneId = nextPaneId ?? null;
      agentName = typeof agent === "string" && agent ? agent : claude ? "claude" : null;
      if (paneId !== null && agentName !== null) {
        const known = availability.get(paneId);
        const stale = known?.state === "unavailable" && chatMayBecomeAvailable(known.reason) && Date.now() - known.checkedAt > RECHECK_MS;
        const chat = chatFor(paneId);
        chat.setAgent(agentName);
        chat.setStatus(status);
        if (!known || stale) {
          if (!known) availability.set(paneId, { state: "checking", reason: null, checkedAt: Date.now() });
          else known.checkedAt = Date.now();
          chat.refresh({ now: true });
        }
      }
      apply();
    },
    setStatus(id, status) { chats.get(id)?.setStatus(status); },
    toggle() { setLens(lens === "chat" ? "terminal" : "chat"); },
    showTerminal() { setLens("terminal"); },
    // Switches to the Chat lens; false when this pane has none.
    showChat() {
      if (paneId === null || !(agentName !== null && chatAvailable(paneId))) return false;
      setLens("chat");
      return lens === "chat";
    },
    get chatAvailable() { return paneId !== null && agentName !== null && chatAvailable(paneId); },
    // A message went out from the composer: the chat shows it on its way and
    // goes to the end, following what comes, wherever the reader had scrolled.
    sent(id, text) {
      const chat = chats.get(id);
      if (!chat?.visible) return null;
      const message = chat.sent(text);
      chat.refresh({ now: true });
      return message;
    },
    unsent(id, message) { chats.get(id)?.unsent(message); },
    pend(id, text) { const chat = chats.get(id); return chat?.visible ? chat.pend(text) : null; },
    get lens() { return lens; },
    get paneId() { return paneId; },
    chatFor: (id) => chats.get(id) ?? null,
  };
}
