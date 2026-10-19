// In-app update: the ⚙ menu's Update window. Each PC -- this one and every PC
// connected with Connect PC -- is checked when the app opens and when Check is
// pressed, never on a timer. Update runs update.sh on that PC (the server
// starts it outside its own service), and this page follows the run: through
// the restart for this PC, after which it reloads into the new version.
// Each PC also has a Herdr row: the Herdr it runs against the newest on its
// channel, and Update Herdr, which runs `herdr update --handoff` there and is
// followed the same way, without a restart.

export const BLOCKED_TEXT = {
  running: "An update is already running.",
  not_service: "HerdRabbit is not running as its systemd user service here, so it cannot update itself. Run update.sh on that PC.",
  wrong_origin: "This checkout's origin is not ultivis-iot/HerdRabbit. Update it by hand.",
  not_main: "This checkout is not on the main branch.",
  local_changes: "This checkout has local changes. Commit or move them first.",
  diverged: "Local main has commits that are not on origin. Reconcile it by hand.",
};

export const ERROR_TEXT = {
  fetch_failed: "Could not reach origin to check for a new version.",
  not_git: "This HerdRabbit is not a git checkout, so it cannot update itself.",
};

export const HERDR_BLOCKED_TEXT = {
  running: "An update is already running.",
  unsupported_platform: "Herdr can be updated from here on Linux only. Run herdr update on that PC.",
  no_systemd_run: "systemd-run is not available here, so Herdr cannot be updated from the page. Run herdr update on that PC.",
  managed_install: "Herdr was installed with a package manager (Homebrew, Nix or mise). Update it with that package manager.",
};

export const HERDR_ERROR_TEXT = {
  herdr_missing: "Herdr was not found where HerdRabbit looks for it.",
  manifest_failed: "Could not reach herdr.dev to check for a new Herdr.",
  version_unknown: "Could not read the installed Herdr's version.",
};

export function herdrBlockedText(code) {
  return HERDR_BLOCKED_TEXT[code] ?? "Herdr cannot be updated here right now.";
}

export function herdrErrorText(code) {
  return HERDR_ERROR_TEXT[code] ?? "Could not check for a new Herdr.";
}

export function blockedText(code) {
  return BLOCKED_TEXT[code] ?? "This PC cannot run the update right now.";
}

export function errorText(code) {
  return ERROR_TEXT[code] ?? "Could not check for a new version.";
}

export function revisionText(revision) {
  if (!revision || (!revision.version && !revision.sha)) return "unknown";
  if (!revision.sha) return revision.version;
  return revision.version ? `${revision.version} (${revision.sha})` : revision.sha;
}

// Whether the ⚙ button carries a dot: some PC has something newer.
export function anyUpdate(results) {
  return [...results].some((result) => result?.supported === true &&
    (result.available === true || result.herdr?.available === true));
}

export function confirmText(name, check) {
  return [
    `Update ${name} to ${revisionText(check?.latest)}?`,
    "",
    "update.sh fetches main, updates Herdr, installs dependencies, runs the checks and restarts HerdRabbit there. " +
      "Running sessions keep running; the page loses its connection for a moment while the service restarts.",
    "If a step fails, update.sh puts the previous version back.",
  ].join("\n");
}

export function herdrConfirmText(name, herdr) {
  return [
    `Update Herdr on ${name} from ${herdr?.current ?? "unknown"} to ${herdr?.latest ?? "the newest version"}?`,
    "",
    "herdr update --handoff downloads the new Herdr and hands the running panes over to it live: " +
      "agents and shells keep running. It can take a moment.",
  ].join("\n");
}

export const RECENT_RUN_MS = 30 * 60_000;

export const INTEGRATIONS_NOTE = "Herdr asks to update its agent integrations: run the herdr integration install commands shown in the log in a terminal.";

// A finished run is shown until the person has seen it once. What was seen is
// remembered per PC and kind by the run's finishedAt; when the browser's
// storage does not work, only the recent window decides.
const dismissKey = (serverId, kind) => `herdrabbit.update.seen.${kind}.${serverId}`;

export function runDismissed(storage, serverId, kind, finishedAt) {
  try {
    return Boolean(finishedAt) && storage.getItem(dismissKey(serverId, kind)) === finishedAt;
  } catch {
    return false;
  }
}

export function dismissRun(storage, serverId, kind, finishedAt) {
  if (!finishedAt) return;
  try {
    storage.setItem(dismissKey(serverId, kind), finishedAt);
  } catch { /* the recent window decides instead */ }
}

export function isFinished(status) {
  return Boolean(status) && status.state !== "idle" && status.state !== "running";
}

// Whether a run the server reports as ended is still worth showing.
export function showFinishedRun(status, { serverId, kind, storage, now = Date.now() }) {
  if (!isFinished(status)) return false;
  const finished = Date.parse(status.finishedAt);
  if (!(now - finished < RECENT_RUN_MS)) return false;
  return !runDismissed(storage, serverId, kind, status.finishedAt);
}

export function needsIntegrations(status) {
  return isFinished(status) && typeof status.log === "string" && status.log.includes("herdr integration install");
}

function defaultStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const HERDR_RUN_TEXT = {
  running: "Updating Herdr…",
  succeeded: "Herdr updated.",
  failed: "The Herdr update failed. The installed Herdr keeps running; the log says why.",
  refused: "Herdr will not update itself here:",
};

const RUN_TEXT = {
  running: "Updating…",
  succeeded: "Updated.",
  failed: "The update failed. update.sh put the previous version back where it could; the log says why.",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

// `servers()` lists the PCs to show, [{ id, name }], this PC first.
// `onChange(available)` hears whether the ⚙ button should carry its dot.
export function createUpdatePanel({
  api, dialog, list, feedback, checkButton, servers, onChange = () => {},
  confirm = (text) => window.confirm(text), reload = () => window.location.reload(),
  pollMs = 1_500, giveUpMs = 15 * 60_000, storage = defaultStorage(),
}) {
  // Per PC: { check, error, run, herdrRun }, a run being
  // { status, tracking, waiting }.
  const entries = new Map();
  // Which run of this PC's server the page was loaded from.
  let baseline = null;
  let checking = false;

  const entry = (id) => {
    if (!entries.has(id)) entries.set(id, { check: null, error: null, run: null, herdrRun: null });
    return entries.get(id);
  };
  const query = (id, fresh = false) => `server=${encodeURIComponent(id)}${fresh ? "&fresh=1" : ""}`;

  function changed() {
    onChange(anyUpdate([...entries.values()].map((item) => item.check)));
    if (dialog.open) render();
  }

  async function checkOne(id, fresh) {
    const item = entry(id);
    try {
      item.check = await api(`/api/update?${query(id, fresh)}`);
      item.error = null;
    } catch (error) {
      if (error.code === "authentication_required") throw error;
      item.error = error.message || "Could not check this PC.";
    }
  }

  async function refresh({ fresh = false } = {}) {
    if (checking) return;
    checking = true;
    checkButton.disabled = true;
    if (dialog.open) feedback.textContent = "Checking…";
    try {
      const known = servers();
      for (const id of entries.keys()) if (!known.some((server) => server.id === id)) entries.delete(id);
      await Promise.all(known.map((server) => checkOne(server.id, fresh)));
      feedback.textContent = "";
    } catch {
      feedback.textContent = "";
    } finally {
      checking = false;
      checkButton.disabled = false;
      changed();
    }
  }

  // On load: which run of the server this is, and a run already under way
  // (the page was reloaded during one) is followed again.
  async function resume() {
    try {
      // each update on its own: one this PC cannot run does not stop the other being followed
      const status = await api(`/api/update/run?${query("local")}`);
      if (status.supported !== false) {
        baseline = { boot: status.boot ?? null, version: status.version ?? null };
        if (status.state === "running") void track("local", status);
        // A run that ended lately is still shown, so the page that reloaded
        // into the new version can say how it went.
        else if (showFinishedRun(status, { serverId: "local", kind: "app", storage })) {
          entry("local").run = { status, tracking: false, waiting: false };
        }
      }
    } catch { /* checked again with the rest */ }
    try {
      const status = await api(`/api/update/herdr/run?${query("local")}`);
      if (status.supported === false) return;
      if (status.state === "running") void trackHerdr("local", status);
      else if (showFinishedRun(status, { serverId: "local", kind: "herdr", storage })) {
        entry("local").herdrRun = { status, tracking: false, waiting: false };
      }
    } catch { /* shown again once checked */ }
  }

  const busy = (item) => item.run?.tracking === true || item.herdrRun?.tracking === true;

  async function runHerdr(id) {
    const server = servers().find((item) => item.id === id);
    const item = entry(id);
    if (!server || !item.check?.herdr?.available || busy(item)) return;
    if (!confirm(herdrConfirmText(server.name, item.check.herdr))) return;
    feedback.textContent = "";
    try {
      const status = await api("/api/update/herdr/run", { method: "POST", body: { server: id } });
      void trackHerdr(id, status);
    } catch (error) {
      feedback.textContent = error.message || "Could not start the Herdr update.";
      feedback.dataset.error = "true";
    }
  }

  // Polls Herdr's run until it ends, then checks that PC again so the new
  // version shows. HerdRabbit does not restart; a missed answer is retried.
  async function trackHerdr(id, status) {
    const item = entry(id);
    item.herdrRun = { status, tracking: true, waiting: false };
    changed();
    const started = Date.now();
    while (Date.now() - started < giveUpMs) {
      await sleep(pollMs);
      let next;
      try {
        next = await api(`/api/update/herdr/run?${query(id)}`);
      } catch (error) {
        if (error.code === "authentication_required") break;
        item.herdrRun.waiting = true;
        changed();
        continue;
      }
      item.herdrRun = { status: next, tracking: next.state === "running", waiting: false };
      if (next.state === "running") {
        changed();
        continue;
      }
      // a re-check that fails leaves the buttons usable all the same
      if (next.state === "succeeded") await checkOne(id, true).catch(() => {});
      break;
    }
    item.herdrRun.tracking = false;
    item.herdrRun.waiting = false;
    changed();
  }

  async function run(id) {
    const server = servers().find((item) => item.id === id);
    const item = entry(id);
    if (!server || !item.check?.available || busy(item)) return;
    if (!confirm(confirmText(server.name, item.check))) return;
    feedback.textContent = "";
    try {
      const status = await api("/api/update/run", { method: "POST", body: { server: id } });
      void track(id, status);
    } catch (error) {
      feedback.textContent = error.message || "Could not start the update.";
      feedback.dataset.error = "true";
    }
  }

  // Polls the run until it ends. A server that does not answer is restarting;
  // it is asked again until it does, for a while.
  async function track(id, status) {
    const item = entry(id);
    item.run = { status, tracking: true, waiting: false };
    changed();
    const started = Date.now();
    while (Date.now() - started < giveUpMs) {
      await sleep(pollMs);
      let next;
      try {
        next = await api(`/api/update/run?${query(id)}`);
      } catch (error) {
        if (error.code === "authentication_required") break;
        item.run.waiting = true;
        changed();
        continue;
      }
      item.run = { status: next, tracking: next.state === "running", waiting: false };
      if (next.state === "running") {
        changed();
        continue;
      }
      if (next.state === "succeeded" && id === "local" &&
          (!baseline || next.version !== baseline.version || (next.boot && next.boot !== baseline.boot))) {
        reload();
        return;
      }
      if (next.state === "succeeded") await checkOne(id, true).catch(() => {});
      break;
    }
    item.run.tracking = false;
    item.run.waiting = false;
    changed();
  }

  // A running log is shown as it comes; a finished one is folded away behind
  // "Log" unless the run failed, where it explains why.
  function logBlock(run, status, className, kind, serverId) {
    const pre = element("pre", className, status.log);
    if (status.state === "running" || run.waiting) return pre;
    // seen while the dialog is open: it will not come back on a later opening
    if (dialog.open) dismissRun(storage, serverId, kind, status.finishedAt);
    const details = element("details", "update-log-fold");
    details.open = status.state === "failed" || run.logOpen === true;
    details.append(element("summary", "", "Log"), pre);
    details.addEventListener("toggle", () => { run.logOpen = details.open; });
    return details;
  }

  function noteSeen(run, kind, serverId) {
    if (dialog.open && isFinished(run?.status)) dismissRun(storage, serverId, kind, run.status.finishedAt);
  }

  function renderServer(server) {
    const item = entry(server.id);
    const section = element("section", "update-server");
    section.dataset.serverId = server.id;
    const heading = element("div", "update-server-heading");
    heading.append(element("strong", "", server.name));
    const check = item.check;
    if (check?.supported && check.available) heading.append(element("span", "update-badge", "Update available"));
    section.append(heading);

    const status = element("p", "update-status");
    section.append(status);
    if (item.error) {
      status.textContent = item.error;
      status.dataset.error = "true";
    } else if (!check) {
      status.textContent = "Not checked yet.";
    } else if (check.supported === false) {
      status.textContent = server.id === "local"
        ? "This HerdRabbit cannot update itself from the page."
        : "Update it there (older version).";
    } else {
      section.append(element("p", "update-versions",
        `Running ${revisionText(check.current)} · Latest ${check.latest ? revisionText(check.latest) : "unknown"}`));
      section.append(status);
      if (check.error) {
        status.textContent = errorText(check.error);
        status.dataset.error = "true";
      } else if (!check.available) {
        status.textContent = "Up to date.";
      } else if (check.blocked) {
        status.textContent = blockedText(check.blocked);
        status.dataset.error = "true";
      } else {
        status.textContent = "A new version is ready to install.";
      }
      if (check.available && Array.isArray(check.notes) && check.notes.length > 0) {
        const notes = element("ul", "update-notes");
        notes.setAttribute("aria-label", "What changed");
        for (const note of check.notes) notes.append(element("li", "", note));
        section.append(notes);
      }
      if (check.available && !check.blocked && !check.error) {
        const button = element("button", "primary-button update-run", "Update");
        button.type = "button";
        button.disabled = busy(item);
        button.addEventListener("click", () => void run(server.id));
        const actions = element("div", "update-actions");
        actions.append(button);
        section.append(actions);
      }
    }

    if (check?.supported && "herdr" in check) section.append(renderHerdr(server, item));

    const runStatus = item.run?.status;
    if (item.run && runStatus) {
      const progress = element("div", "update-progress");
      const text = item.run.waiting
        ? "Waiting for HerdRabbit to come back after its restart…"
        : RUN_TEXT[runStatus.state] ?? "";
      const state = element("p", "update-run-state", text);
      state.setAttribute("role", "status");
      if (runStatus.state === "failed" && !item.run.waiting) state.dataset.error = "true";
      progress.append(state);
      if (runStatus.log) progress.append(logBlock(item.run, runStatus, "update-log", "app", server.id));
      noteSeen(item.run, "app", server.id);
      section.append(progress);
    }
    return section;
  }

  function renderHerdr(server, item) {
    const herdr = item.check.herdr;
    const row = element("div", "update-herdr");
    const heading = element("div", "update-herdr-heading");
    heading.append(element("strong", "", "Herdr"));
    if (herdr?.available) heading.append(element("span", "update-badge", "Update available"));
    row.append(heading);
    const status = element("p", "update-status update-herdr-status");
    if (!herdr) {
      status.textContent = "Could not check Herdr.";
      status.dataset.error = "true";
      row.append(status);
      return row;
    }
    const channel = herdr.channel === "preview" ? " (preview)" : "";
    row.append(element("p", "update-versions update-herdr-versions",
      `Running ${herdr.current ?? "unknown"} · Latest ${herdr.latest ?? "unknown"}${channel}`));
    row.append(status);
    if (herdr.error) {
      status.textContent = herdrErrorText(herdr.error);
      status.dataset.error = "true";
    } else if (!herdr.available) {
      status.textContent = "Up to date.";
    } else if (herdr.blocked) {
      status.textContent = herdrBlockedText(herdr.blocked);
      status.dataset.error = "true";
    } else {
      status.textContent = "A new Herdr is ready to install.";
    }
    if (herdr.available && herdr.notes) {
      const notes = element("details", "update-herdr-notes");
      notes.append(element("summary", "", `What's new in Herdr ${herdr.latest}`));
      notes.append(element("p", "update-herdr-notes-text", herdr.notes));
      row.append(notes);
    }
    if (herdr.available && !herdr.blocked && !herdr.error) {
      const button = element("button", "secondary-button update-herdr-run", "Update Herdr");
      button.type = "button";
      button.disabled = busy(item);
      button.addEventListener("click", () => void runHerdr(server.id));
      const actions = element("div", "update-actions");
      actions.append(button);
      row.append(actions);
    }
    const run = item.herdrRun;
    if (run?.status) {
      const progress = element("div", "update-progress");
      const refused = run.status.state === "failed" && run.status.reason === "self_update_refused";
      const text = run.waiting ? "Waiting for an answer…"
        : refused ? HERDR_RUN_TEXT.refused : HERDR_RUN_TEXT[run.status.state] ?? "";
      const state = element("p", "update-run-state update-herdr-run-state", text);
      state.setAttribute("role", "status");
      if (run.status.state === "failed" && !run.waiting) state.dataset.error = "true";
      progress.append(state);
      if (run.status.state === "failed" && run.status.detail) {
        progress.append(element("p", "update-herdr-detail", run.status.detail));
      }
      if (run.status.log) progress.append(logBlock(run, run.status, "update-log update-herdr-log", "herdr", server.id));
      if (!run.waiting && needsIntegrations(run.status)) {
        progress.append(element("p", "update-herdr-integrations", INTEGRATIONS_NOTE));
      }
      noteSeen(run, "herdr", server.id);
      row.append(progress);
    }
    return row;
  }

  function render() {
    const log = list.querySelector(".update-log");
    const pinned = log ? log.scrollTop + log.clientHeight >= log.scrollHeight - 4 : true;
    list.replaceChildren(...servers().map(renderServer));
    // The log follows its end unless it was scrolled back.
    for (const node of list.querySelectorAll(".update-log")) if (pinned) node.scrollTop = node.scrollHeight;
  }

  function open() {
    feedback.textContent = "";
    feedback.dataset.error = "false";
    render();
    dialog.showModal();
  }

  checkButton.addEventListener("click", () => void refresh({ fresh: true }));

  // A finished run was on screen while the dialog was open: closing it puts
  // it away, so the next opening starts clean.
  dialog.addEventListener("close", () => {
    for (const [id, item] of entries) {
      if (isFinished(item.run?.status) && !item.run.tracking) {
        dismissRun(storage, id, "app", item.run.status.finishedAt);
        item.run = null;
      }
      if (isFinished(item.herdrRun?.status) && !item.herdrRun.tracking) {
        dismissRun(storage, id, "herdr", item.herdrRun.status.finishedAt);
        item.herdrRun = null;
      }
    }
  });

  // Shown in the menu once there is something to show: this PC can update
  // itself, or there are other PCs to look at.
  const visible = () => servers().length > 1 || entries.get("local")?.check?.supported === true;

  return { refresh, resume, open, render, run, runHerdr, visible, hasUpdate: () => anyUpdate([...entries.values()].map((item) => item.check)) };
}
