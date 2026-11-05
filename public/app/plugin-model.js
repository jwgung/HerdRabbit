// Settings → Plugins without the page: what a typed source names, whether a
// ref may be sent, and how a plugin and a change read. The server checks the
// same rules again (src/herdr-plugins.mjs); these only let the page say so
// before anything is sent.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const REF_CHARS = /^[A-Za-z0-9._/+-]+$/u;
const MAX_SUBDIR_PARTS = 8;

const validName = (part) => NAME.test(part) && part !== "." && part !== "..";

// `owner/repo[/subdir]` from what was typed or pasted: a github.com address
// becomes its owner/repo (and folder), a trailing `/` or `.git` is dropped.
// What comes back is exactly what will be sent and what the confirm step
// shows; null when it does not name a GitHub repository.
export function parsePluginSource(typed) {
  let text = String(typed ?? "").trim();
  text = text.replace(/^(?:https:\/\/)?(?:www\.)?github\.com\//iu, "");
  const tree = text.match(/^([^/]+\/[^/]+)\/tree\/[^/]+(?:\/(.*))?$/u);
  if (tree) text = tree[2] ? `${tree[1]}/${tree[2]}` : tree[1];
  text = text.replace(/\/+$/u, "");
  const parts = text.split("/");
  if (parts.length === 2) parts[1] = parts[1].replace(/\.git$/iu, "");
  const [owner, repo, ...subdir] = parts;
  if (parts.length < 2 || parts.length > 2 + MAX_SUBDIR_PARTS || text.length > 300) return null;
  if (!OWNER.test(owner) || !validName(repo) || /\.git$/iu.test(repo) || !subdir.every(validName)) return null;
  return {
    owner, repo, subdir: subdir.length ? subdir.join("/") : null,
    spec: [owner, repo, ...subdir].join("/"),
    url: `https://github.com/${owner}/${repo}`,
  };
}

// A branch, tag or commit name the server will take; empty is none.
export function validPluginRef(typed) {
  const ref = String(typed ?? "").trim();
  if (ref === "") return true;
  return ref.length <= 200 && REF_CHARS.test(ref) && !ref.startsWith("-") && !ref.startsWith("/") &&
    !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock") && !ref.includes("..") &&
    !ref.includes("//") && !ref.split("/").some((part) => part.startsWith("."));
}

// Where a plugin came from: owner/repo[/folder]@ref, or how it is installed.
export function pluginSourceText(plugin) {
  const source = plugin?.source;
  if (source?.kind === "github") {
    const at = source.ref ?? (source.commit ? source.commit.slice(0, 7) : null);
    return `${[source.owner, source.repo, source.subdir].filter(Boolean).join("/")}${at ? `@${at}` : ""}`;
  }
  if (source?.kind === "local") return "Linked from a folder";
  return "Unknown source";
}

export function pluginSourceUrl(plugin) {
  const source = plugin?.source;
  return source?.kind === "github" ? `https://github.com/${source.owner}/${source.repo}` : null;
}

const VERBS = Object.freeze({
  install: ["Installing", "Installed", "install"],
  enable: ["Turning on", "Turned on", "turn on"],
  disable: ["Turning off", "Turned off", "turn off"],
  update: ["Updating", "Updated", "update"],
  uninstall: ["Uninstalling", "Uninstalled", "uninstall"],
  link: ["Linking", "Linked", "link"],
  unlink: ["Unlinking", "Unlinked", "unlink"],
});

// The page's status line for the change last started on a machine:
// { text, error, running }, or null when there has been none.
export function pluginOperationText(operation, plugins = []) {
  const verbs = VERBS[operation?.action];
  if (!verbs) return null;
  const named = (plugins ?? []).find((item) => item.id === operation.plugin)?.name;
  const what = named ?? (operation.action === "install" && operation.ref
    ? `${operation.plugin}@${operation.ref}` : operation.plugin);
  if (operation.state === "running") {
    const slow = operation.action === "install" || operation.action === "update" ? " This can take a few minutes." : "";
    return { text: `${verbs[0]} ${what}…${slow}`, error: false, running: true };
  }
  if (operation.state === "succeeded") return { text: `${verbs[1]} ${what}.`, error: false, running: false };
  return { text: `Couldn't ${verbs[2]} ${what}: ${operation.detail || "Herdr reported an error."}`, error: true, running: false };
}

// What Update all (Settings → Plugins, per machine) would update, in order:
// each plugin the server marks `updateAvailable` (and could update), then
// HerdRabbit last when `app` (appVersionText in app-update.js) says it can
// be -- its update restarts the server. Herdr's own update is the Herdr page's.
export function updateAllPlan(plugins = [], app = null) {
  return {
    plugins: (plugins ?? []).filter((plugin) => plugin.updateAvailable === true && plugin.updatable === true && !plugin.protected),
    app: app?.canUpdate === true,
  };
}

export function updateAllCount(plan) {
  return plan.plugins.length + (plan.app ? 1 : 0);
}

// The one question Update all asks: what, where, in which order. `appLine`
// is HerdRabbit's "1.4.30 → 1.4.31 available" and `appDetails` what its own
// update's confirm says it does.
export function updateAllConfirmText(machine, plan, { appLine = "", appDetails = "" } = {}) {
  const lines = plan.plugins.map((plugin) => `• ${plugin.name}`);
  if (plan.app) lines.push(`• HerdRabbit${appLine ? ` (${appLine.replace(/ available$/u, "")})` : ""}, last: it restarts`);
  return [
    `Update ${updateAllCount(plan) === 1 ? "this" : `these ${updateAllCount(plan)}`} on ${machine}, one at a time?`,
    ...lines,
    "",
    "Update all stops at the first update that fails.",
    ...(plan.plugins.length ? ["Herdr downloads and builds each plugin's new version, which runs its own code there."] : []),
    ...(plan.app && appDetails ? [appDetails] : []),
  ].join("\n");
}

// The status line once Update all ends: all done, or where it stopped and
// what was left. `failure` is what the failed update said.
export function updateAllResultText(done, left, failure = null) {
  if (!failure) return { text: `Updated ${done.length === 1 ? done[0] : `all ${done.length}`}.`, error: false };
  const rest = left.length ? ` Not updated: ${left.join(", ")}.` : "";
  const said = /[.!?…]$/u.test(failure) ? failure : `${failure}.`;
  return { text: `Update all stopped. ${said}${rest}`, error: true };
}

// The machines Plugins can manage: this PC, then each connected PC.
export function pluginMachines(servers = []) {
  const local = servers.find((server) => server.id === "local");
  return [
    { id: "local", name: local?.machine ? `This PC (${local.machine})` : "This PC" },
    ...servers.filter((server) => server.transport === "link").map((server) => ({ id: server.id, name: server.name || server.id })),
  ];
}

// Browse (Herdr's plugin marketplace). A listing's link, only when it is a
// GitHub repository, or a folder in one, as the server builds it.
const MARKET_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(?:\/tree\/HEAD(?:\/[A-Za-z0-9._-]{1,100}){1,8})?$/u;

export function marketplaceUrl(item) {
  return typeof item?.url === "string" && MARKET_URL.test(item.url) && !/\/\.\.?(?:\/|$)/u.test(item.url) ? item.url : null;
}

// Whether a listing is already on the machine: the same plugin id, or the
// same GitHub repository and folder.
export function marketplaceInstalled(item, plugins = []) {
  const where = (owner, repo, subdir) => [owner, repo, subdir ?? ""].join("/").toLowerCase();
  const listed = where(item?.owner, item?.repo, item?.subdir);
  return (plugins ?? []).some((plugin) => plugin.id === item?.id ||
    (plugin.source?.kind === "github" && where(plugin.source.owner, plugin.source.repo, plugin.source.subdir) === listed));
}

const AGES = [[365 * 86_400_000, "year"], [30 * 86_400_000, "month"], [7 * 86_400_000, "week"], [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];

// "3 days ago", "just now", or null for a time that cannot be read.
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso ?? "");
  if (Number.isNaN(then)) return null;
  const gone = Math.max(0, now - then);
  for (const [size, unit] of AGES) {
    const amount = Math.floor(gone / size);
    if (amount >= 1) return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

// A listing's second line: stars, last push, platforms, the Herdr it needs.
export function marketplaceDetails(item, now = Date.now()) {
  const parts = [`★ ${Number(item?.stars ?? 0).toLocaleString("en-US")}`];
  if (item?.starsThisWeek > 0) parts.push(`+${Number(item.starsThisWeek).toLocaleString("en-US")} this week`);
  const pushed = timeAgo(item?.pushedAt, now);
  if (pushed) parts.push(`updated ${pushed}`);
  if (Array.isArray(item?.platforms) && item.platforms.length) parts.push(item.platforms.join(", "));
  if (item?.minHerdrVersion) parts.push(`needs Herdr ${item.minHerdrVersion} or later`);
  return parts.join(" · ");
}

// The line above the listings: how many, and how old the list is.
export function marketplaceSummary(answer, query = "", now = Date.now()) {
  const total = Number(answer?.total ?? 0);
  if (total === 0) return query ? `No plugins in Herdr's marketplace match "${query}".` : "Herdr's marketplace lists no plugins.";
  const count = `${total.toLocaleString("en-US")} plugin${total === 1 ? "" : "s"}${query ? ` ${total === 1 ? "matches" : "match"} "${query}"` : ""}`;
  const listed = timeAgo(answer.generatedAt, now);
  const read = timeAgo(answer.fetchedAt, now);
  if (answer.stale) return `${count}. Herdr's marketplace could not be read just now; this list was read ${read ?? "earlier"}.`;
  return `${count}${listed ? `, listed by Herdr ${listed}` : ""}.`;
}

// The machine a pane of the page is on: its record's, else its id's
// `<server>!` part; this PC's otherwise.
function serverOf(record, id) {
  if (typeof record?.server_id === "string" && record.server_id) return record.server_id;
  const separator = id.indexOf("!");
  return separator > 0 ? id.slice(0, separator) : "local";
}

const workspaceName = (workspace) => (typeof workspace?.label === "string" && workspace.label ? workspace.label : workspace.workspace_id);

// The workspaces of `server` an action may run for or a pane open in: those
// with a pane. [{ workspaceId, workspace }] in the sidebar's order.
export function pluginWorkspaces(records, server) {
  const panes = records?.panes ?? [];
  return (records?.workspaces ?? [])
    .filter((item) => typeof item?.workspace_id === "string" && item.workspace_id && serverOf(item, item.workspace_id) === server)
    .filter((item) => panes.some((pane) => pane?.workspace_id === item.workspace_id))
    .map((item) => ({ workspaceId: item.workspace_id, workspace: workspaceName(item) }));
}

// A workspace's active pane: the focused one of its active tab, else that
// tab's first, else the workspace's first.
function activePane(records, workspace) {
  const panes = (records?.panes ?? []).filter((pane) => pane?.workspace_id === workspace.workspace_id && typeof pane.pane_id === "string");
  const inTab = panes.filter((pane) => pane.tab_id === workspace.active_tab_id);
  return inTab.find((pane) => pane.focused === true) ?? inTab[0] ?? panes[0] ?? null;
}

// Where a plugin's actions run and its panes open on `server`. Without
// `workspaceId`: the pane open on the page when it is on that machine. With
// it: that pane when it is in that workspace, else the workspace's active
// pane. { paneId, workspace, workspaceId, shown } or null; `shown` says the
// pane is the one on show.
export function pluginTarget(records, paneId, server, workspaceId = null) {
  const shown = typeof paneId === "string" && paneId !== ""
    ? (records?.panes ?? []).find((item) => item?.pane_id === paneId) ?? null
    : null;
  const shownHere = shown && serverOf(shown, paneId) === server ? shown : null;
  const wanted = workspaceId ?? shownHere?.workspace_id;
  if (!wanted) return null;
  const workspace = (records?.workspaces ?? []).find((item) => item?.workspace_id === wanted);
  if (workspaceId !== null && (!workspace || serverOf(workspace, workspace.workspace_id) !== server)) return null;
  const pane = shownHere?.workspace_id === wanted ? shownHere : workspace ? activePane(records, workspace) : null;
  if (!pane) return null;
  return {
    paneId: pane.pane_id,
    workspace: workspace ? workspaceName(workspace) : null,
    workspaceId: wanted,
    shown: pane === shownHere,
  };
}

// The lines above a plugin's actions and panes: where they run.
export function pluginTargetText(target, machine, enabled = true) {
  if (!enabled) return { actions: "The plugin is off. Turn it on to run its actions.", panes: "The plugin is off. Turn it on to open its panes." };
  const where = target?.workspace ? `in ${target.workspace}` : "in its workspace";
  if (target && !target.shown) {
    return {
      actions: `Runs for the active pane ${target.workspace ? `of ${target.workspace}` : "of its workspace"}.`,
      panes: `Opens as a new tab ${where}.`,
    };
  }
  return target
    ? { actions: `Runs for the pane you have open, ${where}.`, panes: `Opens as a new tab ${where}, beside the pane you have open.` }
    : {
      actions: `Runs where Herdr's own focus is on ${machine}: no pane of it is open here.`,
      panes: `Open a pane on ${machine} first: a plugin's pane opens as a new tab of that pane's workspace.`,
    };
}

const LOG_STATES = Object.freeze({ running: "Running", succeeded: "Succeeded", failed: "Failed" });

// A log's one line: what ran (the action's title, a hook's event), how it
// went and when.
export function pluginLogSummary(log, plugin = null, now = Date.now()) {
  const title = log?.action ? (plugin?.actions ?? []).find((item) => item.id === log.action)?.title ?? log.action : null;
  const what = title ?? (log?.event ? (log.event === "startup" ? "Startup hook" : `Event: ${log.event}`) : "Command");
  const state = LOG_STATES[log?.status] ?? "Unknown";
  const exit = log?.status === "failed" && Number.isInteger(log.exitCode) ? ` (exit ${log.exitCode})` : "";
  const when = timeAgo(log?.startedAt, now);
  return `${what} · ${state}${exit}${when ? ` · ${when}` : ""}`;
}
