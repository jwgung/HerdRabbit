import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import {
  HttpError, acceptUpload, aiAccountRoute, conversationCursor, decodePaneId, readJsonBody, requestedVersions, sendJson,
} from "./http-basics.mjs";
import { ConversationUnavailable } from "./conversation/pages.mjs";
import { validation } from "./herdr-client.mjs";
import { LINK_PROTOCOL } from "./link-protocol.mjs";
import { directoryFingerprint, fileAccessError, listDirectory, openFile } from "./file-browser.mjs";
import { validateTransferName } from "./file-store.mjs";
import { defaultProtectedPaths } from "./protected-paths.mjs";
import { SlashCommandCatalog, paneCommandTarget } from "./slash-commands.mjs";

// Undici tears a response down after five idle minutes, and a quiet terminal
// easily goes that long, so the stream says something well before then.
const HEARTBEAT_MS = 15_000;
const MAX_WATCHED_PANES = 512;
// Status streams open at once. A hub keeps one per page watching this PC.
const MAX_STATUS_STREAMS = 16;
const AI_ACCOUNT_ROUTE = aiAccountRoute("/api/link/ai-accounts");



// The local browser reports failures as ordinary fs errors; the hub needs the
// status the person would have seen opening this machine directly.
async function browsing(work) {
  try {
    return await work();
  } catch (error) {
    const mapped = fileAccessError(error);
    if (!mapped) throw error;
    throw new HttpError(mapped.status, mapped.code, mapped.message);
  }
}

// Always octet-stream: this surface hands bytes to a hub, and what the hub is
// allowed to call them is decided there, against the same allow-list a local
// file goes through. A connected PC never gets to name a content type for a browser.
async function sendFile(response, file) {
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("X-Herdr-File-Name", encodeURIComponent(file.name ?? ""));
  if (file.range) {
    // A player on the hub's side seeks; the connected PC holds the file, so the seek
    // has to travel the whole way rather than stop at the hub.
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${file.range.start}-${file.range.end}/${file.size}`);
  } else {
    response.statusCode = 200;
  }
  const length = file.range ? file.length : file.size;
  if (length !== null && length !== undefined) response.setHeader("Content-Length", length);
  response.on("close", () => file.stream.destroy());
  await pipeline(file.stream, response);
}

// Another PC reaches this one through this surface and no other. It is served
// on the Connect PC port alone (src/peer-server.mjs), never next to the
// browser API: that one is shaped by things a browser has and a server does
// not -- an Origin, a cookie, a CSRF token from a page load -- and the two
// kinds of caller must not be able to borrow each other's way in.
//
// `client` is the connected PC's own Herdr client, never its MultiServerClient. That is
// what makes "a connected PC reports only its own sessions" structural: it does not
// hold anyone else's to report.
// `protectedPaths` is what the file browser never opens: sign-in keys and
// HerdRabbit's own settings (src/protected-paths.mjs). A hub is held to it
// exactly as a person browsing this PC's own page is.
// `attach` is linkAttachSockets (src/link-attach.mjs): it answers which
// terminal a pane has before a hub attaches to it on the same port.
// `conversations` is this PC's own ConversationService (the one its page
// uses): a hub's Chat reads this PC's transcripts through it, here.
// `slashCommands` is this PC's own SlashCommandCatalog (the one its page
// uses): a hub's composer lists a pane's `/` commands through it.
// `updater` is this PC's own AppUpdater (src/app-update.mjs): a hub checks
// for and starts an update of this PC through it, never naming anything.
export function linkRoutes({
  client, files = null, aiAccounts = null, attach = null, conversations = null, slashCommands = null, updater = null, version, herdrVersion = () => null, serverName = "",
  maxBodyBytes = 128 * 1024, maxTransferBytes = 50 * 1024 * 1024, protectedPaths = defaultProtectedPaths(),
  maxStatusStreams = MAX_STATUS_STREAMS,
}) {
  let openStreams = 0;
  const commandCatalog = slashCommands ?? new SlashCommandCatalog({ guard: protectedPaths });

  function hello() {
    return {
      product: "herdrabbit",
      version,
      link_protocol: LINK_PROTOCOL,
      scope: "local",
      server_name: serverName,
      // Optional, so a hub reading an older connected PC just sees no Herdr version.
      herdr_version: herdrVersion(),
      // What this PC answers beyond the protocol's base, so a hub asks only
      // for what is there. A PC from before this list says nothing.
      features: [
        ...(conversations ? ["conversation"] : []), "scroll_bottom", "commands", ...(updater ? ["update"] : []),
      ],
    };
  }

  async function statuses(request, response, body) {
    const paneIds = body.paneIds;
    if (!Array.isArray(paneIds) || paneIds.length === 0 || paneIds.length > MAX_WATCHED_PANES ||
        paneIds.some((id) => typeof id !== "string" || id === "" || id.length > 512)) {
      throw new HttpError(400, "invalid_input", "Invalid status subscription");
    }
    if (typeof client.watchStatuses !== "function") {
      throw new HttpError(501, "statuses_unsupported", "This server cannot report agent status.");
    }
    if (openStreams >= maxStatusStreams) {
      throw new HttpError(429, "too_many_streams", "Too many status streams are open. Try again shortly.");
    }
    openStreams += 1;

    let stop = null;
    let closed = false;
    const write = (text) => { if (!closed) response.write(text); };
    let counted = true;
    const release = () => {
      if (counted) { counted = false; openStreams -= 1; }
    };
    const finish = () => {
      release();
      if (closed) return;
      closed = true;
      clearInterval(beat);
      stop?.();
      response.end();
    };

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    // Nothing should sit between a connected PC and its hub, but a buffering proxy
    // would hold every event until the stream ends, which is never.
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    const beat = setInterval(() => write(":hb\n\n"), HEARTBEAT_MS);
    beat.unref?.();
    // The hub going away has to release the underlying subscription. `response`
    // covers the connection dropping as well as an orderly end; `request` alone
    // does not fire reliably once the body has been consumed.
    request.once("close", finish);
    response.once("close", finish);

    try {
      stop = await client.watchStatuses(
        [...new Set(paneIds)],
        (event) => write(`data: ${JSON.stringify({ pane_id: event.pane_id, agent_status: event.agent_status })}\n\n`),
        (error) => {
          write(`event: error\ndata: ${JSON.stringify({ message: String(error?.message || "Status stream failed") })}\n\n`);
          finish();
        },
      );
    } catch (error) {
      // The subscription never started, so this is still an ordinary failure
      // the hub can read as one rather than a stream that opened and died.
      clearInterval(beat);
      closed = true;
      release();
      response.end(`event: error\ndata: ${JSON.stringify({ message: String(error?.message || "Status stream failed") })}\n\n`);
      return;
    }
    if (closed) stop?.();
    else write("event: ready\ndata: {}\n\n");
  }

  // Pages, a tool's whole output, a change signature and the plan or question
  // a Claude pane waits on. Only this PC's own panes: an id naming another
  // server ("server!pane") is one this PC's page lists for a PC or machine
  // it reaches itself, and a hub is not let through to those.
  async function conversation(request, response, url, [, encodedPane, signature, encodedTool, pendingAsk]) {
    if (!conversations) throw new HttpError(501, "conversations_unsupported", "This PC cannot read conversations.");
    const paneId = decodePaneId(encodedPane);
    if (paneId.includes("!")) throw new ConversationUnavailable("pane_not_found");
    if (pendingAsk) {
      sendJson(response, 200, { ask: await conversations.pendingAsk(paneId) });
      return;
    }
    if (signature) {
      sendJson(response, 200, { signature: await conversations.signature(paneId) });
      return;
    }
    if (encodedTool !== undefined) {
      sendJson(response, 200, await conversations.toolOutput(paneId, decodePaneId(encodedTool)));
      return;
    }
    const answer = await conversations.page(paneId, {
      before: conversationCursor(url.searchParams.get("before")),
      since: conversationCursor(url.searchParams.get("since")),
      ifNoneMatch: requestedVersions(request.headers["if-none-match"]),
    });
    response.setHeader("ETag", `"${answer.version}"`);
    if (answer.notModified) {
      response.statusCode = 304;
      response.end();
      return;
    }
    sendJson(response, 200, answer);
  }

  return async function handle(request, response, url, method) {
    if (!url.pathname.startsWith("/api/link/")) return false;

    if (method === "GET" && url.pathname === "/api/link/hello") {
      sendJson(response, 200, hello());
      return true;
    }

    if (method === "GET" && url.pathname === "/api/link/snapshot") {
      // The handshake rides along so the hub re-checks compatibility on every
      // poll without paying for a second round trip.
      sendJson(response, 200, { hello: hello(), snapshot: await client.snapshot() });
      return true;
    }

    // This PC's own update: whether origin has a newer main, starting
    // update.sh, and how that run goes. Nothing in the request is used but
    // whether the check may be a fresher one.
    if (url.pathname === "/api/link/update" || url.pathname === "/api/link/update/run") {
      if (!updater) throw new HttpError(404, "not_found", "Not found");
      if (method === "GET" && url.pathname === "/api/link/update") {
        sendJson(response, 200, await updater.check({ fresh: url.searchParams.get("fresh") === "1" }));
      } else if (method === "GET") {
        sendJson(response, 200, await updater.runStatus());
      } else if (method === "POST" && url.pathname === "/api/link/update/run") {
        sendJson(response, 202, await updater.start());
      } else {
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      }
      return true;
    }

    // A pane's conversation, read here exactly as this PC's page reads it.
    const conversationMatch = method === "GET" &&
      url.pathname.match(/^\/api\/link\/panes\/([^/]+)\/(?:conversation(?:\/(signature)|\/tools\/([^/]+))?|(pending-ask))$/u);
    if (conversationMatch) {
      await conversation(request, response, url, conversationMatch);
      return true;
    }

    // The `/` commands one of this PC's panes takes, for a hub's composer:
    // built here from this PC's own files, for the agent and folder this PC's
    // own snapshot gives the pane -- the hub names only the pane. Names,
    // descriptions and sources only, as this PC's page gets them.
    const commandsMatch = method === "GET" && url.pathname.match(/^\/api\/link\/panes\/([^/]+)\/commands$/u);
    if (commandsMatch) {
      const paneId = decodePaneId(commandsMatch[1]);
      const target = paneId.includes("!") ? null : paneCommandTarget(await client.snapshot(), paneId);
      if (!target) throw new HttpError(404, "pane_not_found", "That pane is gone.");
      const answer = await commandCatalog.list({ agent: target.agent, cwd: target.cwd });
      sendJson(response, 200, {
        agent: answer.agent,
        commands: answer.commands.map(({ name, description, source }) => ({ name, description, source })),
      });
      return true;
    }

    const paneMatch = url.pathname.match(/^\/api\/link\/panes\/([^/]+)\/(output|text|keys|terminal|find|reveal|scroll-bottom)$/u);
    if (paneMatch) {
      const paneId = decodePaneId(paneMatch[1]);
      // Which terminal the pane has, never how to run it: the herdr binary and
      // its socket stay on this PC, where the attach runs.
      if (method === "GET" && paneMatch[2] === "terminal") {
        if (!attach) throw new HttpError(501, "attach_unsupported", "This PC cannot attach terminals.");
        sendJson(response, 200, await attach.describe(paneId));
        return true;
      }
      if (method === "GET" && paneMatch[2] === "output") {
        const output = await client.readPane(paneId, {
          lines: validation.validateLines(url.searchParams.get("lines")),
          format: validation.validateReadFormat(url.searchParams.get("format")),
          // A hub's prompt card reads the region herdr detects agent states
          // from, as a card on this PC's page does.
          ...(url.searchParams.has("source") ? { source: validation.validateReadSource(url.searchParams.get("source")) } : {}),
        });
        // A string, not a revision window: the hub's own watcher does the
        // diffing, and it expects what a local read would have given it.
        sendJson(response, 200, { output: String(output) });
        return true;
      }
      if (method === "POST" && paneMatch[2] === "text") {
        const body = await readJsonBody(request, maxBodyBytes);
        await client.sendText(paneId, validation.validateText(body.text), { submit: body.submit === true });
        sendJson(response, 200, { ok: true });
        return true;
      }
      // Find in this PC's pane history, and scroll its view to a match, as the
      // page's own /find and /reveal do.
      if (method === "POST" && paneMatch[2] === "find") {
        const body = await readJsonBody(request, maxBodyBytes);
        const find = validation.validateFindRequest({
          query: body.query, direction: body.direction,
          previous: body.previous, contentRevision: body.contentRevision,
        });
        sendJson(response, 200, await client.paneFind(paneId, find));
        return true;
      }
      if (method === "POST" && paneMatch[2] === "reveal") {
        const body = await readJsonBody(request, maxBodyBytes);
        const reveal = validation.validateRevealRequest({
          match: body.match, contentRevision: body.contentRevision,
          ...(body.coverRows === undefined ? {} : { coverRows: body.coverRows }),
        });
        sendJson(response, 200, await client.paneReveal(paneId, reveal));
        return true;
      }
      if (method === "POST" && paneMatch[2] === "scroll-bottom") {
        sendJson(response, 200, await client.paneScrollToBottom(paneId));
        return true;
      }
      if (method === "POST" && paneMatch[2] === "keys") {
        const body = await readJsonBody(request, maxBodyBytes);
        await client.sendKeys(paneId, validation.validateKeys(body.keys));
        sendJson(response, 200, { ok: true });
        return true;
      }
    }

    // Files are answered by this machine's own browser, the same one a person
    // opening this HerdRabbit directly would use. Nothing here knows how to
    // read another machine's disk, which is the point: a hub asks each connected PC
    // about itself.
    if (url.pathname === "/api/link/browse" && method === "GET") {
      const prefix = url.searchParams.get("prefix") || "";
      if (prefix.length > 255) throw new HttpError(400, "invalid_input", "That name is too long.");
      const target = url.searchParams.get("path") || homedir();
      sendJson(response, 200, await browsing(() => listDirectory(target, { prefix, guard: protectedPaths })));
      return true;
    }

    if (url.pathname === "/api/link/browse/fingerprint" && method === "GET") {
      const target = url.searchParams.get("path") || homedir();
      sendJson(response, 200, { fingerprint: await browsing(() => directoryFingerprint(target, { guard: protectedPaths })) });
      return true;
    }

    if (url.pathname === "/api/link/browse/file" && method === "GET") {
      const file = await browsing(() => openFile(url.searchParams.get("path"), {
        rangeHeader: request.headers.range ?? null,
        maxBytes: maxTransferBytes,
        guard: protectedPaths,
      }));
      await sendFile(response, file);
      return true;
    }

    const filesMatch = url.pathname.match(/^\/api\/link\/files(?:\/([^/]+))?$/u);
    if (filesMatch) {
      if (!files) throw new HttpError(501, "files_unavailable", "This server has no uploads folder.");
      const name = filesMatch[1] === undefined ? null : validateTransferName(decodeURIComponent(filesMatch[1]));
      if (method === "GET" && !name) {
        sendJson(response, 200, { directory: files.directory, files: await files.list() });
        return true;
      }
      if (method === "GET" && name) {
        const { file, stream } = await files.open(name);
        await sendFile(response, { ...file, stream });
        return true;
      }
      if (method === "POST" && name) {
        sendJson(response, 201, { file: await files.save(name, acceptUpload(request, maxTransferBytes)) });
        return true;
      }
      if (method === "DELETE" && name) {
        await files.remove(name);
        response.statusCode = 204;
        response.end();
        return true;
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    }

    // Project and tab changes. The connected PC validates them through the same client
    // a person on that machine would drive, so the rules cannot drift apart.
    if (method === "POST" && url.pathname === "/api/link/workspaces") {
      const body = await readJsonBody(request, maxBodyBytes);
      await (body.herdrSessionId === undefined
        ? client.createWorkspace(body.label)
        : client.createWorkspace(body.label, body.herdrSessionId));
      sendJson(response, 201, { ok: true });
      return true;
    }

    const workspaceMatch = url.pathname.match(/^\/api\/link\/workspaces\/([^/]+)\/(rename|close|tabs|move)$/u);
    if (method === "POST" && workspaceMatch) {
      const workspaceId = decodePaneId(workspaceMatch[1]);
      const body = await readJsonBody(request, maxBodyBytes);
      if (workspaceMatch[2] === "rename") await client.renameWorkspace(workspaceId, body.label);
      else if (workspaceMatch[2] === "close") await client.closeWorkspace(workspaceId);
      else if (workspaceMatch[2] === "move") await client.moveWorkspace(workspaceId, body.insertIndex);
      else await client.createTab(workspaceId);
      sendJson(response, 200, { ok: true });
      return true;
    }

    const tabMatch = url.pathname.match(/^\/api\/link\/tabs\/([^/]+)\/(rename|close|move)$/u);
    if (method === "POST" && tabMatch) {
      const tabId = decodePaneId(tabMatch[1]);
      const body = await readJsonBody(request, maxBodyBytes);
      if (tabMatch[2] === "move") {
        // Within its project, or to another project of the same Herdr session;
        // the moved pane's new ids go back so the hub's page can follow it.
        if (body.workspaceId === undefined) {
          await client.moveTab(tabId, body.insertIndex);
          sendJson(response, 200, { moved: { tab_id: tabId, panes: [], reordered: true } });
        } else {
          if (typeof body.workspaceId !== "string") throw new HttpError(400, "invalid_input", "Invalid workspace id");
          sendJson(response, 200, { moved: await client.moveTabToWorkspace(tabId, body.workspaceId, body.insertIndex) });
        }
        return true;
      }
      if (tabMatch[2] === "rename") await client.renameTab(tabId, body.label);
      else await client.closeTab(tabId);
      sendJson(response, 200, { ok: true });
      return true;
    }

    // AI CLI accounts on this machine. The hub asks for changes and hears back
    // whose account is where; the sign-ins themselves never leave this machine.
    const accountsMatch = url.pathname.match(AI_ACCOUNT_ROUTE);
    if (accountsMatch) {
      if (!aiAccounts) throw new HttpError(501, "ai_accounts_unavailable", "This server cannot manage AI accounts.");
      const [, action, loginId, step] = accountsMatch;
      if (method === "GET" && !action && !loginId) {
        sendJson(response, 200, await aiAccounts.list());
        return true;
      }
      if (method !== "POST" || (!action && !loginId)) throw new HttpError(405, "method_not_allowed", "Method not allowed");
      const body = await readJsonBody(request, maxBodyBytes);
      let result;
      if (action === "current") result = await aiAccounts.saveCurrent(body.cli);
      else if (action === "switch") result = await aiAccounts.switch(body.cli, body.account, { confirmRunning: body.confirmRunning === true });
      else if (action === "remove") result = await aiAccounts.remove(body.cli, body.account);
      else if (action === "logins") result = await aiAccounts.startLogin(body.cli);
      else if (step === "finish") result = await aiAccounts.finishLogin(body.cli, loginId);
      else result = await aiAccounts.cancelLogin(body.cli, loginId);
      sendJson(response, 200, result);
      return true;
    }

    if (url.pathname === "/api/link/statuses") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      // A body, not a query string: 512 pane ids overflow a URL long before
      // they trouble a request body.
      await statuses(request, response, await readJsonBody(request, maxBodyBytes));
      return true;
    }

    throw new HttpError(404, "not_found", "Not found");
  };
}
