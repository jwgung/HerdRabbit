// Everything the page asks of one pane: /api/panes/:id/... Each route is one
// entry of a table, so what a pane can be asked is read in one place and a new
// route is an entry, not another branch in the middle of the server.
//
//   const paneRoutes = createPaneRoutes({ ...what the routes use });
//   if (await paneRoutes(request, response, url, method)) return;
//
// paneRoutes answers the request and returns true, or returns false when no
// route here is for it (another path, or a method the path does not take), and
// the server goes on to its 404 or 405.
//
// The server calls it after its sign-in gate, so every route here is behind it;
// that placement is the whole of the gate's rule for them. Each route checks
// its own write token or origin (`requireWrite`, `requireSameOrigin`) before it
// reads anything else of the request, and decodes the pane id only where it
// needs it, so a bad id behind a missing token is still a 403.
import {
  HerdrCommandError,
  InputValidationError,
  MAX_PANE_READ_LINES,
  validation,
} from "./herdr-client.mjs";
import {
  HttpError, conversationCursor, decodePaneId, readJsonBody, requestedVersions, sendEmpty, sendJson,
} from "./http-basics.mjs";
import { paneCommandTarget } from "./slash-commands.mjs";

const LOCAL_SERVER = "local";
const DEFAULT_OUTPUT_LINES = 200;
const MAX_OUTPUT_LINES = MAX_PANE_READ_LINES - 1;
const OUTPUT_REVISION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function parseOutputLineLimit(value) {
  if (value === null || value === "") return DEFAULT_OUTPUT_LINES;
  const lines = Number(value);
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_OUTPUT_LINES) {
    throw new HttpError(
      400,
      "invalid_output_lines",
      `Output lines must be between 1 and ${MAX_OUTPUT_LINES}`,
    );
  }
  return lines;
}

function parseOutputRevision(value) {
  if (value === null || value === "") return null;
  if (!OUTPUT_REVISION_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_output_revision", "Output revision is invalid");
  }
  return value;
}

// Herdr answers a read short: blank rows at the bottom are trimmed and wrapped
// rows come back joined, so a Claude pane asked for 201 rows sends 199. One row
// past the window cannot tell whether older rows exist; half as many again, and
// never fewer than MIN_OUTPUT_OVERREAD_LINES, can.
const MIN_OUTPUT_OVERREAD_LINES = 64;

export function outputReadLines(lines) {
  const overread = Math.max(MIN_OUTPUT_OVERREAD_LINES, Math.ceil(lines / 2));
  return Math.min(MAX_PANE_READ_LINES, lines + overread);
}

export function outputWindow(output, requestedLines) {
  const rows = output === "" ? [] : String(output).split("\n");
  const hasMore = rows.length > requestedLines;
  const visibleRows = hasMore ? rows.slice(-requestedLines) : rows;
  return {
    output: visibleRows.join("\n"),
    requestedLines,
    returnedLines: visibleRows.length,
    hasMore,
  };
}

// A route's path after /api/panes/:id, with the id as the first capture.
const pane = (tail) => new RegExp(`^/api/panes/([^/]+)${tail}$`);

// A PC connected with Connect PC that is too old to do this yet.
const notAvailableYet = () => new HerdrCommandError("That is not available for this PC yet.", { code: "link_unsupported" });

// `herdr`: the Herdr client (this machine's and, for a connected PC's pane, that PC's).
// `requireWrite(request)`: the write token and same origin, or a 403.
// `requireSameOrigin(request)`: for a read that must not be asked from another site.
// `asksForSecret(paneId)`: whether the pane is asking for a password right now.
export function createPaneRoutes({
  herdr,
  conversationService,
  promptService,
  slashCommandCatalog,
  notificationMonitor = null,
  outputRevisions,
  outputWatcher,
  asksForSecret,
  requireWrite,
  requireSameOrigin,
  maxBodyBytes,
}) {
  // A write that carries JSON: the token first, then the body.
  async function writeBody(request) {
    requireWrite(request);
    return readJsonBody(request, maxBodyBytes);
  }

  // A write that needs nothing but the pane: no body, or a JSON object ({}).
  async function writeWithoutBody(request) {
    requireWrite(request);
    const hasBody = Number(request.headers["content-length"] || 0) > 0 || Boolean(request.headers["transfer-encoding"]);
    if (hasBody) await readJsonBody(request, maxBodyBytes);
  }

  const routes = [
    { method: "GET", pattern: pane("/layout"), async handle({ response, match }) {
      if (typeof herdr.paneLayout !== "function") throw notAvailableYet();
      const layout = await herdr.paneLayout(decodePaneId(match[1]));
      sendJson(response, 200, layout?.result ?? layout ?? {});
    } },

    // Splitting a tab's panes. Ids are the page's own (scoped); a pane
    // dropped or split comes back as its new id (a dropped one that could
    // not then be swapped to the left or the top says `placed: false`).
    { method: "POST", pattern: pane("/(split|close|zoom|move)"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const paneId = decodePaneId(match[1]);
      if (match[2] === "split") {
        sendJson(response, 200, await herdr.splitPane(paneId, body.direction));
      } else if (match[2] === "move") {
        if (typeof body.targetPaneId !== "string") throw new InputValidationError("Invalid target pane id");
        sendJson(response, 200, await herdr.movePaneSplit(paneId, body.targetPaneId, body.side));
      } else if (match[2] === "zoom") {
        if (body.mode !== "toggle") throw new InputValidationError("Zoom mode must be toggle");
        await herdr.zoomPane(paneId);
        sendJson(response, 200, {});
      } else {
        if (body.confirmed !== true) {
          throw new HttpError(400, "confirmation_required", "Close confirmation is required");
        }
        await herdr.closePane(paneId);
        sendJson(response, 200, {});
      }
    } },

    // Rearranging a split tab's panes (this machine's only): two panes of
    // one tab trade places, or one moves next to another on a side. A
    // relocate whose second step failed is still a 200 with `placed: false`
    // and a message: the pane moved, and the page has to follow it.
    { method: "POST", pattern: pane("/(swap|relocate)"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const paneId = decodePaneId(match[1]);
      const swap = match[2] === "swap";
      if (typeof herdr[swap ? "swapPanes" : "relocatePane"] !== "function") throw notAvailableYet();
      if (typeof body.targetPaneId !== "string") throw new InputValidationError("Invalid target pane id");
      sendJson(response, 200, swap
        ? await herdr.swapPanes(paneId, body.targetPaneId)
        : await herdr.relocatePane(paneId, body.targetPaneId, body.side));
    } },

    // Evening out a split tab (this machine's only): its panes take equal
    // shares, resized in Herdr where every device sees it. A layout it
    // cannot even out is still a 200, with `even: false` and a message.
    { method: "POST", pattern: pane("/even-layout"), async handle({ request, response, match }) {
      await writeWithoutBody(request);
      if (typeof herdr.evenLayout !== "function") throw notAvailableYet();
      sendJson(response, 200, await herdr.evenLayout(decodePaneId(match[1])));
    } },

    // Taking a pane out of its split session into a session of its own in
    // the same project. It comes back as { pane_id, tab_id }: the page
    // follows the pane should Herdr have given it a new id.
    { method: "POST", pattern: pane("/move-out"), async handle({ request, response, match }) {
      await writeWithoutBody(request);
      if (typeof herdr.movePaneOut !== "function") throw notAvailableYet();
      sendJson(response, 200, await herdr.movePaneOut(decodePaneId(match[1])));
    } },

    { method: "GET", pattern: pane("/output"), async handle({ response, url, match }) {
      const paneId = decodePaneId(match[1]);
      const lines = parseOutputLineLimit(url.searchParams.get("lines"));
      const since = parseOutputRevision(url.searchParams.get("since"));
      // Legacy history=hybrid requests also use the terminal's own scrollback.
      const output = await herdr.readPane(paneId, {
        lines: outputReadLines(lines),
        format: "ansi",
      });
      const window = outputWindow(output, lines);
      const update = outputRevisions.update({ paneId, window, since });
      if (update === null) {
        sendEmpty(response, 204);
        return;
      }
      sendJson(response, 200, update);
    } },

    // A Claude or Codex pane's conversation, a page of turns at a time. The ETag is
    // the answer's version: an unchanged poll costs no body.
    { method: "GET", pattern: pane("/conversation"), async handle({ request, response, url, match }) {
      const answer = await conversationService.page(decodePaneId(match[1]), {
        before: conversationCursor(url.searchParams.get("before")),
        since: conversationCursor(url.searchParams.get("since")),
        ifNoneMatch: requestedVersions(request.headers["if-none-match"]),
      });
      response.setHeader("ETag", `"${answer.version}"`);
      if (answer.notModified) {
        sendEmpty(response, 304);
        return;
      }
      sendJson(response, 200, answer);
    } },

    // One tool call's whole output (capped), which a page only previews.
    { method: "GET", pattern: pane("/conversation/tools/([^/]+)"), async handle({ response, match }) {
      sendJson(response, 200, await conversationService.toolOutput(
        decodePaneId(match[1]), decodePaneId(match[2]),
      ));
    } },

    // The `/` commands the pane's agent takes, for the composer's list:
    // names, descriptions and where each comes from, never a file's body.
    // A pane on a connected PC gets that PC's own list, which it builds from
    // its own files and snapshot; one that cannot say gets its agent's own
    // commands only.
    { method: "GET", pattern: pane("/commands"), async handle({ request, response, match }) {
      requireSameOrigin(request);
      const paneId = decodePaneId(match[1]);
      const target = paneCommandTarget(await herdr.snapshot(), paneId);
      if (!target) throw new HttpError(404, "pane_not_found", "That pane is gone.");
      const serverId = typeof target.pane.server_id === "string" && target.pane.server_id ? target.pane.server_id : LOCAL_SERVER;
      if (serverId === LOCAL_SERVER && !paneId.includes("!")) {
        sendJson(response, 200, await slashCommandCatalog.list({ agent: target.agent, cwd: target.cwd }));
        return;
      }
      sendJson(response, 200, await slashCommandCatalog.listRemote({
        agent: target.agent,
        key: paneId,
        ask: () => typeof herdr.paneCommands === "function" ? herdr.paneCommands(paneId) : null,
      }));
    } },

    // The card a blocked pane shows (approval, question, menu), or null.
    { method: "GET", pattern: pane("/prompt"), async handle({ response, match }) {
      sendJson(response, 200, { card: await promptService.card(decodePaneId(match[1])) });
    } },

    // An option of that card, by its id: a card that changed meanwhile is a
    // 409 prompt_changed, and nothing is sent.
    { method: "POST", pattern: pane("/prompt/answer"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const paneId = decodePaneId(match[1]);
      const result = await promptService.answer(paneId, body);
      outputWatcher.input(paneId);
      sendJson(response, 200, result);
    } },

    { method: "POST", pattern: pane("/text"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const paneId = decodePaneId(match[1]);
      const secret = body.submit === true && await asksForSecret(paneId);
      await herdr.sendText(paneId, body.text, {
        submit: body.submit === true,
      });
      promptService.nudge(paneId);
      if (body.submit === true && !secret) {
        notificationMonitor?.recordRequest(paneId, body.text);
      }
      sendJson(response, 200, { ok: true, ...(secret ? { secret } : {}) });
    } },

    { method: "POST", pattern: pane("/keys"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const paneId = decodePaneId(match[1]);
      await herdr.sendKeys(paneId, body.keys, { stop: validation.validateStop(body.stop) });
      promptService.nudge(paneId);
      sendJson(response, 200, { ok: true });
    } },

    // Find in the pane's whole history. It moves nothing (the reveal below
    // does); the CSRF check stays for consistency. A history that changed
    // since the match before is a 409 stale_content; the page searches anew.
    { method: "POST", pattern: pane("/find"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const find = validation.validateFindRequest({
        query: body.query, direction: body.direction,
        previous: body.previous, contentRevision: body.contentRevision,
      });
      sendJson(response, 200, await herdr.paneFind(decodePaneId(match[1]), find));
    } },

    // Scrolls the pane's view, which every client of the pane shares, to a
    // match a find gave. A history that changed since is a 409 stale_content.
    { method: "POST", pattern: pane("/reveal"), async handle({ request, response, match }) {
      const body = await writeBody(request);
      const reveal = validation.validateRevealRequest({
        match: body.match, contentRevision: body.contentRevision,
        ...(body.coverRows === undefined ? {} : { coverRows: body.coverRows }),
      });
      sendJson(response, 200, await herdr.paneReveal(decodePaneId(match[1]), reveal));
    } },

    // Scrolls the pane's shared view to the newest output (the page asks when
    // the reader goes from the Chat lens to the Terminal lens).
    { method: "POST", pattern: pane("/scroll-bottom"), async handle({ request, response, match }) {
      requireWrite(request);
      sendJson(response, 200, await herdr.paneScrollToBottom(decodePaneId(match[1])));
    } },
  ];

  return async function paneRoutes(request, response, url, method) {
    if (!url.pathname.startsWith("/api/panes/")) return false;
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      await route.handle({ request, response, url, match });
      return true;
    }
    return false;
  };
}
