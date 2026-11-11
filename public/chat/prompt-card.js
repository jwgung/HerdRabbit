// A pane's prompt card: what an agent asks (a tool approval, a question, a
// menu) with a button per answer, or a panel its own `/` command opened with
// a button per key. The server reads it off the pane's screen (src/prompt/)
// and pushes it over the terminal socket while the selected pane is one of
// the agents in public/agents.js with `card`, or is blocked; a button posts
// the answer, and the server sends the keys. The card sits at the bottom of the Chat lens, over the
// composer. Over the Terminal lens a banner says the agent is asking: it
// switches to the Chat lens, or, for a pane without one, opens the same card
// over the bottom of the terminal.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/components/PromptCard.tsx
// and PromptCard.css, rewritten as plain DOM code without React.
import { agentLabel } from "./chat-activity.js?v=1.4.52";
import { agentNamesWith } from "../agents.js?v=1.4.52";

// After an answer, the card is looked for once more this much later.
const RECHECK_AFTER_ANSWER_MS = 1_500;

// The agents whose panes the server reads whatever their status: by a reader
// of their own, or for their panels (public/agents.js).
const READ_AGENTS = Object.freeze(agentNamesWith("card"));

// Such a pane is asked for its card whatever herdr says
// it is doing (it does not always say blocked while a menu waits); any other
// pane only while it is blocked.
export function shouldWatchPrompt(status, agent = null) {
  return READ_AGENTS.includes(agent) || status === "blocked";
}

// Claude draws its menu's own pick as "Redis (Recommended)": a tag reads better.
export function optionLabel(label) {
  const text = String(label).replace(/\s*\(recommended\)$/i, "");
  return { text, recommended: text !== label };
}

// The POST body for an answer: one option, several (a multiple choice), a
// typed answer, or an action ("chat": Claude's "Chat about this" row).
export function answerBody(card, choice) {
  if (choice.action !== undefined) return { cardId: card.id, action: choice.action };
  if (choice.text !== undefined) return { cardId: card.id, text: String(choice.text).trim() };
  if (choice.options !== undefined) return { cardId: card.id, options: [...choice.options].sort((a, b) => a - b) };
  return { cardId: card.id, option: choice.option };
}

// The option a number typed in the composer picks ("2" is the second
// button), or null: only a card answered with one button, and only a number
// that names one of its buttons.
export function numberedChoice(card, text) {
  // a panel's keys have no numbers: what is typed goes to the panel
  if (!card || card.multiSelect || card.panel) return null;
  const match = /^\s*(\d{1,2})\s*$/u.exec(String(text ?? ""));
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (index < 0 || index >= card.options.length || index === card.customOptionIndex) return null;
  return index;
}

// What the composer says while such a card waits: the numbers that answer it.
export function composerPlaceholder(card) {
  if (card?.panel) return "Typing goes to the open panel";
  if (!card || card.multiSelect) return "";
  const numbers = card.options.map((_, index) => index).filter((index) => index !== card.customOptionIndex);
  if (numbers.length === 0) return "";
  const first = numbers[0] + 1;
  const last = numbers.at(-1) + 1;
  return `Type ${first === last ? first : `${first}–${last}`} to answer, or a message`;
}

// The answer in words, for the line the chat shows until the agent goes on.
export function answerSummary(card, choice) {
  if (choice.action === "chat") return "Chat about this";
  if (choice.text !== undefined) return String(choice.text).trim();
  const label = (index) => (card.options[index] ? optionLabel(card.options[index].label).text : "");
  if (choice.options !== undefined) return [...choice.options].sort((a, b) => a - b).map(label).filter(Boolean).join(", ");
  return label(choice.option);
}

// A multiple choice starts from what is ticked in the terminal already: the
// answer is the whole set wanted, so an untouched card keeps those ticks.
export function initialSelection(card) {
  const count = card?.options?.length ?? 0;
  return new Set((card?.multiSelect ? card.checked ?? [] : []).filter((index) => Number.isInteger(index) && index >= 0 && index < count));
}

// What tells one card from the next for the controls: another prompt, or
// other ticks made in the terminal.
export function cardVersion(card) {
  return card ? `${card.id}:${(card.checked ?? []).join(",")}` : null;
}

// What a Claude question card's context is compared by: its words, without
// the marks the terminal draws Markdown with or leaves out (emphasis, code
// ticks, headings, quotes, list marks) and without table borders.
function plainWords(text) {
  return String(text ?? "").replace(/[*_`#>~]/gu, "").replace(/[\u2500-\u257f|]/gu, " ").replace(/\s+/gu, " ").trim();
}

// The context's first line with real words in it (a table's border has none),
// its list mark left out, at most 80 characters: what the chat shows once the
// transcript has the message.
export function contextKey(context) {
  for (const line of String(context ?? "").split("\n")) {
    const words = plainWords(line.replace(/^\s*(?:[-•*]|\d+\.)\s+/u, ""));
    if (words.length >= 12 && /[\p{L}\p{N}]/u.test(words)) return words.slice(0, 80);
  }
  return null;
}

// Whether the card shows the text the terminal has above the question
// (`card.context`: Claude's message before an AskUserQuestion, which Claude
// Code writes to its transcript only once the question is answered).
//
// The rule: shown until the conversation loaded in the chat has it, that is,
// until the text of the chat's last agent turns (`conversation`) contains the
// context's first line of real words (contextKey), both read without Markdown
// marks and table borders. Claude writes the message and the question to the
// transcript together, so finding that line means the chat now shows the
// message itself; it is checked again whenever the chat redraws, so the card
// drops it without a reload. A line too short to tell keeps it shown. A card
// with no context shows none.
export function contextVisible(card, conversation) {
  if (typeof card?.context !== "string" || !card.context.trim()) return false;
  const key = contextKey(card.context);
  if (!key) return true;
  return !plainWords(conversation).includes(key);
}

export function bannerText(card) {
  if (!card) return "";
  if (card.panel) return `${agentLabel(card.agent)} has a panel open: ${card.title}`;
  return card.fallback ? "This pane is waiting for input" : `${agentLabel(card.agent)} is asking: ${card.title}`;
}

// What the dock shows: nothing, the card (Chat lens, or opened over the
// terminal), or the banner over the terminal.
export function dockMode({ card, lens, dismissed = false, expanded = false }) {
  if (!card) return "hidden";
  if (lens === "chat") return "card";
  if (expanded) return "overlay";
  return dismissed ? "hidden" : "banner";
}

function element(document, tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  return node;
}

// A panel an agent's own `/` command opened (src/prompt/panel.mjs): its
// tabs, its text as the terminal shows it, and a button per key it takes.
// A key goes as it is; the card stays while the panel does.
function renderPanel(document, card, view) {
  const section = element(document, "section", { className: "prompt-card is-panel",
    attrs: { role: "region", "aria-label": `${agentLabel(card.agent)} panel`, "aria-busy": String(view.pending), "data-card-id": card.id } });
  const header = element(document, "header", { className: "prompt-card-header" });
  const named = card.panelName ? ` · ${card.panelName}` : "";
  header.append(element(document, "p", { className: "prompt-card-status", text: `${agentLabel(card.agent)}${named} · panel open` }),
    element(document, "h2", { text: card.title }));
  if (view.overlay) {
    header.append(element(document, "button", { className: "prompt-card-close", text: "Close",
      attrs: { type: "button", "data-prompt-action": "collapse", title: "Back to the banner" } }));
  }
  section.append(header);
  if (Array.isArray(card.tabs) && card.tabs.length > 0) {
    const tabs = element(document, "ul", { className: "prompt-panel-tabs", attrs: { "aria-label": "Tabs" } });
    for (const tab of card.tabs) {
      tabs.append(element(document, "li", { className: tab.selected ? "is-selected" : "", text: tab.label,
        attrs: tab.selected ? { "aria-current": "true" } : {} }));
    }
    section.append(tabs);
  }
  if (card.question) section.append(element(document, "p", { className: "prompt-card-question", text: card.question }));
  if (card.body) section.append(element(document, "pre", { className: "prompt-panel-screen", text: card.body, attrs: { tabindex: "0" } }));
  const keys = element(document, "div", { className: "prompt-panel-keys", attrs: { role: "group", "aria-label": "Keys" } });
  for (const [index, option] of card.options.entries()) {
    const button = element(document, "button", { className: `prompt-panel-key${option.label === "Esc" ? " is-close" : ""}`,
      attrs: { type: "button", "data-prompt-option": String(index), title: option.description ? `${option.label}: ${option.description}` : option.label } });
    button.disabled = view.pending;
    button.append(element(document, "kbd", { text: option.label }));
    if (option.description) button.append(element(document, "span", { text: option.description }));
    keys.append(button);
  }
  section.append(keys);
  if (view.error) section.append(element(document, "p", { className: "prompt-card-error", text: view.error, attrs: { role: "alert" } }));
  return section;
}

// "Open plan": a plan's file (its Markdown) in the viewer, larger than any
// card or cell shows it.
function planButton(document, className) {
  return element(document, "button", { className, text: "Open plan",
    attrs: { type: "button", "data-prompt-action": "plan", title: "Read the plan in the viewer" } });
}

function renderCard(document, card, view) {
  if (card.panel) return renderPanel(document, card, view);
  const section = element(document, "section", { className: `prompt-card${card.fallback ? " is-fallback" : ""}`,
    attrs: { role: "region", "aria-label": card.fallback ? "Waiting for input" : `${agentLabel(card.agent)} is asking`, "aria-busy": String(view.pending), "data-card-id": card.id } });
  const header = element(document, "header", { className: "prompt-card-header" });
  // said in words, not only by the card being there
  header.append(element(document, "p", { className: "prompt-card-status", text: "Needs your answer" }),
    element(document, "h2", { text: card.title }));
  if (view.plan) header.append(planButton(document, "prompt-card-plan"));
  if (view.overlay) {
    header.append(element(document, "button", { className: "prompt-card-close", text: "Close",
      attrs: { type: "button", "data-prompt-action": "collapse", title: "Back to the banner" } }));
  }
  section.append(header);
  if (view.context) {
    // the terminal's text, as text: never parsed as HTML or Markdown
    const details = element(document, "details", { className: "prompt-card-context" });
    details.open = view.contextOpen === true;
    details.append(element(document, "summary", { text: `${agentLabel(card.agent)}'s message above this question (from the terminal)` }),
      element(document, "pre", { className: "prompt-card-context-text", text: card.context, attrs: { tabindex: "0" } }));
    section.append(details);
  }
  if (card.question && card.question !== card.title) section.append(element(document, "p", { className: "prompt-card-question", text: card.question }));
  if (card.body) section.append(element(document, "pre", { className: `prompt-card-body${card.body.includes("\n") ? "" : " is-line"}`, text: card.body }));
  const choices = card.options.map((option, index) => ({ option, index })).filter(({ index }) => index !== card.customOptionIndex);
  if (choices.length > 0) {
    const options = element(document, "div", { className: "prompt-card-options",
      attrs: card.multiSelect ? { role: "group", "aria-label": card.question || card.title } : {} });
    for (const { option, index } of choices) {
      const { text, recommended } = optionLabel(option.label);
      const content = element(document, "span", { className: "prompt-card-option-text" });
      const label = element(document, "span", { className: "prompt-card-option-label", text });
      if (recommended) label.append(document.createTextNode(" "), element(document, "span", { className: "prompt-card-tag", text: "Recommended" }));
      content.append(label);
      if (option.description) content.append(element(document, "span", { className: "prompt-card-option-description", text: option.description }));
      const number = element(document, "span", { className: "prompt-card-number", text: String(index + 1), attrs: { "aria-hidden": "true" } });
      if (card.multiSelect) {
        const row = element(document, "label", { className: `prompt-card-option${view.selected.has(index) ? " is-checked" : ""}` });
        const box = element(document, "input", { attrs: { type: "checkbox", "data-prompt-toggle": String(index) } });
        box.checked = view.selected.has(index);
        box.disabled = view.pending;
        row.append(box, number, content);
        options.append(row);
      } else {
        const button = element(document, "button", { className: `prompt-card-option${view.preview === index ? " is-previewed" : ""}`, attrs: { type: "button", "data-prompt-option": String(index) } });
        button.disabled = view.pending;
        button.append(number, content);
        options.append(button);
      }
    }
    section.append(options);
  }
  if (card.multiSelect) {
    const submit = element(document, "button", { className: `prompt-card-submit${view.selected.size > 0 ? " primary-button" : " secondary-button"}`,
      text: view.selected.size > 0 ? `Submit (${view.selected.size})` : "Submit", attrs: { type: "button", "data-prompt-action": "submit" } });
    submit.disabled = view.pending || view.selected.size === 0;
    section.append(submit);
  }
  if (card.customOptionIndex !== null && card.customOptionIndex !== undefined) {
    const custom = element(document, "div", { className: "prompt-card-custom" });
    const input = element(document, "input", { className: "prompt-card-custom-input",
      attrs: { type: "text", "aria-label": "Your own answer", placeholder: "Or type your own answer", "data-prompt-custom": "", maxlength: "4000" } });
    input.value = view.custom;
    input.disabled = view.pending;
    const send = element(document, "button", { className: "secondary-button", text: "Send", attrs: { type: "button", "data-prompt-action": "custom" } });
    send.disabled = view.pending || view.custom.trim().length === 0;
    custom.append(input, send);
    section.append(custom);
  }
  if (card.chat) {
    // Claude's own last row: leaves the menu to talk the question over
    const chat = element(document, "button", { className: "secondary-button prompt-card-chat", text: "Chat about this",
      attrs: { type: "button", "data-prompt-action": "chat", title: "Pick “Chat about this” in the terminal: leave the menu and talk it over" } });
    chat.disabled = view.pending;
    section.append(chat);
  }
  if (view.error) section.append(element(document, "p", { className: "prompt-card-error", text: view.error, attrs: { role: "alert" } }));
  return section;
}

// The page's prompt watches shared by several cards: the selected pane's
// dock and one per Chat cell of a split may watch the same pane while the
// focus moves between them. Each pane is asked for once and let go when the
// last card lets go of it; a card that joins hears the card last pushed for
// it, as the first one did when the server began watching. A pane the server
// could not watch is let go at once (every card hears why, and asks again
// later). `onPrompt` answers a function that stops that listener.
export function sharedPromptWatch(connection) {
  const counts = new Map();
  const pushed = new Map();
  const listeners = new Set();
  const tell = (message) => { for (const listener of [...listeners]) listener(message); };
  connection.onPrompt((message) => {
    if (message.type === "prompt-unavailable" && counts.has(message.pane_id)) {
      counts.delete(message.pane_id);
      pushed.delete(message.pane_id);
      connection.unwatchPrompt(message.pane_id);
    }
    if (message.type === "prompt" && counts.has(message.pane_id)) pushed.set(message.pane_id, message);
    tell(message);
  });
  return {
    watchPrompt(paneId) {
      const count = counts.get(paneId) ?? 0;
      counts.set(paneId, count + 1);
      if (count === 0) { connection.watchPrompt(paneId); return; }
      const known = pushed.get(paneId);
      if (known) queueMicrotask(() => { if (pushed.get(paneId) === known) tell(known); });
    },
    unwatchPrompt(paneId) {
      const count = counts.get(paneId) ?? 0;
      if (count === 0) return;
      if (count > 1) { counts.set(paneId, count - 1); return; }
      counts.delete(paneId);
      pushed.delete(paneId);
      connection.unwatchPrompt(paneId);
    },
    onPrompt(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// `dock` is the element in the pane's stage. `connection` is the page's
// terminal socket (watchPrompt / unwatchPrompt / onPrompt / onReconnect).
// `getJson(path)` and `postJson(path, body)` answer the payload or throw
// errors with status and code. `showChat()` switches the pane to its Chat
// lens and answers whether it could.
// `conversation(paneId)` answers the text of the chat's last agent turns for
// that pane ("" when none is loaded), for contextVisible.
// `onAnswered(paneId, summary)` hears each answer that went out, in words.
// `onCardChange(card)` hears whenever the card the composer can answer comes,
// changes or goes (null while the dock is hidden).
export function createPromptDock({ document = globalThis.document, dock, connection, getJson, postJson,
  showChat = () => false, onAnswered = () => {}, onCardChange = () => {}, conversation = () => "", openPlan = null }) {
  let paneId = null;
  let status = null;
  // a plan's file can be opened here
  const plannable = (shown) => typeof openPlan === "function" && typeof shown?.planPath === "string" && shown.planPath !== "";
  let agentName = null;
  let lens = "terminal";
  let watched = null;
  let card = null;
  let expanded = false;
  // Banners closed on this page, by card id: the same prompt asked again has another id only if it changed.
  const dismissed = new Set();
  // What the shown card's controls hold.
  let view = { pending: false, error: null, selected: new Set(), custom: "", preview: null };
  let drawn = null;
  // The card last told to onCardChange.
  let announced = null;
  // The answer on its way, if any.
  let answering = null;
  // Whether the card's context is open, kept across redraws of the same card.
  let contextOpen = false;
  // the card after an answer that left the menu up (Kiro's Change scope)
  // stays open as this one was
  let keepOpen = false;

  function resetView() {
    view = { pending: false, error: null, selected: initialSelection(card), custom: "", preview: null };
  }

  function setCard(next, { keepError = false } = {}) {
    const changed = cardVersion(next ?? null) !== cardVersion(card);
    const moved = (next?.id ?? null) !== (card?.id ?? null);
    // a prompt that went is answered: the same one asked again shows its banner again
    if (moved && card) dismissed.delete(card.id);
    card = next ?? null;
    if (moved) contextOpen = false;
    // an answer on its way ticks the card itself: its controls wait for it
    if (changed && !(view.pending && card)) {
      const error = keepError ? view.error : null;
      resetView();
      view.error = error;
      if (moved && !(keepOpen && card)) expanded = false;
    }
    if (moved) keepOpen = false;
    render();
  }

  function watch(id) {
    if (watched === id) return;
    if (watched !== null) connection.unwatchPrompt(watched);
    watched = id;
    if (id !== null) connection.watchPrompt(id);
  }

  function render() {
    const mode = dockMode({ card, lens, dismissed: card ? dismissed.has(card.id) : false, expanded });
    dock.dataset.mode = mode;
    dock.hidden = mode === "hidden";
    // the card the composer can answer: none while the dock is hidden
    // (dismissed, or no card), whatever the reason
    const answerable = mode === "hidden" ? null : card;
    if (answerable !== announced) {
      announced = answerable;
      onCardChange(answerable);
    }
    let context = false;
    try { context = mode !== "hidden" && mode !== "banner" && contextVisible(card, paneId === null ? "" : conversation(paneId)); } catch { context = Boolean(card?.context); }
    // a panel's words change under the same id (another tab, figures that tick)
    const words = card?.panel ? JSON.stringify([card.title, card.body, card.tabs, card.options, card.question]) : "";
    const key = mode === "hidden" ? null : `${mode}|${card.id}|${words}|${view.pending}|${view.error}|${[...view.selected].join(",")}|${mode === "banner" ? "" : view.custom}|${context ? card.context : ""}|${view.preview}|${plannable(card) ? card.planPath : ""}`;
    if (key === drawn) return;
    // the typed answer keeps its focus and caret across a redraw
    const focused = dock.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset?.promptOption ?? focused?.dataset?.promptToggle ?? (focused?.hasAttribute?.("data-prompt-custom") ? "custom" : focused?.dataset?.promptAction ?? null);
    const caret = focused?.hasAttribute?.("data-prompt-custom") ? focused.selectionStart : null;
    drawn = key;
    dock.replaceChildren();
    if (mode === "hidden") return;
    if (mode === "banner") {
      const banner = element(document, "div", { className: "prompt-banner", attrs: { role: "status" } });
      const open = element(document, "button", { className: "prompt-banner-open", attrs: { type: "button", "data-prompt-action": "open" } });
      open.append(element(document, "span", { className: "prompt-banner-dot", attrs: { "aria-hidden": "true" } }),
        element(document, "span", { className: "prompt-banner-text", text: bannerText(card) }),
        element(document, "span", { className: "prompt-banner-action", text: card.panel ? "Open" : "Answer" }));
      const close = element(document, "button", { className: "prompt-banner-close", text: "×",
        attrs: { type: "button", "data-prompt-action": "dismiss", "aria-label": "Dismiss", title: "Dismiss" } });
      banner.append(open);
      if (plannable(card)) banner.append(planButton(document, "prompt-banner-plan"));
      banner.append(close);
      dock.append(banner);
      return;
    }
    dock.append(renderCard(document, card, { ...view, overlay: mode === "overlay", context, contextOpen, plan: plannable(card) }));
    if (focusKey !== null) {
      const again = focusKey === "custom" ? dock.querySelector("[data-prompt-custom]")
        : dock.querySelector(`[data-prompt-option="${focusKey}"], [data-prompt-toggle="${focusKey}"], [data-prompt-action="${focusKey}"]`);
      if (again && !again.disabled) {
        again.focus({ preventScroll: true });
        if (caret !== null) again.setSelectionRange?.(caret, caret);
      }
    }
  }

  async function refresh() {
    if (paneId === null) return;
    const id = paneId;
    try {
      const payload = await getJson(`/api/panes/${encodeURIComponent(id)}/prompt`);
      if (id === paneId) setCard(payload?.card ?? null, { keepError: true });
    } catch {
      // the push brings the next card
    }
  }

  async function answer(choice) {
    if (!card || view.pending) return;
    const answered = card;
    const id = paneId;
    const token = {};
    answering = token;
    view.pending = true;
    view.error = null;
    render();
    try {
      const result = await postJson(`/api/panes/${encodeURIComponent(id)}/prompt/answer`, answerBody(answered, choice));
      if (answering === token && id === paneId) {
        answering = null;
        if (answered.panel) {
          // a panel's key: no answer for the chat to show; the push brings the panel as it is now
          view.pending = false;
          render();
          void refresh();
          return;
        }
        if (result?.stays || (card && card.id !== answered.id)) {
          // the next prompt is already here, or the menu is still up changed
          // (Kiro's Change scope): the card stays, ready to answer, and a
          // look brings the changed one
          view.pending = false;
          view.selected = initialSelection(card);
          render();
          onAnswered(id, answerSummary(answered, choice));
          if (result?.stays && card?.id === answered.id) {
            keepOpen = true;
            void refresh();
          }
          return;
        }
        // gone from the screen: the push confirms it a moment later, and a
        // look shortly after brings it back if the answer did not take
        setCard(null);
        onAnswered(id, answerSummary(answered, choice));
        setTimeout(() => { if (id === paneId && card === null) void refresh(); }, RECHECK_AFTER_ANSWER_MS);
      }
    } catch (error) {
      if (answering !== token || id !== paneId) return;
      answering = null;
      view.pending = false;
      // the card changed while the answer was out: its controls start again from it
      if (card && cardVersion(card) !== cardVersion(answered)) view.selected = initialSelection(card);
      if (error?.code === "prompt_changed" || error?.status === 409) {
        // a panel that closed or turned into another is simply looked at again
        view.error = answered.panel ? null : "The prompt changed. Check it and answer again.";
        render();
        await refresh();
        return;
      }
      view.error = error?.message || "Could not send the answer.";
      render();
    }
  }

  function focusCard() {
    const target = dock.querySelector(".prompt-card-option:not([disabled]), .prompt-card input:not([disabled]), .prompt-card button:not([disabled])");
    dock.querySelector(".prompt-card")?.scrollIntoView?.({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }

  dock.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const option = target?.closest("[data-prompt-option]");
    if (option && dock.contains(option)) { void answer({ option: Number(option.dataset.promptOption) }); return; }
    const action = target?.closest("[data-prompt-action]")?.dataset.promptAction;
    if (!action || !card) return;
    if (action === "plan") {
      if (plannable(card)) openPlan(paneId, card.planPath);
    } else if (action === "open") {
      if (!showChat()) expanded = true;
      render();
      focusCard();
    } else if (action === "dismiss") {
      dismissed.add(card.id);
      render();
    } else if (action === "collapse") {
      expanded = false;
      render();
    } else if (action === "submit") {
      void answer({ options: [...view.selected] });
    } else if (action === "custom") {
      if (view.custom.trim()) void answer({ text: view.custom });
    } else if (action === "chat") {
      if (card.chat) void answer({ action: "chat" });
    }
  });
  // "toggle" does not bubble: heard on the way down
  dock.addEventListener("toggle", (event) => {
    if (event.target instanceof Element && event.target.classList.contains("prompt-card-context")) contextOpen = event.target.open;
  }, true);
  dock.addEventListener("change", (event) => {
    const box = event.target instanceof Element ? event.target.closest("[data-prompt-toggle]") : null;
    if (!box) return;
    const index = Number(box.dataset.promptToggle);
    if (box.checked) view.selected.add(index); else view.selected.delete(index);
    render();
  });
  dock.addEventListener("input", (event) => {
    if (!(event.target instanceof Element) || !event.target.hasAttribute("data-prompt-custom")) return;
    view.custom = event.target.value;
    const send = dock.querySelector('[data-prompt-action="custom"]');
    if (send) send.disabled = view.pending || view.custom.trim().length === 0;
  });
  dock.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && expanded) { expanded = false; render(); return; }
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (!(event.target instanceof Element) || !event.target.hasAttribute("data-prompt-custom")) return;
    event.preventDefault();
    if (view.custom.trim()) void answer({ text: view.custom });
  });

  // The server could not watch the pane (too many watched): read it now, and
  // ask to watch it again in a while, as long as it is still the one wanted.
  const REWATCH_MS = 5_000;
  let rewatchTimer = null;
  const stopListening = connection.onPrompt((message) => {
    if (message.pane_id !== paneId) return;
    if (message.type === "prompt") { setCard(message.card ?? null); return; }
    void refresh();
    if (watched !== message.pane_id) return;
    const id = watched;
    watch(null);
    clearTimeout(rewatchTimer);
    rewatchTimer = setTimeout(() => {
      rewatchTimer = null;
      if (id === paneId && watched === null && shouldWatchPrompt(status, agentName)) watch(id);
    }, REWATCH_MS);
  });

  return {
    // The pane shown now, its agent and status: a Claude or Codex pane, or a
    // blocked one, is watched.
    select(nextPaneId, { status: nextStatus = null, agent: nextAgent = null } = {}) {
      agentName = nextAgent;
      const switched = nextPaneId !== paneId;
      paneId = nextPaneId ?? null;
      status = nextStatus;
      if (switched) { answering = null; view.pending = false; setCard(null); }
      const wanted = paneId !== null && shouldWatchPrompt(status, agentName);
      watch(wanted ? paneId : null);
      if (!wanted && card) setCard(null);
    },
    setLens(next) {
      if (next === lens) return;
      lens = next;
      if (lens === "chat") expanded = false;
      render();
    },
    focus: focusCard,
    // The chat redrew: the card's context may now be in it (contextVisible).
    conversationChanged() { render(); },
    // A number typed in the composer: the option it names shows as the one
    // Enter would pick (null clears it), and choose() answers with it.
    preview(index) {
      const next = Number.isInteger(index) ? index : null;
      if (next === view.preview) return;
      view.preview = next;
      render();
    },
    choose(index) {
      if (!card || view.pending || numberedChoice(card, String(index + 1)) !== index) return false;
      void answer({ option: index });
      return true;
    },
    get card() { return card; },
    get paneId() { return paneId; },
    get mode() { return dock.dataset.mode ?? "hidden"; },
    // A Chat cell's card that leaves: its pane is let go and nothing is heard.
    dispose() {
      clearTimeout(rewatchTimer);
      rewatchTimer = null;
      answering = null;
      paneId = null;
      watch(null);
      if (typeof stopListening === "function") stopListening();
    },
  };
}
