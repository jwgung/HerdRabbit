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

// The machines Plugins can manage: this PC, then each connected PC.
export function pluginMachines(servers = []) {
  const local = servers.find((server) => server.id === "local");
  return [
    { id: "local", name: local?.machine ? `This PC (${local.machine})` : "This PC" },
    ...servers.filter((server) => server.transport === "link").map((server) => ({ id: server.id, name: server.name || server.id })),
  ];
}
