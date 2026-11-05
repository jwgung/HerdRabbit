// In-app update: the Update window (⚙ Settings → Herdr → Update…). Each PC -- this one and every PC
// connected with Connect PC -- is checked when the app opens and when Check is
// pressed, never on a timer, for a release newer than the version it runs. Update runs update.sh on that PC (the server
// starts it outside its own service), and this page follows the run: through
// the restart for this PC, after which it reloads into the new version.
// The run shows as steps (the server names them and the one it is at), with
// its log folded away under "Log".
// Each PC also has a Herdr row: the Herdr it runs against the newest on its
// channel, and Update Herdr, which runs `herdr update --handoff` there and is
// followed the same way, without a restart.
// Settings → Plugins drives the same panel for HerdRabbit's row and Update
// all, and Settings → Herdr for Herdr's row: state(), subscribe(), follow(),
// run() and appDetails() below, so every place starts and shows one update.
// Plugins also reads state() to wait while one runs.

export const BLOCKED_TEXT = {
  running: "An update is already running.",
  not_service: "HerdRabbit is not running as its systemd user service here, so it cannot update itself. Run update.sh on that PC.",
  wrong_origin: "This checkout's origin is not ultivis-iot/HerdRabbit or jwgung/HerdRabbit. Update it by hand.",
  not_main: "This checkout is not on the main branch.",
  local_changes: "This checkout has local changes. Commit or move them first.",
  diverged: "Local main has commits that are not in the latest release. Reconcile it by hand.",
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
  return [`Update ${name} to ${revisionText(check?.latest)}?`, "", confirmDetails(check)].join("\n");
}

// What an update does there, without the question: Update all asks once for
// several updates and lists this under its own.
export function confirmDetails(check) {
  if (check?.mode === "plugin") {
    return [
      "Herdr downloads and builds this release of the HerdRabbit plugin, then restarts HerdRabbit there. " +
        "Running sessions keep running; the page loses its connection for a moment while HerdRabbit restarts.",
      "If the download or build fails, the installed version keeps running.",
    ].join("\n");
  }
  return [
    "update.sh fetches this release, updates Herdr, installs dependencies, runs the checks and restarts HerdRabbit there. " +
      "Running sessions keep running; the page loses its connection for a moment while the service restarts.",
    "If a step fails, update.sh puts the previous version back.",
  ].join("\n");
}

export function herdrConfirmText(name, herdr) {
  return [
    `Update Herdr on ${name} from ${herdr?.current ?? "unknown"} to ${herdr?.latest ?? "the newest version"}?`,
    "",
    herdrConfirmDetails(),
  ].join("\n");
}

// What a Herdr update does, without the question: Update all lists it under its own.
export function herdrConfirmDetails() {
  return "herdr update --handoff downloads the new Herdr and hands the running panes over to it live: " +
    "agents and shells keep running. It can take a moment.";
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

// A plugin run has no update.sh and nothing is put back: Herdr installs the
// new version beside the old one, which keeps running until the restart.
export const PLUGIN_FAILED_TEXT = {
  update_failed: "Herdr could not update the plugin. The installed version keeps running; the log says why.",
  // runs from before the plugin's own reason
  script_failed: "Herdr could not update the plugin. The installed version keeps running; the log says why.",
  restart_failed: "The new version is installed, but HerdRabbit could not restart. Restart it with " +
    "herdr plugin action invoke herdrabbit.restart, or reopen Herdr from a shell where node is on PATH.",
  interrupted: "The update stopped before it finished. Press Check to see which version runs.",
  start_failed: "The update could not start.",
};

export function runFailedText(status) {
  if (status?.mode === "plugin") return PLUGIN_FAILED_TEXT[status.reason] ?? "The update failed; the log says why.";
  return RUN_TEXT.failed;
}

export const WAITING_TEXT = "Waiting for HerdRabbit to come back…";

// HerdRabbit's versions on one PC in a line, for its row in Settings → Plugins:
// { text, error, note, canUpdate }. `installed` is the version Herdr lists
// when the check does not name one. Null when the PC was not checked or
// cannot update itself from the page.
export function appVersionText(check, installed = null) {
  if (!check || check.supported !== true) return null;
  const current = check.current?.version ?? installed ?? revisionText(check.current);
  if (check.error) return { text: errorText(check.error), error: true, note: null, canUpdate: false };
  if (!check.available) return { text: `${current} · Up to date`, error: false, note: null, canUpdate: false };
  const latest = check.latest?.version ?? revisionText(check.latest);
  return {
    text: `${current} → ${latest} available`, error: false,
    note: check.blocked ? blockedText(check.blocked) : null, canUpdate: !check.blocked,
  };
}

// Herdr's versions on one PC in a line: "0.9.3 → 0.9.5 available", or null
// when there is nothing newer.
export function herdrUpdateText(herdr) {
  if (herdr?.available !== true) return null;
  return `${herdr.current ?? "unknown"} → ${herdr.latest ?? "unknown"} available`;
}

// A HerdRabbit run in a line, as the Update window heads it: its state, then
// the step it is at. { text, error, running }, or null without a run.
export function runSummary(run, { local = true } = {}) {
  const status = run?.status;
  if (!status) return null;
  const steps = stepStates(status, { local, waiting: run.waiting, reloading: run.reloading === true });
  const failed = status.state === "failed" && !run.waiting;
  const text = runStateText(status, run, steps, failed);
  const at = steps.findIndex((step) => step.state === "current" || step.state === "failed");
  const step = at === -1 || failed ? "" : ` Step ${at + 1} of ${steps.length}: ${steps[at].label}.`;
  return { text: `${text}${step}`.trim(), error: failed, running: run.tracking === true };
}

// A Herdr run in a line, as its row in the Update window says it.
export function herdrRunSummary(run) {
  const status = run?.status;
  if (!status) return null;
  const refused = status.state === "failed" && status.reason === "self_update_refused";
  const text = run.waiting ? "Waiting for an answer…" : refused ? HERDR_RUN_TEXT.refused : HERDR_RUN_TEXT[status.state] ?? "";
  return { text, error: status.state === "failed" && !run.waiting, running: run.tracking === true };
}

// The line at the head of a run: its failure, the reload it is about to do,
// the wait for the restart when there are no steps to say so, else its state.
function runStateText(status, run, steps, failed) {
  if (failed) return runFailedText(status);
  if (run.reloading) return "Updated. Reloading this page…";
  if (steps.length === 0 && run.waiting) return WAITING_TEXT;
  return RUN_TEXT[status.state] ?? "";
}

// Each step of a run as the page shows it: "done", "current", "failed" or
// "pending". The page's reload is left out for a connected PC (this page does
// not reload for it); it is current while this page is about to reload, and
// done once it has. A server that does not answer is taken to be restarting.
export function stepStates(status, { local = true, waiting = false, reloading = false } = {}) {
  const all = Array.isArray(status?.steps) ? status.steps : [];
  const steps = local ? all : all.filter((step) => step.id !== "reload");
  if (steps.length === 0) return [];
  const at = (id) => steps.findIndex((step) => step.id === id);
  let current;
  if (status.state === "succeeded") {
    current = reloading ? at("reload") : -1;
  } else if (status.state === "running" && waiting) {
    current = Math.max(at("restart"), at(status.phase));
  } else {
    current = at(status.phase);
    if (current === -1) current = status.state === "running" && status.phase === "reload" ? steps.length - 1 : 0;
  }
  const finished = status.state === "succeeded" && current === -1;
  const failed = status.state === "failed";
  return steps.map((step, index) => ({
    ...step,
    state: finished || index < current ? "done"
      : index === current ? (failed ? "failed" : "current") : "pending",
  }));
}

// m:ss (or h:mm:ss) since a moment, never negative.
export function elapsedText(since, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const STEP_WORDS = { done: "Done", current: "In progress", failed: "Failed", pending: "Not started" };
const STEP_MARKS = { done: "✓", failed: "✕", current: "", pending: "" };

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
  pollMs = 1_500, giveUpMs = 15 * 60_000, storage = defaultStorage(), reloadDelayMs = 800,
}) {
  // Per PC: { check, error, run, herdrRun }, a run being
  // { status, tracking, waiting }.
  const entries = new Map();
  let ticker = null;
  // Which run of this PC's server the page was loaded from.
  let baseline = null;
  let checking = false;
  // Settings → Plugins and Herdr, told whenever anything here changes.
  const listeners = new Set();

  const entry = (id) => {
    if (!entries.has(id)) entries.set(id, { check: null, error: null, run: null, herdrRun: null });
    return entries.get(id);
  };
  const query = (id, fresh = false) => `server=${encodeURIComponent(id)}${fresh ? "&fresh=1" : ""}`;

  function changed() {
    onChange(anyUpdate([...entries.values()].map((item) => item.check)));
    if (dialog.open) render();
    for (const listener of listeners) listener();
    // The time beside a step in progress moves on wherever it is shown.
    const following = [...entries.values()].some((item) => busy(item));
    if (following || dialog.open) ticker ??= window.setInterval(tick, 1_000);
    else if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
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
          entry("local").run = { status, tracking: false, waiting: false, resumed: true };
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

  const keep = (run) => ({ logOpen: run?.logOpen, since: run?.since });
  const busy = (item) => item.run?.tracking === true || item.herdrRun?.tracking === true;

  // Like run() below, for Herdr: answers how its run ended, or null when it
  // was not started.
  async function runHerdr(id, { confirmed = false } = {}) {
    const server = servers().find((item) => item.id === id);
    const item = entry(id);
    if (!server || !item.check?.herdr?.available || busy(item)) return null;
    if (!confirmed && !confirm(herdrConfirmText(server.name, item.check.herdr))) return null;
    feedback.textContent = "";
    let status;
    try {
      status = await api("/api/update/herdr/run", { method: "POST", body: { server: id } });
    } catch (error) {
      feedback.textContent = error.message || "Could not start the Herdr update.";
      feedback.dataset.error = "true";
      return { state: "failed", startFailed: true, detail: feedback.textContent };
    }
    return trackHerdr(id, status);
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
      item.herdrRun = { ...keep(item.herdrRun), status: next, tracking: next.state === "running", waiting: false };
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
    return item.herdrRun.status;
  }

  // Asks (unless the person already said yes, as Update all does), starts
  // the run and follows it. `path` is where it is started: /api/update/run,
  // or HerdRabbit's Update in Plugins (/api/plugins/herdrabbit/update), which
  // the server starts the same way. Answers how the run ended -- its last status, or
  // { state: "failed", startFailed: true, detail } when it did not start --
  // or null when it was not started (declined, nothing newer, already running).
  async function run(id, { confirmed = false, path = "/api/update/run" } = {}) {
    const server = servers().find((item) => item.id === id);
    const item = entry(id);
    if (!server || !item.check?.available || busy(item)) return null;
    if (!confirmed && !confirm(confirmText(server.name, item.check))) return null;
    feedback.textContent = "";
    let status;
    try {
      status = await api(path, { method: "POST", body: { server: id } });
    } catch (error) {
      feedback.textContent = error.message || "Could not start the update.";
      feedback.dataset.error = "true";
      return { state: "failed", startFailed: true, detail: feedback.textContent };
    }
    return track(id, status);
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
      // what the person opened, and when the run began, carry over
      item.run = { ...keep(item.run), status: next, tracking: next.state === "running", waiting: false };
      if (next.state === "running") {
        changed();
        continue;
      }
      if (next.state === "succeeded" && id === "local" &&
          (!baseline || next.version !== baseline.version || (next.boot && next.boot !== baseline.boot))) {
        // the last step, shown for a moment before the page goes
        item.run = { ...keep(item.run), status: next, tracking: true, waiting: false, reloading: true };
        changed();
        await sleep(reloadDelayMs);
        reload();
        return item.run.status;
      }
      if (next.state === "succeeded") await checkOne(id, true).catch(() => {});
      break;
    }
    item.run.tracking = false;
    item.run.waiting = false;
    changed();
    return item.run.status;
  }

  // A PC's runs started elsewhere (another page, or Settings on another device)
  // are followed here too, and a PC not checked yet is checked.
  async function follow(id) {
    const item = entry(id);
    if (!item.check && !item.error) await checkOne(id, false).catch(() => {});
    for (const [path, kind] of [["/api/update/run", "app"], ["/api/update/herdr/run", "herdr"]]) {
      try {
        const status = await api(`${path}?${query(id)}`);
        if (status.supported === false || status.state !== "running" || busy(item)) continue;
        if (kind === "app") void track(id, status);
        else void trackHerdr(id, status);
      } catch { /* looked at again on the next follow */ }
    }
    changed();
  }

  // What one PC's entry says now, read-only: its check (or why it could not
  // be checked), its runs, and whether one is being followed.
  function state(id) {
    const item = entries.get(id);
    if (!item) return { check: null, error: null, run: null, herdrRun: null, busy: false };
    return { check: item.check, error: item.error, run: item.run, herdrRun: item.herdrRun, busy: busy(item) };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // A running log is shown as it comes; a finished one is folded away behind
  // "Log" unless the run failed, where it explains why. With steps to show,
  // the log is folded away while it runs too.
  function logBlock(run, status, className, kind, serverId, { folded = false, seen = dialog.open } = {}) {
    const pre = element("pre", className, status.log);
    if (!folded && (status.state === "running" || run.waiting)) return pre;
    // seen where it is shown: it will not come back on a later opening
    if (seen && isFinished(status)) dismissRun(storage, serverId, kind, status.finishedAt);
    const details = element("details", "update-log-fold");
    details.open = status.state === "failed" || run.logOpen === true;
    details.append(element("summary", "", "Log"), pre);
    details.addEventListener("toggle", () => { run.logOpen = details.open; });
    return details;
  }

  function noteSeen(run, kind, serverId) {
    if (dialog.open && isFinished(run?.status)) dismissRun(storage, serverId, kind, run.status.finishedAt);
  }

  // The Update window is Herdr's: one block per PC, its Herdr versions, what
  // is new, Update Herdr and its run. HerdRabbit's own update is its row in
  // Settings → Plugins, as a plugin's is, with appDetails below for its notes
  // and run.
  function renderServer(server) {
    const item = entry(server.id);
    const section = element("section", "update-server");
    section.dataset.serverId = server.id;
    const heading = element("div", "update-server-heading");
    heading.append(element("strong", "", server.name));
    section.append(heading);
    const check = item.check;
    if (check?.supported && "herdr" in check) {
      section.append(renderHerdr(server, item));
      return section;
    }
    const status = element("p", "update-status");
    status.textContent = item.error ?? (!check ? "Not checked yet."
      : server.id === "local" ? "Herdr cannot be updated from this page here." : "Update it there (older version).");
    if (item.error) status.dataset.error = "true";
    section.append(status);
    return section;
  }

  // What Settings shows under a PC's HerdRabbit row: what changed
  // in the new version (folded away), and its run, step by step with the
  // time taken and the log. Null when there is neither. `onScreen` says the
  // row is in view, so a finished run seen there is not shown again later.
  function appDetails(serverId, { onScreen = false } = {}) {
    const item = entries.get(serverId);
    if (!item) return null;
    const check = item.check;
    const box = element("div", "update-app");
    // A run while it goes, one that failed, and the one this page reloaded after.
    const run = item.run?.status && (item.run.tracking || item.run.status.state === "failed" || item.run.resumed) ? item.run : null;
    if (check?.supported && check.available && !run && Array.isArray(check.notes) && check.notes.length > 0) {
      const fold = element("details", "update-notes-fold");
      fold.append(element("summary", "", "What changed"));
      const notes = element("ul", "update-notes");
      notes.setAttribute("aria-label", "What changed");
      for (const note of check.notes) notes.append(element("li", "", note));
      fold.append(notes);
      box.append(fold);
    }
    const runStatus = run?.status;
    if (run) {
      const progress = element("div", "update-progress");
      const local = serverId === "local";
      const steps = stepStates(runStatus, { local, waiting: run.waiting, reloading: run.reloading === true });
      const failed = runStatus.state === "failed" && !run.waiting;
      const text = runStateText(runStatus, run, steps, failed);
      const head = element("div", "update-run-head");
      const state = element("p", "update-run-state", text);
      state.setAttribute("role", "status");
      if (failed) state.dataset.error = "true";
      head.append(state);
      const position = steps.findIndex((step) => step.state === "current" || step.state === "failed");
      if (position !== -1) head.append(element("p", "update-step-count", `Step ${position + 1} of ${steps.length}`));
      progress.append(head);
      if (steps.length > 0) progress.append(stepList(steps, runStatus, run));
      if (failed && runStatus.detail) progress.append(element("p", "update-detail", runStatus.detail));
      // A run that ended well but could not tell whether its restart ran
      // says so quietly (while the page waits for the restart, too); the
      // page's own wait for the new version decides.
      if (runStatus.state !== "failed" && runStatus.detail) progress.append(element("p", "update-run-note", runStatus.detail));
      if (runStatus.log) {
        progress.append(logBlock(run, runStatus, "update-log", "app", serverId, { folded: steps.length > 0, seen: onScreen }));
      }
      if (onScreen && isFinished(runStatus)) dismissRun(storage, serverId, "app", runStatus.finishedAt);
      box.append(progress);
    }
    return box.childElementCount > 0 ? box : null;
  }

  // A finished HerdRabbit run seen in Settings goes once its page is left.
  function putAwayApp() {
    for (const [id, item] of entries) {
      if (isFinished(item.run?.status) && !item.run.tracking) {
        dismissRun(storage, id, "app", item.run.status.finishedAt);
        item.run = null;
      }
    }
  }

  // When the run began, for the time shown beside the step in progress; a
  // run whose start is unknown counts from when this page first saw it.
  function runSince(run) {
    const started = Date.parse(run.status?.startedAt ?? "");
    run.since ??= Number.isFinite(started) ? Math.min(started, Date.now()) : Date.now();
    return run.since;
  }

  function elapsedNode(run) {
    const since = runSince(run);
    const node = element("span", "update-elapsed", elapsedText(since));
    node.dataset.since = String(since);
    return node;
  }

  function stepList(steps, status, run) {
    const list = element("ol", "update-steps");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Update steps");
    for (const step of steps) {
      const row = element("li", "update-step");
      row.dataset.state = step.state;
      row.dataset.step = step.id;
      if (step.state === "current" || step.state === "failed") row.setAttribute("aria-current", "step");
      const mark = element("span", "update-step-mark", STEP_MARKS[step.state]);
      mark.setAttribute("aria-hidden", "true");
      const label = element("span", "update-step-label");
      label.append(element("span", "visually-hidden", `${STEP_WORDS[step.state]}: `), step.label);
      row.append(mark, label);
      if (step.state === "current" && step.id !== "reload") {
        row.append(elapsedNode(run));
        if (run.waiting && step.id === "restart") row.append(element("span", "update-step-note", WAITING_TEXT));
      }
      list.append(row);
    }
    return list;
  }

  // The time beside a step in progress moves on by itself between answers.
  function tick() {
    for (const node of document.querySelectorAll(".update-elapsed[data-since]")) {
      node.textContent = elapsedText(Number(node.dataset.since));
    }
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
      if (run.status.state === "running") {
        // still indeterminate, with how long it has been going
        const head = element("div", "update-run-head update-herdr-run-head");
        const mark = element("span", "update-step-mark update-herdr-spinner");
        mark.setAttribute("aria-hidden", "true");
        head.append(mark, state, elapsedNode(run));
        progress.append(head);
      } else {
        progress.append(state);
      }
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
    ticker ??= window.setInterval(tick, 1_000);
  }

  checkButton.addEventListener("click", () => void refresh({ fresh: true }));

  // A finished run was on screen while the dialog was open: closing it puts
  // it away, so the next opening starts clean.
  dialog.addEventListener("close", () => {
    if (ticker !== null && ![...entries.values()].some((item) => busy(item))) {
      window.clearInterval(ticker);
      ticker = null;
    }
    for (const [id, item] of entries) {
      if (isFinished(item.herdrRun?.status) && !item.herdrRun.tracking) {
        dismissRun(storage, id, "herdr", item.herdrRun.status.finishedAt);
        item.herdrRun = null;
      }
    }
  });

  // Shown in the menu once there is something to show: this PC can update
  // itself, or there are other PCs to look at.
  const visible = () => servers().length > 1 || entries.get("local")?.check?.supported === true;

  return {
    refresh, resume, open, render, run, runHerdr, visible, follow, state, subscribe, appDetails, putAwayApp,
    hasUpdate: () => anyUpdate([...entries.values()].map((item) => item.check)),
    // Whether some PC has a newer Herdr: what the Update window is for.
    hasHerdrUpdate: () => [...entries.values()].some((item) => item.check?.supported === true && item.check.herdr?.available === true),
  };
}
