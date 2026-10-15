import { StringDecoder } from "node:string_decoder";
import { WebSocket, WebSocketServer } from "ws";
import { HttpError, decodePaneId } from "./http-basics.mjs";
import { HerdrCommandError } from "./herdr-client.mjs";

// A connected PC's pane, attached for real: the PC that has the pane runs
// `herdr terminal attach` on its own pty, exactly as it would for its own page,
// and the hub relays that pty's bytes over one WebSocket on the Connect PC
// port. The hub's PaneAttachments drives the far pty through the same small
// interface a local one has (write, resize, pause, resume, kill, exited), so
// replay, flow control, held terminals and live handoffs work unchanged.
//
// On the wire: output and typing are binary frames; a text frame carries one
// JSON control message, today only {type:"resize",cols,rows}. The attach ends
// with a normal close whose reason is `exit:<code>` (or `exit:` without one).

// Each attach is a process and a pty on the PC that has the pane; a hub opens
// one per pane a page is showing.
export const MAX_LINK_ATTACHES = 16;
// A hub sends a browser's typing on, and a browser frame is at most 64 KiB.
const MAX_INPUT_FRAME = 256 * 1024;
// Output is cut into frames no larger than this; the hub reads at most twice it.
const OUTPUT_FRAME = 64 * 1024;
const MAX_OUTPUT_FRAME = 4 * OUTPUT_FRAME;
// The pty is paused while this much is waiting for the hub, and resumed once
// the queue is down to the low mark.
const SEND_HIGH_BYTES = 1024 * 1024;
const SEND_LOW_BYTES = 256 * 1024;
// A side that answers no ping for a whole interval is gone. The hub pauses
// its socket only for a client's short stall (OUTPUT_STALL_MS).
const PING_MS = 30_000;
const HANDSHAKE_MS = 10_000;
const ATTACH_PATH = /^\/api\/link\/panes\/([^/]+)\/attach$/u;
// The same shape herdr-client accepts: an id, never something read as an option.
const TERMINAL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;
const SIZE = /^[1-9]\d{0,3}$/u;

function size(value, name) {
  if (value === null) return undefined;
  const number = SIZE.test(value) ? Number(value) : NaN;
  if (!(number >= 1 && number <= 1000)) throw new HttpError(400, "invalid_input", `${name} must be an integer in 1..1000`);
  return number;
}

const validSize = (value) => Number.isInteger(value) && value >= 1 && value <= 1000;

// Pings `socket` every `intervalMs` and ends it when the last ping went
// unanswered. `quiet()` true skips a check: a paused socket reads no pongs.
function keepAlive(socket, intervalMs, quiet = () => false) {
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (quiet()) { alive = true; return; }
    if (!alive) { socket.terminate(); return; }
    alive = false;
    try { socket.ping(); } catch { /* closing */ }
  }, intervalMs);
  timer.unref?.();
  socket.once("close", () => clearInterval(timer));
}

// The Connect PC port's half: the WebSocket a hub attaches through, and the
// lookup it does first. `terminalTarget` is this PC's own Herdr client's (it
// knows the herdr binary and socket, which never leave this PC); `spawnPty` is
// the same node-pty spawner this PC's page uses, or null without node-pty, in
// which case every attach is refused as attach_unsupported.
//
// The port (src/peer-server.mjs) runs its checks -- host, browser headers,
// path, who is calling -- before `upgrade` is ever called.
export function linkAttachSockets({
  terminalTarget, spawnPty, maxAttaches = MAX_LINK_ATTACHES, pingMs = PING_MS, log = (message) => console.error(message),
}) {
  const supported = typeof terminalTarget === "function" && typeof spawnPty === "function";
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_FRAME, perMessageDeflate: false });
  // Attaches being looked up count too: each is about to become a pty.
  let open = 0;

  function refuseUnsupported() {
    throw new HttpError(501, "attach_unsupported", "This PC cannot attach terminals (node-pty is unavailable here).");
  }

  async function target(paneId, timeoutMs) {
    const found = await terminalTarget(paneId, timeoutMs);
    if (typeof found?.terminalId !== "string" || !TERMINAL_ID.test(found.terminalId)) {
      throw new HerdrCommandError("The pane has no terminal", { code: "no_terminal" });
    }
    return found;
  }

  // What a hub needs to know about a pane's terminal: which one it is (to tell
  // a live handoff from an ended pane) and its size. Not how to run it.
  async function describe(paneId) {
    if (!supported) refuseUnsupported();
    const found = await target(paneId);
    return {
      terminal_id: found.terminalId,
      cols: validSize(found.cols) ? found.cols : null,
      rows: validSize(found.rows) ? found.rows : null,
    };
  }

  function matches(pathname) {
    return ATTACH_PATH.test(pathname);
  }

  // Everything that can be refused is refused before the upgrade, as an
  // ordinary HTTP answer; once upgraded, the socket only ever ends.
  async function upgrade(request, socket, head, url) {
    const match = url.pathname.match(ATTACH_PATH);
    if (!match || (request.method || "GET") !== "GET") throw new HttpError(404, "not_found", "Not found");
    if (!supported) refuseUnsupported();
    const paneId = decodePaneId(match[1]);
    const cols = size(url.searchParams.get("cols"), "cols") ?? 80;
    const rows = size(url.searchParams.get("rows"), "rows") ?? 24;
    const takeover = url.searchParams.get("takeover") === "1";
    if (open >= maxAttaches) throw new HttpError(429, "too_many_attachments", "Too many terminals are attached. Try again shortly.");
    open += 1;
    let counted = true;
    const release = () => { if (counted) { counted = false; open -= 1; } };
    let found;
    try {
      found = await target(paneId);
    } catch (error) {
      release();
      throw error;
    }
    // Without a verifyClient, ws upgrades (and calls back) synchronously; a
    // socket that closed while the pane was looked up, or a malformed
    // handshake, is dropped there without a call back, and spawns nothing.
    let upgraded = false;
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      ws.once("close", release);
      relay(ws, paneId, found, { cols, rows, takeover });
    });
    if (!upgraded) release();
  }

  function relay(ws, paneId, found, { cols, rows, takeover }) {
    let pty;
    let paused = false;
    let exited = false;
    const decoder = new StringDecoder("utf8");
    const drained = () => {
      if (paused && ws.bufferedAmount <= SEND_LOW_BYTES) { paused = false; pty.resume(); }
    };
    try {
      pty = spawnPty({
        command: found.command,
        // --takeover goes after the id, as PaneAttachments puts it for a local pane.
        args: [...found.args, ...(takeover ? ["--takeover"] : [])],
        env: found.env,
        cols,
        rows,
        onData: (data) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const bytes = Buffer.from(data, "utf8");
          for (let start = 0; start < bytes.length; start += OUTPUT_FRAME) {
            ws.send(bytes.subarray(start, start + OUTPUT_FRAME), { binary: true }, drained);
          }
          if (!paused && ws.bufferedAmount >= SEND_HIGH_BYTES) { paused = true; pty.pause(); }
        },
        onExit: (code) => {
          exited = true;
          // Sent after every byte already queued, so herdr's last words arrive first.
          if (ws.readyState === WebSocket.OPEN) ws.close(1000, `exit:${Number.isInteger(code) ? code : ""}`);
        },
      });
    } catch (error) {
      log(`Connect PC attach for pane ${paneId} failed to start: ${error.message}`);
      ws.close(1011, "attach_failed");
      return;
    }
    keepAlive(ws, pingMs);
    ws.on("error", () => {});
    ws.on("close", () => { if (!exited) pty.kill(); });
    ws.on("message", (data, binary) => {
      if (exited) return;
      if (binary) {
        const text = decoder.write(data);
        if (text) pty.write(text);
        return;
      }
      let message;
      try { message = JSON.parse(String(data)); } catch { message = null; }
      if (message?.type === "resize" && validSize(message.cols) && validSize(message.rows)) {
        pty.resize(message.cols, message.rows);
        return;
      }
      ws.close(1008, "invalid_message");
    });
  }

  return {
    supported,
    describe,
    matches,
    upgrade,
    get open() { return open; },
    close() {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

// The hub's half: a pty on another PC, reached at `url` (ws:// or wss://), with
// the interface nodePtySpawner's ptys have. It is returned at once and connects
// in the background; typing and resizes made meanwhile are sent once it opens.
// A refusal, a dropped connection or the far attach ending all end it the
// same way: onExit, with herdr's exit code when the far side sent one.
export function openRemotePty({
  url, onData, onExit, handshakeTimeoutMs = HANDSHAKE_MS, pingMs = PING_MS, WebSocketImpl = WebSocket,
}) {
  const ws = new WebSocketImpl(url, {
    // A redirect could send this hub anywhere; none is followed.
    followRedirects: false,
    handshakeTimeout: handshakeTimeoutMs,
    maxPayload: MAX_OUTPUT_FRAME,
    perMessageDeflate: false,
  });
  const decoder = new StringDecoder("utf8");
  let exited = false;
  let paused = false;
  let pendingInput = [];
  let pendingSize = null;
  let resolveExit;
  const exitedPromise = new Promise((resolve) => { resolveExit = resolve; });
  const send = (data, options) => { try { ws.send(data, options); } catch { /* closing */ } };

  ws.on("open", () => {
    if (paused) ws.pause();
    if (pendingSize) send(JSON.stringify({ type: "resize", ...pendingSize }));
    for (const data of pendingInput) send(Buffer.from(data, "utf8"), { binary: true });
    pendingInput = null;
    pendingSize = null;
    keepAlive(ws, pingMs, () => paused);
  });
  ws.on("message", (data, binary) => {
    if (exited || !binary) return;
    const text = decoder.write(data);
    if (text) onData(text);
  });
  ws.on("error", () => {});
  ws.on("close", (_status, reason) => {
    if (exited) return;
    exited = true;
    const said = /^exit:(-?\d{1,6})$/u.exec(String(reason));
    const code = said ? Number(said[1]) : null;
    const rest = decoder.end();
    if (rest) onData(rest);
    resolveExit();
    onExit(code);
  });

  return {
    exited: exitedPromise,
    write: (data) => {
      if (exited) return;
      if (ws.readyState === WebSocket.CONNECTING) {
        // Bounded: nothing types into an attach that has not started.
        if (pendingInput.length < 64) pendingInput.push(data);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) send(Buffer.from(data, "utf8"), { binary: true });
    },
    resize: (cols, rows) => {
      if (exited || !validSize(cols) || !validSize(rows)) return;
      if (ws.readyState === WebSocket.CONNECTING) { pendingSize = { cols, rows }; return; }
      if (ws.readyState === WebSocket.OPEN) send(JSON.stringify({ type: "resize", cols, rows }));
    },
    // Not reading pushes back over TCP to the far side, which pauses its pty.
    pause: () => { if (!exited && !paused) { paused = true; ws.pause(); } },
    resume: () => { if (!exited && paused) { paused = false; ws.resume(); } },
    kill: () => {
      if (exited) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "detached");
        // A far side that never answers the close must not keep the slot.
        setTimeout(() => { if (!exited) ws.terminate(); }, 2000).unref?.();
      } else {
        ws.terminate();
      }
    },
  };
}

// What PaneAttachments spawns with: a target from a connected PC carries its
// own way to open (`remote`), anything else runs on this PC's node-pty. A hub
// without node-pty still attaches a connected PC's panes.
export function routedSpawner(local) {
  return ({ remote, ...options }) => {
    if (remote) return remote.open(options);
    if (!local) throw new HerdrCommandError("Terminals cannot attach on this PC (node-pty is unavailable).", { code: "attach_unsupported" });
    return local(options);
  };
}
