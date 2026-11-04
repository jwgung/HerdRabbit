// The local images an agent shows in its answer (`![chart](out/chart.png)`),
// drawn in the chat.
//
// markdown.js leaves a placeholder for each one (`.md-image`), holding the
// plain fallback: the image's words and its path, a button that opens it when
// the page can. This swaps that for the picture -- and only ever from the file
// route the Files viewer uses: a view ticket asked for over the CSRF-guarded
// POST /api/browse/tickets, which refuses a protected path, and the picture
// read from /api/browse/download/<ticket>, which serves it with the type its
// name gives and nothing else (file-preview.js). A relative path is resolved
// against the pane's folder, as a path link is (app/selection.js
// resolveTerminalPath); a path that cannot be, a refusal, a missing file or a
// picture that does not decode keeps the fallback and says so.
//
// Pressing a picture opens the viewer (image-viewer.js) on every picture
// shown in that chat.

import { previewFor } from "../file-preview.js?v=1.4.36";
import { trimTrailingSlashes } from "../path-links.js?v=1.4.36";

// The ticket the file route issues: the same pattern the server matches.
const TICKET = /^[A-Za-z0-9_-]{16,86}$/u;

// A view ticket lasts ten minutes on the server (src/http-server.mjs); one is
// reused for a little less than that. The server holds 32 tickets at once,
// downloads and the Files viewer's included, so the chat's pictures take at
// most half of them: past that, a picture keeps its fallback.
const TICKET_TTL_MS = 9 * 60_000;
const MAX_TICKETS = 16;
// The chat's own "at the bottom" (chat-view.js FOLLOW_BOTTOM_PX).
const FOLLOW_BOTTOM_PX = 48;

// Where a picture starts loading: a screen ahead of the reader.
const LOAD_AHEAD = "400px 0px";

// The absolute path an image `path` from the agent names, with `.` and `..`
// taken out, or null. A relative one needs the pane's folder, `cwd`, written
// out in full, as for a path link (resolveTerminalPath); `~` and addresses are
// never resolved here. markdown.js has already refused those; they are checked
// again because the path comes back from the page's own markup. `..` is taken
// out here, where a path link leaves it to the server: the server resolves the
// same way (path.resolve, then realpath for the protected-path check), and
// the viewer's title then names the file itself.
export function resolveImagePath(path, cwd) {
  if (typeof path !== "string" || path === "" || path.startsWith("~") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) return null;
  if (previewFor(path)?.kind !== "image") return null;
  let full = path;
  if (!path.startsWith("/")) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
    full = `${trimTrailingSlashes(cwd)}/${path}`;
  }
  const parts = [];
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// The address a ticket (view or download) reads its file from, or null for
// anything that is not a ticket: a picture never comes from anywhere else.
export function ticketUrl(ticket) {
  return typeof ticket === "string" && TICKET.test(ticket) ? `/api/browse/download/${ticket}` : null;
}

// View tickets by machine and path. A chat draws an answer again as it grows,
// so one file gets one ticket while it lasts. At most `max` are held at once:
// a ticket asked for past that is refused here, without asking the server. A
// refusal is not kept, so the next draw asks again.
export function createTicketCache(issue, { ttlMs = TICKET_TTL_MS, now = Date.now, max = MAX_TICKETS } = {}) {
  const tickets = new Map();
  const keyOf = (server, path) => `${server}\n${path}`;
  return {
    get(server, path) {
      const key = keyOf(server, path);
      const known = tickets.get(key);
      if (known && now() < known.expiresAt) return known.ticket;
      for (const [held, value] of tickets) if (value.expiresAt <= now()) tickets.delete(held);
      if (tickets.size >= max) return Promise.reject(new Error("Too many images are shown at once."));
      const ticket = Promise.resolve().then(() => issue(server, path));
      tickets.set(key, { ticket, expiresAt: now() + ttlMs });
      ticket.catch(() => { if (tickets.get(key)?.ticket === ticket) tickets.delete(key); });
      return ticket;
    },
    forget(server, path) {
      tickets.delete(keyOf(server, path));
    },
  };
}

// `context(paneId)` answers { server, cwd } for a pane, or null;
// `viewTicket(path, server, view)` is the Files tab's ticket request
// (app/files.js); `viewer` is an image viewer (image-viewer.js).
export function createChatImages({ document = globalThis.document, context, viewTicket, viewer }) {
  const tickets = createTicketCache((server, path) => viewTicket(path, server, true));
  // what each shown picture is, for the viewer
  const shown = new WeakMap();
  const waiting = new WeakMap();
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const paneId = waiting.get(entry.target);
        waiting.delete(entry.target);
        void load(entry.target, paneId);
      }
    }, { rootMargin: LOAD_AHEAD })
    : null;

  function unavailable(holder) {
    holder.dataset.state = "unavailable";
    holder.append(document.createTextNode(" "), Object.assign(document.createElement("span"), {
      className: "md-image-note", textContent: "Image unavailable",
    }));
  }

  // A reader at the end of the chat stays there as the picture takes its room.
  function atEnd(holder) {
    const scroller = holder.closest(".chat-scroll");
    return scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_BOTTOM_PX ? scroller : null;
  }

  async function load(holder, paneId) {
    if (!holder.isConnected) return;
    holder.dataset.state = "loading";
    const where = context(paneId);
    const path = where ? resolveImagePath(holder.dataset.image, where.cwd) : null;
    if (path === null) { unavailable(holder); return; }
    let url;
    try {
      url = ticketUrl(await tickets.get(where.server, path));
    } catch {
      url = null;
    }
    if (url === null) { unavailable(holder); return; }
    const alt = holder.dataset.alt ?? "";
    const name = path.split("/").pop();
    const picture = document.createElement("img");
    picture.className = "md-image-picture";
    picture.alt = alt || name;
    picture.decoding = "async";
    picture.draggable = false;
    picture.addEventListener("error", () => {
      // a ticket the server no longer has (it restarted) is not used again
      tickets.forget(where.server, path);
      unavailable(holder);
    }, { once: true });
    picture.addEventListener("load", () => {
      if (!holder.isConnected) return;
      const scroller = atEnd(holder);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "md-image-open";
      open.title = "View image";
      open.setAttribute("aria-label", `View image: ${alt || name}`);
      open.append(picture);
      open.addEventListener("click", () => openViewer(holder));
      holder.replaceChildren(open);
      holder.dataset.state = "shown";
      shown.set(holder, { url, path, server: where.server, name, alt });
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, { once: true });
    picture.src = url;
  }

  function openViewer(holder) {
    const chat = holder.closest(".chat-pane") ?? document;
    const holders = [...chat.querySelectorAll('.md-image[data-state="shown"]')];
    const index = holders.indexOf(holder);
    if (index === -1) return;
    viewer.open(holders.map((item) => shown.get(item)), index);
  }

  return {
    // The placeholders in `node`, drawn for the chat of `paneId`.
    attach(node, paneId) {
      for (const holder of node.querySelectorAll(".md-image[data-image]")) {
        if (holder.dataset.state) continue;
        holder.dataset.state = "waiting";
        if (observer) {
          waiting.set(holder, paneId);
          observer.observe(holder);
        } else {
          void load(holder, paneId);
        }
      }
    },
  };
}
