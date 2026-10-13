import { WebSocketServer } from "ws";

const MAX_PENDING_ATTACHES = 4;
// A page shows one attached pane at a time; a few more cover switching.
const MAX_ATTACHED_PANES = 4;
// Conversations one socket may watch for changes, for the same reason.
const MAX_WATCHED_CONVERSATIONS = 4;
// Panes whose prompt card one socket hears of: the selected one, and a few more.
const MAX_WATCHED_PROMPTS = 4;
// Panes whose queued messages one socket hears of, for the same reason.
const MAX_WATCHED_PENDING = 4;

// Authentication stays with the HTTP server. No launch token is put in a URL.
export function attachTerminalWebSocket({ server, authorizeUpgrade, authorizeMessage,
  sendInput, watchOutput, watchStatuses, attachments = null, onRequest = () => {}, onSessionsEnded = () => () => {},
  watchConversation = null, watchPrompt = null, watchPending = null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  // An ended sign-in closes its sockets now, not at their next heartbeat.
  const rechecks = new Set();
  const stopListening = onSessionsEnded(() => { for (const recheck of rechecks) recheck(); });
  server.on("upgrade", (request, socket, head) => {
    try {
      if (new URL(request.url, "http://localhost").pathname !== "/api/terminal") throw new Error("Unknown socket");
      authorizeUpgrade(request);
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  wss.on("connection", (ws, request) => {
    let credentials = null;
    let stopWatch = null;
    let stopStatuses = null;
    let statusGeneration = 0;
    let generation = 0;
    let sequence = 0;
    let pending = 0;
    const writes = [];
    let writing = false;
    let stopped = false;
    let alive = true;
    let attaching = 0;
    // Panes this socket still wants: a detach that arrives while an attach is
    // still looking up its terminal cancels it once the lookup ends.
    const wantedPanes = new Set();
    // Conversations this socket hears changes of, each with the call that stops it.
    const conversations = new Map();
    // Panes whose prompt card this socket hears of, each with the call that stops it.
    const prompts = new Map();
    // Panes whose queued messages this socket hears of, each with the call that stops it.
    const pendingLists = new Map();
    const send = message => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, "Client too slow"); return; }
      ws.send(JSON.stringify(message));
    };
    // This socket as one viewer of attached panes. It may type and resize until
    // it says it only watches.
    const viewer = {
      mode: "interact",
      get closed() { return stopped; },
      send: message => { if (!stopped && valid()) send(message); },
      bufferedAmount: () => ws.bufferedAmount,
      close: (code, reason) => { stopped = true; ws.close(code, reason); },
    };
    const paneId = value => {
      if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid pane id");
      return value;
    };
    const valid = () => {
      try { authorizeMessage(request, credentials); return true; }
      catch { stopped = true; ws.close(4001, "Sign in again"); return false; }
    };
    // Drain immediately, but combine raw text that accumulated behind an
    // in-flight CLI/SSH write. Keys, submissions and pane changes are barriers.
    const rawText = message => typeof message.text === "string" &&
      message.text.length > 0 && message.text.length <= 8000 &&
      !message.text.includes("\0") && message.submit !== true;
    async function drainWrites() {
      if (writing) return;
      writing = true;
      try {
        while (writes.length && !stopped && valid()) {
          const item = writes.shift();
          try {
            const result = await sendInput(item.message);
            const secret = result?.secret === true;
            if (item.message.submit === true && !secret) onRequest(item.message.paneId, item.message.text);
            for (const id of item.ids) send({ type: "ack", id, ...(secret ? { secret } : {}) });
          } catch (error) {
            stopped = true;
            send({ type: "error", id: item.ids[0], message: error.message });
            ws.close(1011, "Input stopped; delivery may be uncertain");
          } finally { pending -= item.ids.length; }
        }
      } finally {
        writing = false;
        if (stopped) { writes.length = 0; pending = 0; }
      }
    }
    const recheck = () => { if (credentials && !stopped) valid(); };
    rechecks.add(recheck);
    const authTimeout = setTimeout(() => ws.close(4001, "Authentication required"), 5000);
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      if (credentials && !valid()) return;
      alive = false;
      ws.ping();
    }, 15_000);
    heartbeat.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("error", () => {});
    ws.on("close", () => {
      rechecks.delete(recheck);
      stopped = true;
      generation++;
      statusGeneration++;
      clearTimeout(authTimeout);
      clearInterval(heartbeat);
      stopWatch?.();
      stopStatuses?.();
      for (const stop of conversations.values()) stop();
      conversations.clear();
      for (const stop of prompts.values()) stop();
      prompts.clear();
      for (const stop of pendingLists.values()) stop();
      pendingLists.clear();
      attachments?.detachAll(viewer);
    });
    ws.on("message", (bytes, binary) => {
      try {
        if (binary || stopped) throw new Error("Invalid terminal message");
        const message = JSON.parse(bytes.toString());
        if (!credentials) {
          if (message.type !== "auth") throw new Error("Authentication required");
          credentials = message;
          if (!valid()) return;
          clearTimeout(authTimeout);
          send({ type: "ready" });
          return;
        }
        if (!valid()) return;
        if (message.type === "watch-statuses") {
          if (!Array.isArray(message.paneIds) || message.paneIds.length > 512 ||
              message.paneIds.some(id => typeof id !== "string" || !id || id.length > 512)) throw new Error("Invalid status subscription");
          const current = ++statusGeneration;
          stopStatuses?.(); stopStatuses = null;
          if (!watchStatuses) { send({ type: "statuses-unavailable" }); return; }
          let unavailable = false;
          Promise.resolve(watchStatuses([...new Set(message.paneIds)], event => {
            if (current === statusGeneration && !stopped && valid()) send({ type: "status", ...event });
          }, () => {
            unavailable = true;
            if (current === statusGeneration && !stopped && valid()) send({ type: "statuses-unavailable" });
          })).then(stop => {
            if (current !== statusGeneration || stopped) stop();
            else { stopStatuses = stop; if (!unavailable) send({ type: "statuses-ready" }); }
          }).catch(() => {
            if (current === statusGeneration && !stopped) send({ type: "statuses-unavailable" });
          });
          return;
        }
        // `keepSize` and the observe role keep a viewer from resizing the shared
        // grid; the chat view uses them for a terminal it only keeps warm.
        if (message.type === "attach") {
          const id = paneId(message.paneId);
          if (message.keepSize !== undefined && typeof message.keepSize !== "boolean") throw new Error("Invalid attach");
          // Each lookup runs herdr a few times: a page opens one pane at a time.
          if (!attachments) { send({ type: "attach-unavailable", pane_id: id, code: "attach_unsupported" }); return; }
          if (attaching >= MAX_PENDING_ATTACHES || (!wantedPanes.has(id) && wantedPanes.size >= MAX_ATTACHED_PANES)) {
            send({ type: "attach-unavailable", pane_id: id, code: "busy" });
            return;
          }
          attaching += 1;
          wantedPanes.add(id);
          attachments.attach(viewer, id, { cols: message.cols, rows: message.rows, keepSize: message.keepSize === true })
            .finally(() => {
              attaching -= 1;
              if (!wantedPanes.has(id)) attachments.detach(viewer, id);
            })
            .catch(error => {
              if (stopped) return;
              if (error instanceof RangeError) { stopped = true; ws.close(1008, "Invalid terminal request"); return; }
              send({ type: "attach-unavailable", pane_id: id, code: error.code ?? "attach_failed", message: error.message });
            });
          return;
        }
        // A changed transcript is only announced; the page reads it over HTTP.
        if (message.type === "watch-conversation") {
          const id = paneId(message.paneId);
          if (conversations.has(id)) return;
          if (!watchConversation || conversations.size >= MAX_WATCHED_CONVERSATIONS) {
            send({ type: "conversation-unavailable", pane_id: id, code: watchConversation ? "busy" : "unsupported" });
            return;
          }
          conversations.set(id, watchConversation(id, signature => {
            if (!stopped && valid()) send({ type: "conversation-changed", pane_id: id, signature });
          }));
          return;
        }
        if (message.type === "unwatch-conversation") {
          const id = paneId(message.paneId);
          conversations.get(id)?.();
          conversations.delete(id);
          return;
        }
        // A pane's prompt card, sent whole whenever it appears, changes or goes
        // (card null). Answering goes over HTTP.
        if (message.type === "watch-prompt") {
          const id = paneId(message.paneId);
          if (prompts.has(id)) return;
          if (!watchPrompt || prompts.size >= MAX_WATCHED_PROMPTS) {
            send({ type: "prompt-unavailable", pane_id: id, code: watchPrompt ? "busy" : "unsupported" });
            return;
          }
          let stop;
          try {
            stop = watchPrompt(id, card => {
              if (!stopped && valid()) send({ type: "prompt", pane_id: id, card: card ?? null });
            });
          } catch {
            send({ type: "prompt-unavailable", pane_id: id, code: "busy" });
            return;
          }
          prompts.set(id, stop);
          return;
        }
        if (message.type === "unwatch-prompt") {
          const id = paneId(message.paneId);
          prompts.get(id)?.();
          prompts.delete(id);
          return;
        }
        // A pane's queued messages, sent whole now and whenever they change
        // (and which went, as `removed`). Changing them goes over HTTP.
        if (message.type === "watch-pending") {
          const id = paneId(message.paneId);
          if (pendingLists.has(id)) return;
          if (!watchPending || pendingLists.size >= MAX_WATCHED_PENDING) {
            send({ type: "pending-unavailable", pane_id: id, code: watchPending ? "busy" : "unsupported" });
            return;
          }
          let stop;
          try {
            stop = watchPending(id, ({ items, removed, revision }) => {
              if (!stopped && valid()) send({ type: "pending-messages", pane_id: id, items, revision, ...(removed ? { removed } : {}) });
            });
          } catch {
            send({ type: "pending-unavailable", pane_id: id, code: "busy" });
            return;
          }
          pendingLists.set(id, stop);
          return;
        }
        if (message.type === "unwatch-pending") {
          const id = paneId(message.paneId);
          pendingLists.get(id)?.();
          pendingLists.delete(id);
          return;
        }
        if (message.type === "detach") {
          const id = paneId(message.paneId);
          wantedPanes.delete(id);
          attachments?.detach(viewer, id);
          return;
        }
        if (message.type === "pty-input") {
          if (typeof message.data !== "string" || !message.data || message.data.length > 16_384) throw new Error("Invalid terminal input");
          const id = paneId(message.paneId);
          if (!attachments?.input(viewer, id, message.data)) { send({ type: "pty-input-dropped", pane_id: id }); return; }
          // Enter typed in the terminal is a request too, so its completion is not
          // missed. Only the pane is noted: what was typed (maybe a password) is not.
          if (message.data.includes("\r")) onRequest(id, "Enter in the terminal");
          return;
        }
        if (message.type === "resize") { attachments?.resize(viewer, paneId(message.paneId), message.cols, message.rows); return; }
        if (message.type === "pty-ack") {
          if (typeof message.streamId !== "string" || !attachments?.acknowledge(viewer, paneId(message.paneId), message.streamId, message.offset)) {
            throw new Error("Invalid acknowledgement");
          }
          return;
        }
        if (message.type === "take-over") { attachments?.takeOver(viewer, paneId(message.paneId)); return; }
        if (message.type === "role") {
          if (message.mode !== "interact" && message.mode !== "observe") throw new Error("Invalid role");
          if (attachments) attachments.setMode(viewer, message.mode);
          else viewer.mode = message.mode;
          return;
        }
        if (message.type === "unwatch") {
          generation++;
          stopWatch?.();
          stopWatch = null;
          return;
        }
        if (message.type === "watch") {
          if (typeof message.paneId !== "string" || message.paneId.length > 512 ||
              !Number.isInteger(message.lines) || message.lines < 1 || message.lines > 100_000) throw new Error("Invalid pane subscription");
          const current = ++generation;
          stopWatch?.();
          stopWatch = null;
          Promise.resolve(watchOutput(message.paneId, message.lines, update => {
            if (current === generation && !stopped && valid()) send({ type: "output", paneId: message.paneId, ...update });
          }, error => {
            if (current === generation && !stopped) {
              send({ type: "error", message: error.message });
              ws.close(1011, "Terminal stream failed");
            }
          })).then(stop => {
            if (current !== generation || stopped) stop();
            else stopWatch = stop;
          }).catch(() => ws.close(1011, "Cannot subscribe to terminal"));
          return;
        }
        if (message.type !== "input" || !Number.isSafeInteger(message.id) || message.id <= sequence ||
            typeof message.paneId !== "string" || message.paneId.length > 512 ||
            (typeof message.text !== "string" && !Array.isArray(message.keys)) ||
            (message.text !== undefined && message.keys !== undefined) || ++pending > 128) throw new Error("Invalid terminal input");
        sequence = message.id;
        const last = writes.at(-1);
        if (last && rawText(last.message) && rawText(message) &&
            last.message.paneId === message.paneId &&
            last.message.text.length + message.text.length <= 8000) {
          last.message.text += message.text;
          last.ids.push(message.id);
        } else {
          writes.push({ message, ids: [message.id] });
        }
        void drainWrites();
      } catch {
        stopped = true;
        ws.close(1008, "Invalid terminal request");
      }
    });
  });
  // Upgraded sockets are not closed by HTTP closeAllConnections().
  const close = server.close.bind(server);
  server.close = (...args) => {
    for (const ws of wss.clients) ws.terminate();
    stopListening?.();
    wss.close();
    return close(...args);
  };
  return wss;
}
