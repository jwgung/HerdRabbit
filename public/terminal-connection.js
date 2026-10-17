import { outputTextForUpdate } from "./ui-model.js?v=1.2.71";

const CONVERSATION_MESSAGES = new Set(["conversation-changed", "conversation-unavailable"]);
const PROMPT_MESSAGES = new Set(["prompt", "prompt-unavailable"]);
const ATTACH_MESSAGES = new Set(["pty-data", "input-ready", "attach-held", "attach-resumed", "pane-geometry",
  "attach-unavailable", "attach-error", "pty-exit", "pty-input-dropped"]);

export function terminalConnection({ credentials, onOutput, onDisconnect, onAuthenticationRequired,
  onStatus = () => {}, onStatusesReady = () => {}, onStatusesUnavailable = () => {},
  WebSocketImpl = WebSocket, url = new URL("/api/terminal", location.href.replace(/^http/, "ws")) }) {
  let socket = null;
  let ready = false;
  let wanted = null;
  let snapshot = null;
  let nextId = 0;
  let retry = null;
  let retryDelay = 250;
  let suspended = false;
  let statusIds = [];
  let statusKey = null;
  const pending = new Map();
  // The pane whose attached terminal this page shows, attached again after a reconnect.
  let attached = null;
  const attachListeners = new Set();
  const reconnectListeners = new Set();
  // Whether the socket is live, for the strip that says why the terminal is not:
  // { state: "idle" | "connecting" | "ready" | "waiting" | "paused" | "signed-out",
  //   since, retryAt, failed }. `failed` from a socket closing until one is ready.
  let connectionState = { state: "idle", since: Date.now(), retryAt: null, failed: false };
  const stateListeners = new Set();
  function setConnectionState(state, extra = {}) {
    connectionState = { state, since: Date.now(), retryAt: null, failed: connectionState.failed, ...extra };
    for (const listener of stateListeners) listener(connectionState);
  }
  // Panes whose conversation this page watches (the Chat lens on screen), sent
  // again on every new socket, and who hears their changes.
  const conversations = new Set();
  const conversationListeners = new Set();
  // Panes whose prompt card this page hears of (the selected pane while it is
  // blocked), sent again on every new socket, and who hears the cards.
  const prompts = new Set();
  const promptListeners = new Set();
  // Attach traffic is best effort: a socket that is reconnecting drops it, and
  // the reconnect attaches again from a clean screen.
  function transmitIfReady(message) {
    if (!ready || socket?.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function rejectPending(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function transmit(message) {
    if (!ready || socket?.readyState !== WebSocketImpl.OPEN) throw new Error("Terminal is reconnecting. Try again when its screen returns.");
    if (socket.bufferedAmount > 256 * 1024) throw new Error("Terminal connection is too slow. Input stopped.");
    socket.send(JSON.stringify(message));
  }
  function connect() {
    if (suspended || socket || (!wanted && !attached && conversations.size === 0 && prompts.size === 0)) return;
    const current = new WebSocketImpl(url);
    socket = current;
    setConnectionState("connecting");
    current.onopen = () => current.send(JSON.stringify({ type: "auth", ...credentials() }));
    current.onmessage = ({ data }) => {
      if (socket !== current) return;
      try {
        const message = JSON.parse(data);
        if (message.type === "ready") {
          ready = true;
          retryDelay = 250;
          snapshot = null;
          setConnectionState("ready", { failed: false });
          if (wanted) transmit({ type: "watch", ...wanted });
          statusKey = JSON.stringify(statusIds);
          transmit({ type: "watch-statuses", paneIds: statusIds });
          for (const paneId of conversations) transmit({ type: "watch-conversation", paneId });
          for (const paneId of prompts) transmit({ type: "watch-prompt", paneId });
          for (const listener of reconnectListeners) listener();
        } else if (ATTACH_MESSAGES.has(message.type)) {
          for (const listener of attachListeners) listener(message);
        } else if (CONVERSATION_MESSAGES.has(message.type)) {
          if (conversations.has(message.pane_id)) for (const listener of conversationListeners) listener(message);
        } else if (PROMPT_MESSAGES.has(message.type)) {
          if (prompts.has(message.pane_id)) for (const listener of promptListeners) listener(message);
        } else if (message.type === "status" && statusIds.includes(message.pane_id)) {
          onStatus(message);
        } else if (message.type === "statuses-ready") {
          onStatusesReady();
        } else if (message.type === "statuses-unavailable") {
          statusKey = null; // Retry from the next HTTP list refresh.
          onStatusesUnavailable();
        } else if (message.type === "output" && message.paneId === wanted?.paneId && message.requestedLines === wanted.lines) {
          const output = outputTextForUpdate(snapshot?.output ?? null, message);
          if (output === null) throw new Error("Terminal stream lost synchronization");
          snapshot = { ...message, update: "replace", output };
          onOutput(snapshot);
        } else if (message.type === "ack") {
          const item = pending.get(message.id);
          if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); }
        } else if (message.type === "error") {
          throw new Error(message.message || "Terminal connection failed");
        }
      } catch (error) {
        rejectPending(error);
        onDisconnect(error);
        current.close();
      }
    };
    current.onerror = () => {}; // close reports the failure once.
    current.onclose = event => {
      if (socket !== current) return;
      socket = null;
      ready = false;
      snapshot = null;
      statusKey = null;
      const error = new Error("Terminal disconnected. Unconfirmed input was not resent.");
      rejectPending(error);
      if (event.code === 4001) {
        suspended = true;
        setConnectionState("signed-out", { failed: true });
        onAuthenticationRequired();
        return;
      }
      if (!suspended) {
        onDisconnect(error);
        clearTimeout(retry);
        retry = setTimeout(connect, retryDelay);
        setConnectionState("waiting", { failed: true, retryAt: Date.now() + retryDelay });
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    };
  }
  return {
    onAttach(listener) { attachListeners.add(listener); },
    onReconnect(listener) { reconnectListeners.add(listener); },
    // Hears each change of the socket's state (see setConnectionState), and the current one now.
    onConnectionState(listener) { stateListeners.add(listener); listener(connectionState); },
    get connectionState() { return connectionState; },
    // Reconnect pressed: the wait is skipped and the backoff starts over. A
    // socket still opening is dropped for a fresh one, as it may never open.
    reconnectNow() {
      if (ready && socket?.readyState === WebSocketImpl.OPEN) return;
      clearTimeout(retry);
      retry = null;
      retryDelay = 250;
      suspended = false;
      const stale = socket;
      if (stale) {
        socket = null;
        ready = false;
        snapshot = null;
        statusKey = null;
        stale.onclose = null;
        stale.onmessage = null;
        try { stale.close(); } catch {}
        rejectPending(new Error("Terminal disconnected. Unconfirmed input was not resent."));
      }
      connect();
    },
    onConversation(listener) { conversationListeners.add(listener); },
    // Hears when the pane's transcript (Claude's or Codex's) changes, until unwatched.
    watchConversation(paneId) {
      if (conversations.has(paneId)) return;
      conversations.add(paneId);
      transmitIfReady({ type: "watch-conversation", paneId });
      connect();
    },
    unwatchConversation(paneId) {
      if (!conversations.delete(paneId)) return;
      transmitIfReady({ type: "unwatch-conversation", paneId });
    },
    onPrompt(listener) { promptListeners.add(listener); },
    // Hears the pane's prompt card ({ type: "prompt", pane_id, card }) until unwatched.
    watchPrompt(paneId) {
      if (prompts.has(paneId)) return;
      prompts.add(paneId);
      transmitIfReady({ type: "watch-prompt", paneId });
      connect();
    },
    unwatchPrompt(paneId) {
      if (!prompts.delete(paneId)) return;
      transmitIfReady({ type: "unwatch-prompt", paneId });
    },
    attach(paneId, { cols, rows }) {
      attached = paneId;
      suspended = false;
      transmitIfReady({ type: "attach", paneId, cols, rows });
      connect();
    },
    detach(paneId) {
      if (attached === paneId) attached = null;
      transmitIfReady({ type: "detach", paneId });
    },
    // Connects again after pause(), keeping what was wanted.
    resume() {
      suspended = false;
      connect();
    },
    // False when the socket is reconnecting and the typing went nowhere.
    ptyInput(paneId, data) { return transmitIfReady({ type: "pty-input", paneId, data }); },
    resize(paneId, cols, rows) { transmitIfReady({ type: "resize", paneId, cols, rows }); },
    acknowledge(paneId, streamId, offset) { transmitIfReady({ type: "pty-ack", paneId, streamId, offset }); },
    takeOver(paneId) { transmitIfReady({ type: "take-over", paneId }); },
    // The screen-text stream stops while the pane shows its attached terminal.
    unwatch() {
      if (!wanted) return;
      wanted = null;
      snapshot = null;
      transmitIfReady({ type: "unwatch" });
    },
    watchStatuses(paneIds) {
      statusIds = [...new Set(paneIds)].sort();
      const key = JSON.stringify(statusIds);
      if (ready && key !== statusKey) {
        statusKey = key;
        transmit({ type: "watch-statuses", paneIds: statusIds });
      }
    },
    select(paneId, lines) {
      const changed = wanted?.paneId !== paneId || wanted?.lines !== lines;
      wanted = { paneId, lines };
      suspended = false;
      if (changed) { snapshot = null; if (ready) transmit({ type: "watch", ...wanted }); }
      connect();
    },
    latest(paneId, lines) { return snapshot?.paneId === paneId && snapshot.requestedLines === lines ? snapshot : null; },
    send(item, { waitForAck = true } = {}) {
      const id = ++nextId;
      try { transmit({ type: "input", id, ...item }); }
      catch (error) { return Promise.reject(error); }
      const acknowledged = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Input acknowledgement timed out; it was not resent."));
          socket?.close();
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
      });
      if (waitForAck) return acknowledged;
      acknowledged.catch(() => {});
      return Promise.resolve();
    },
    pause() {
      suspended = true;
      clearTimeout(retry);
      socket?.close();
      // A sign-in that ran out stays said while the page asks for a new one.
      if (connectionState.state !== "signed-out") setConnectionState("paused", { failed: false });
    },
  };
}
