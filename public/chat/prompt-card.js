// A pane's prompt card: what a blocked agent asks (a tool approval, a
// question, a menu) with a button per answer. The server reads it off the
// pane's screen (src/prompt/) and pushes it over the terminal socket while
// the selected pane is a Claude or Codex pane or is blocked; a button posts the answer, and the server
// sends the keys. The card sits at the bottom of the Chat lens, over the
// composer. Over the Terminal lens a banner says the agent is asking: it
// switches to the Chat lens, or, for a pane without one, opens the same card
// over the bottom of the terminal.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/components/PromptCard.tsx
// and PromptCard.css, rewritten as plain DOM code without React.
import { agentLabel } from "./chat-activity.js?v=1.2.71";

// After an answer, the card is looked for once more this much later.
const RECHECK_AFTER_ANSWER_MS = 1_500;

// A Claude or Codex pane is asked for its card whatever herdr says it is
// doing (it does not always say blocked while a menu waits); any other pane
// only while it is blocked.
export function shouldWatchPrompt(status, agent = null) {
  return agent === "claude" || agent === "codex" || status === "blocked";
}

// Claude draws its menu's own pick as "Redis (Recommended)": a tag reads better.
export function optionLabel(label) {
  const text = String(label).replace(/\s*\(recommended\)$/i, "");
  return { text, recommended: text !== label };
}

// The POST body for an answer: one option, several (a multiple choice), or a typed answer.
export function answerBody(card, choice) {
  if (choice.text !== undefined) return { cardId: card.id, text: String(choice.text).trim() };
  if (choice.options !== undefined) return { cardId: card.id, options: [...choice.options].sort((a, b) => a - b) };
  return { cardId: card.id, option: choice.option };
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

export function bannerText(card) {
  if (!card) return "";
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

function renderCard(document, card, view) {
  const section = element(document, "section", { className: `prompt-card${card.fallback ? " is-fallback" : ""}`,
    attrs: { role: "region", "aria-label": card.fallback ? "Waiting for input" : `${agentLabel(card.agent)} is asking`, "aria-busy": String(view.pending), "data-card-id": card.id } });
  const header = element(document, "header", { className: "prompt-card-header" });
  header.append(element(document, "h2", { text: card.title }));
  if (view.overlay) {
    header.append(element(document, "button", { className: "prompt-card-close", text: "Close",
      attrs: { type: "button", "data-prompt-action": "collapse", title: "Back to the banner" } }));
  }
  section.append(header);
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
        const button = element(document, "button", { className: "prompt-card-option", attrs: { type: "button", "data-prompt-option": String(index) } });
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
  if (view.error) section.append(element(document, "p", { className: "prompt-card-error", text: view.error, attrs: { role: "alert" } }));
  return section;
}

// `dock` is the element in the pane's stage. `connection` is the page's
// terminal socket (watchPrompt / unwatchPrompt / onPrompt / onReconnect).
// `getJson(path)` and `postJson(path, body)` answer the payload or throw
// errors with status and code. `showChat()` switches the pane to its Chat
// lens and answers whether it could.
export function createPromptDock({ document = globalThis.document, dock, connection, getJson, postJson,
  showChat = () => false, onAnswered = () => {} }) {
  let paneId = null;
  let status = null;
  let agentName = null;
  let lens = "terminal";
  let watched = null;
  let card = null;
  let expanded = false;
  // Banners closed on this page, by card id: the same prompt asked again has another id only if it changed.
  const dismissed = new Set();
  // What the shown card's controls hold.
  let view = { pending: false, error: null, selected: new Set(), custom: "" };
  let drawn = null;
  // The answer on its way, if any.
  let answering = null;

  function resetView() {
    view = { pending: false, error: null, selected: initialSelection(card), custom: "" };
  }

  function setCard(next, { keepError = false } = {}) {
    const changed = cardVersion(next ?? null) !== cardVersion(card);
    const moved = (next?.id ?? null) !== (card?.id ?? null);
    // a prompt that went is answered: the same one asked again shows its banner again
    if (moved && card) dismissed.delete(card.id);
    card = next ?? null;
    // an answer on its way ticks the card itself: its controls wait for it
    if (changed && !(view.pending && card)) {
      const error = keepError ? view.error : null;
      resetView();
      view.error = error;
      if (moved) expanded = false;
    }
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
    const key = mode === "hidden" ? null : `${mode}|${card.id}|${view.pending}|${view.error}|${[...view.selected].join(",")}|${mode === "banner" ? "" : view.custom}`;
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
        element(document, "span", { className: "prompt-banner-action", text: "Answer" }));
      const close = element(document, "button", { className: "prompt-banner-close", text: "×",
        attrs: { type: "button", "data-prompt-action": "dismiss", "aria-label": "Dismiss", title: "Dismiss" } });
      banner.append(open, close);
      dock.append(banner);
      return;
    }
    dock.append(renderCard(document, card, { ...view, overlay: mode === "overlay" }));
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
      await postJson(`/api/panes/${encodeURIComponent(id)}/prompt/answer`, answerBody(answered, choice));
      if (answering === token && id === paneId) {
        answering = null;
        if (card && card.id !== answered.id) {
          // the next prompt is already here: it stays, ready to answer
          view.pending = false;
          view.selected = initialSelection(card);
          render();
          onAnswered(id);
          return;
        }
        // gone from the screen: the push confirms it a moment later, and a
        // look shortly after brings it back if the answer did not take
        setCard(null);
        onAnswered(id);
        setTimeout(() => { if (id === paneId && card === null) void refresh(); }, RECHECK_AFTER_ANSWER_MS);
      }
    } catch (error) {
      if (answering !== token || id !== paneId) return;
      answering = null;
      view.pending = false;
      // the card changed while the answer was out: its controls start again from it
      if (card && cardVersion(card) !== cardVersion(answered)) view.selected = initialSelection(card);
      if (error?.code === "prompt_changed" || error?.status === 409) {
        view.error = "The prompt changed. Check it and answer again.";
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
    if (action === "open") {
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
    }
  });
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
  connection.onPrompt((message) => {
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
    get card() { return card; },
    get mode() { return dock.dataset.mode ?? "hidden"; },
  };
}
