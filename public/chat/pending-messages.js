// Messages queued for the selected pane's next turn, listed over the
// composer in both lenses. The server holds the queue (src/pending-input.mjs)
// and pushes the list over the terminal socket whenever it changes; each row
// can be cancelled, edited while it waits, moved up or down, or sent now.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/components/PendingMessages.tsx
// and PendingMessages.css, rewritten as plain DOM code without React.

// While the agent works or asks something, a message waits for the next
// turn; so does one sent behind others that still wait, to keep their order.
export function shouldQueue({ status, items = [] } = {}) {
  return status === "working" || status === "blocked" || items.length > 0;
}

export function stateLabel(item) {
  if (item?.state === "sending") return "Sending…";
  if (item?.state === "failed") return "Not sent";
  return "Queued";
}

export function queueSummary(items) {
  const count = items.length;
  const failed = items.some((item) => item.state === "failed");
  const base = count === 1 ? "1 message for the next turn" : `${count} messages for the next turn`;
  return failed ? `${base} · held until the failed one is retried or removed` : base;
}

function element(document, tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  return node;
}

function actionButton(document, action, label, { text = label, disabled = false, className = "" } = {}) {
  const button = element(document, "button", {
    className: `pending-message-action${className ? ` ${className}` : ""}`,
    text,
    attrs: { type: "button", "data-pending-action": action, "aria-label": label, title: label },
  });
  button.disabled = disabled;
  return button;
}

// `connection` is the page's terminal socket (watchPending / unwatchPending /
// onPending). `getJson(path)` and `postJson(path, body)` answer the payload or
// throw errors with a message. `onChange(paneId, items)` hears every list,
// `onDelivered(paneId, text)` each message that reached the pane.
export function createPendingMessages({ document = globalThis.document, host, connection, getJson, postJson,
  onChange = () => {}, onDelivered = () => {} }) {
  let paneId = null;
  let items = [];
  // the newest list revision heard for this pane, by answer or push
  let revision = -1;
  let editing = null;
  let draft = "";
  let error = null;
  let collapsed = false;
  const busy = new Set();
  let drawn = null;

  const base = () => `/api/panes/${encodeURIComponent(paneId)}/pending`;

  function setItems(next, removed = [], at = null) {
    // an older list (an answer that arrived after a newer push) is not shown
    if (Number.isInteger(at)) {
      if (at < revision) return;
      revision = at;
    }
    items = Array.isArray(next) ? next : [];
    if (editing && !items.some((item) => item.id === editing && item.state === "queued")) { editing = null; draft = ""; }
    for (const id of [...busy]) if (!items.some((item) => item.id === id)) busy.delete(id);
    render();
    onChange(paneId, items);
    for (const gone of removed) if (gone?.outcome === "sent" && typeof gone.text === "string") onDelivered(paneId, gone.text);
  }

  function render() {
    host.hidden = paneId === null || items.length === 0;
    host.dataset.collapsed = String(collapsed);
    const key = JSON.stringify([paneId, items, editing, error, collapsed, [...busy]]);
    if (key === drawn) return;
    // the text being edited keeps its focus and caret across a redraw
    const editor = host.querySelector("[data-pending-editor]");
    const focused = editor && editor === document.activeElement ? { start: editor.selectionStart, end: editor.selectionEnd } : null;
    drawn = key;
    host.replaceChildren();
    if (host.hidden) return;
    const header = element(document, "div", { className: "pending-messages-header" });
    const toggle = element(document, "button", {
      className: "pending-messages-toggle",
      attrs: { type: "button", "data-pending-action": "toggle", "aria-expanded": String(!collapsed), title: collapsed ? "Show queued messages" : "Hide queued messages" },
    });
    toggle.append(element(document, "span", { className: "pending-messages-caret", attrs: { "aria-hidden": "true" } }),
      element(document, "span", { text: queueSummary(items) }));
    header.append(toggle);
    host.append(header);
    if (error) host.append(element(document, "p", { className: "pending-messages-error", text: error, attrs: { role: "status" } }));
    if (collapsed) return;
    const list = element(document, "ol", { className: "pending-messages-list", attrs: { "aria-label": "Queued messages" } });
    items.forEach((item, index) => {
      const sending = item.state === "sending" || busy.has(item.id);
      const row = element(document, "li", { className: "pending-message", attrs: { "data-state": item.state, "data-pending-id": item.id } });
      const badge = element(document, "span", { className: "pending-message-badge", text: busy.has(item.id) && item.state !== "failed" ? "Sending…" : stateLabel(item) });
      if (editing === item.id) {
        const box = element(document, "textarea", { className: "pending-message-editor", attrs: { "data-pending-editor": "", "aria-label": "Edit queued message", rows: "2", maxlength: "7988" } });
        box.value = draft;
        const actions = element(document, "span", { className: "pending-message-actions" });
        actions.append(actionButton(document, "save", "Save", { disabled: !draft.trim() }),
          actionButton(document, "discard-edit", "Discard changes", { text: "Cancel" }));
        row.append(badge, box, actions);
        list.append(row);
        return;
      }
      const text = element(document, "span", { className: "pending-message-text", text: item.text, attrs: { title: item.text } });
      const actions = element(document, "span", { className: "pending-message-actions" });
      actions.append(
        actionButton(document, "up", "Move up", { text: "↑", disabled: sending || index === 0 }),
        actionButton(document, "down", "Move down", { text: "↓", disabled: sending || index === items.length - 1 }),
      );
      if (item.state === "queued") actions.append(actionButton(document, "edit", "Edit", { disabled: sending }));
      if (item.state === "failed") actions.append(actionButton(document, "retry", "Retry", { disabled: sending }));
      actions.append(
        actionButton(document, "send-now", "Send now", { disabled: sending, className: "is-send-now" }),
        actionButton(document, "cancel", "Cancel", { text: "×", disabled: sending, className: "is-cancel" }),
      );
      row.append(badge, text, actions);
      if (item.state === "failed" && item.error) row.append(element(document, "p", { className: "pending-message-error", text: `Not sent: ${item.error}` }));
      list.append(row);
    });
    host.append(list);
    if (focused) {
      const again = host.querySelector("[data-pending-editor]");
      if (again) { again.focus({ preventScroll: true }); again.setSelectionRange(focused.start, focused.end); }
    }
  }

  async function act(id, action, body = {}) {
    if (paneId === null) return;
    const pane = paneId;
    busy.add(id);
    error = null;
    render();
    try {
      const payload = await postJson(`${base()}/${encodeURIComponent(id)}`, { action, ...body });
      if (pane === paneId && Array.isArray(payload?.items)) {
        busy.delete(id);
        if (action !== "send-now") setItems(payload.items, [], payload.revision);
        else render();
        if (action === "cancel" && payload.typed) error = "Its text was already typed into the pane: clear it there before pressing Enter.";
      }
    } catch (failure) {
      if (pane !== paneId) return;
      error = failure?.message || "Could not change the queued message.";
    } finally {
      busy.delete(id);
      if (pane === paneId) render();
    }
  }

  host.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-pending-action]") : null;
    if (!target || !host.contains(target) || target.disabled) return;
    const action = target.dataset.pendingAction;
    if (action === "toggle") { collapsed = !collapsed; render(); return; }
    const id = target.closest("[data-pending-id]")?.dataset.pendingId;
    if (!id) return;
    if (action === "edit") {
      editing = id;
      draft = items.find((item) => item.id === id)?.text ?? "";
      render();
      const box = host.querySelector("[data-pending-editor]");
      box?.focus({ preventScroll: true });
      box?.setSelectionRange(box.value.length, box.value.length);
      return;
    }
    if (action === "discard-edit") { editing = null; draft = ""; render(); return; }
    if (action === "save") { saveEdit(); return; }
    void act(id, action);
  });
  function saveEdit() {
    if (!editing || !draft.trim()) return;
    const id = editing;
    const text = draft;
    editing = null;
    draft = "";
    void act(id, "edit", { text });
  }
  host.addEventListener("input", (event) => {
    if (!(event.target instanceof Element) || !event.target.hasAttribute("data-pending-editor")) return;
    draft = event.target.value;
    const save = host.querySelector('[data-pending-action="save"]');
    if (save) save.disabled = !draft.trim();
  });
  host.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element) || !event.target.hasAttribute("data-pending-editor")) return;
    // the composer's submit is not this form's: keep the key here
    if (event.key === "Escape") { event.preventDefault(); editing = null; draft = ""; render(); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      saveEdit();
    }
  });

  connection.onPending((message) => {
    if (message.pane_id !== paneId) return;
    if (message.type === "pending-messages") { setItems(message.items, message.removed ?? [], message.revision); return; }
    // the server cannot watch it now: read it once
    void refresh();
  });

  async function refresh() {
    if (paneId === null) return;
    const pane = paneId;
    try {
      const payload = await getJson(base());
      if (pane === paneId) setItems(payload?.items ?? [], [], payload?.revision);
    } catch {
      // the next push brings it
    }
  }

  return {
    // The pane shown now: its queue is watched, whatever its agent does.
    select(nextPaneId) {
      const next = nextPaneId ?? null;
      if (next === paneId) return;
      if (paneId !== null) connection.unwatchPending(paneId);
      paneId = next;
      items = [];
      revision = -1;
      editing = null;
      draft = "";
      error = null;
      busy.clear();
      render();
      onChange(paneId, items);
      if (paneId !== null) connection.watchPending(paneId);
    },
    // Queues a message for the pane's next turn; throws what the server said.
    async enqueue(pane, text) {
      const payload = await postJson(`/api/panes/${encodeURIComponent(pane)}/pending`, { text });
      if (pane === paneId && Array.isArray(payload?.items)) {
        error = null;
        setItems(payload.items);
      }
      return payload?.item ?? null;
    },
    get paneId() { return paneId; },
    get items() { return items; },
  };
}
