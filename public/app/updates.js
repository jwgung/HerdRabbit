import { createElement } from "./dom.js?v=1.4.32";
import {
  pluginMachines, pluginOperationText, updateAllConfirmText, updateAllCount, updateAllPlan, updateAllResultText,
} from "./plugin-model.js?v=1.4.32";
import {
  appVersionText, confirmDetails as appConfirmDetails, herdrBlockedText, herdrConfirmDetails, herdrErrorText, herdrRunSummary,
  herdrUpdateText, runSummary,
} from "../app-update.js?v=1.4.32";

const POLL_MS = 1_500;
const GIVE_UP_MS = 15 * 60_000;
const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

// Settings → Updates: per machine, what has an update -- HerdRabbit and Herdr
// from the Update window's panel (`appUpdates`, app-update.js), and, where
// Plugins shows (`pluginsShown`), each plugin the server marks
// `updateAvailable` -- each with its own Update, and Update all, which runs
// them one at a time: plugins, then Herdr, then HerdRabbit last (it restarts),
// stopping at the first failure. HerdRabbit's and Herdr's Update ask the
// Update window's questions and start its runs; a plugin's is the same
// request as Plugins' ⋯ → Update.
export function createUpdatesPage({ api, snapshotRecords, appUpdates, pluginsShown }) {
  const list = document.querySelector("#updates-list");
  const checkButton = document.querySelector("#updates-check");
  // Per machine: its plugins ({ plugins, operation, error }), what it is doing
  // ("all" or "plugin"), and the last word shown under it.
  const page = { visible: false, plugins: new Map(), busy: new Map(), said: new Map(), reads: new Map() };

  const machines = () => pluginMachines(snapshotRecords().servers);
  const machineName = (id) => machines().find((item) => item.id === id)?.name ?? "this machine";
  const pluginsOf = (id) => (pluginsShown() ? page.plugins.get(id)?.plugins ?? [] : []);
  const appLine = (id) => appVersionText(appUpdates.state(id).check, pluginsOf(id).find((item) => item.protected)?.version);
  const herdrCheck = (id) => {
    const check = appUpdates.state(id).check;
    return check?.supported === true ? check.herdr ?? null : null;
  };
  const plan = (id) => updateAllPlan(pluginsOf(id), appLine(id), herdrCheck(id));
  const locked = (id) => page.busy.has(id) || appUpdates.state(id).busy || page.plugins.get(id)?.operation?.state === "running";

  function row({ name, line = null, note = null, run = null, button = null, kind }) {
    const item = createElement("li", { className: "plugin-row updates-row" });
    item.dataset.update = kind;
    const identity = createElement("div", { className: "plugin-identity" });
    const title = createElement("div", { className: "plugin-title" });
    title.append(createElement("strong", { text: name }));
    identity.append(title);
    for (const [said, className] of [[line, "plugin-update-line"], [note, "plugin-update-note"], [run, "plugin-update-run"]]) {
      if (!said) continue;
      const node = createElement("small", { className, text: said.text });
      node.dataset.error = String(said.error === true);
      identity.append(node);
    }
    const actions = createElement("div", { className: "plugin-actions" });
    if (button) actions.append(button);
    item.append(identity, actions);
    return item;
  }

  function updateButton(id, onClick) {
    const button = createElement("button", { className: "secondary-button updates-run", text: "Update" });
    button.type = "button";
    button.disabled = locked(id);
    button.addEventListener("click", () => void onClick());
    return button;
  }

  // One machine: its rows, Update all, and the line under them.
  function machineSection({ id, name }) {
    const section = createElement("section", { className: "updates-machine settings-card" });
    section.dataset.serverId = id;
    section.append(createElement("strong", { className: "updates-machine-name", text: name }));
    const { check, error, run, herdrRun } = appUpdates.state(id);
    const rows = [];
    const todo = plan(id);

    for (const plugin of todo.plugins) {
      const item = row({
        kind: "plugin", name: plugin.name,
        line: { text: `${plugin.version ? `${plugin.version} · ` : ""}Update available` },
        button: updateButton(id, () => updateOne(id, plugin)),
      });
      item.dataset.plugin = plugin.id;
      rows.push(item);
    }

    const herdr = herdrCheck(id);
    const herdrRunning = herdrRunSummary(herdrRun);
    if (herdr?.available || herdrRun?.tracking) {
      rows.push(row({
        kind: "herdr", name: "Herdr",
        line: herdrUpdateText(herdr) ? { text: herdrUpdateText(herdr) } : null,
        note: herdr?.error ? { text: herdrErrorText(herdr.error), error: true }
          : herdr?.blocked ? { text: herdrBlockedText(herdr.blocked), error: true } : null,
        run: herdrRun?.tracking ? herdrRunning : null,
        button: todo.herdr && !herdrRun?.tracking ? updateButton(id, () => updateHerdr(id)) : null,
      }));
    }

    const app = appLine(id);
    // a run while it goes, and one that failed (until the Update window puts it away)
    const appRun = run?.tracking || run?.status?.state === "failed" ? runSummary(run, { local: id === "local" }) : null;
    if (check?.available || appRun) {
      rows.push(row({
        kind: "app", name: "HerdRabbit",
        line: app ? { text: app.text, error: app.error } : null,
        note: app?.note ? { text: app.note, error: true } : null,
        run: appRun,
        button: app?.canUpdate && !appRun?.running ? updateButton(id, () => updateApp(id)) : null,
      }));
    }

    const list = createElement("ul", { className: "plugin-rows updates-rows" });
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", `Updates on ${name}`);
    list.append(...rows);
    section.append(list);

    if (rows.length === 0) {
      const text = error ?? (!check ? "Not checked yet."
        : check.supported === false ? (id === "local" ? "This HerdRabbit cannot update itself from the page." : "Update it there (older version).")
          : "Everything is up to date.");
      section.append(createElement("p", { className: "settings-row-hint updates-empty", text }));
    }

    const count = updateAllCount(todo);
    if (count > 0 || page.busy.get(id) === "all") {
      const all = createElement("button", { className: "primary-button updates-all",
        text: page.busy.get(id) === "all" ? "Updating all…" : `Update all (${count})` });
      all.type = "button";
      all.disabled = locked(id);
      all.addEventListener("click", () => void updateAll(id));
      const actions = createElement("div", { className: "updates-actions" });
      actions.append(all);
      section.append(actions);
    }

    const said = page.said.get(id) ?? (pluginsShown() && page.plugins.get(id)?.error
      ? { text: `Plugins: ${page.plugins.get(id).error}`, error: true } : null);
    const status = createElement("p", { className: "settings-row-hint updates-status", text: said?.text ?? "" });
    status.setAttribute("role", "status");
    status.dataset.error = String(said?.error === true);
    section.append(status);
    return section;
  }

  function render() {
    if (!page.visible && page.busy.size === 0) return;
    list.replaceChildren(...machines().map(machineSection));
  }

  function adopt(id, answer) {
    page.plugins.set(id, { plugins: Array.isArray(answer?.plugins) ? answer.plugins : [], operation: answer?.operation ?? null, error: null });
  }

  // Each machine's plugins, read as the page comes into view and after a
  // change; a machine that cannot list them says why under it.
  async function loadPlugins(ids = machines().map((item) => item.id)) {
    if (!pluginsShown()) return;
    await Promise.all(ids.map(async (id) => {
      // only the latest read of a machine counts
      const read = (page.reads.get(id) ?? 0) + 1;
      page.reads.set(id, read);
      try {
        const answer = await api(`/api/plugins?server=${encodeURIComponent(id)}`);
        if (read === page.reads.get(id)) adopt(id, answer);
      } catch (error) {
        if (read === page.reads.get(id)) page.plugins.set(id, { plugins: [], operation: null, error: error.message });
      }
    }));
    render();
  }

  // One plugin's update, followed until it ends: { ok, text }.
  async function pluginUpdate(id, plugin) {
    let operation;
    try {
      const answer = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/update`, { method: "POST", body: { server: id } });
      adopt(id, answer);
      operation = answer.operation ?? null;
    } catch (error) {
      return { ok: false, text: `Couldn't update ${plugin.name}: ${error.message}` };
    }
    render();
    const started = Date.now();
    while (operation?.state === "running" && Date.now() - started < GIVE_UP_MS) {
      await sleep(POLL_MS);
      try {
        const answer = await api(`/api/plugins?server=${encodeURIComponent(id)}`);
        adopt(id, answer);
        operation = answer.operation ?? null;
      } catch { /* asked again on the next tick */ }
    }
    const said = pluginOperationText(operation, page.plugins.get(id)?.plugins);
    return { ok: operation?.state === "succeeded", text: said?.text ?? `Couldn't update ${plugin.name}.` };
  }

  // How a Herdr or HerdRabbit run ended, as Update all's failure: null when it succeeded.
  function herdrFailure(ended) {
    if (ended?.state === "succeeded") return null;
    if (ended?.startFailed) return `Couldn't update Herdr: ${ended.detail}`;
    if (!ended) return "Herdr's update did not start.";
    const said = herdrRunSummary({ status: ended })?.text || "The Herdr update failed.";
    return ended.detail ? `${said} ${ended.detail}` : said;
  }

  function appFailure(id, ended) {
    if (ended?.state === "succeeded") return null;
    if (ended?.startFailed) return `Couldn't update HerdRabbit: ${ended.detail}`;
    if (!ended) return "HerdRabbit's update did not start.";
    return runSummary({ status: ended }, { local: id === "local" })?.text ?? "The HerdRabbit update failed.";
  }

  async function hold(id, kind, work) {
    if (locked(id)) return;
    page.busy.set(id, kind);
    page.said.delete(id);
    render();
    try {
      await work();
    } finally {
      page.busy.delete(id);
      render();
      void loadPlugins([id]);
    }
  }

  function updateOne(id, plugin) {
    return hold(id, "plugin", async () => {
      page.said.set(id, { text: `Updating ${plugin.name}… This can take a few minutes.`, error: false });
      render();
      const result = await pluginUpdate(id, plugin);
      page.said.set(id, { text: result.text, error: !result.ok });
    });
  }

  // HerdRabbit's and Herdr's Update: the Update window's own, with its confirm.
  async function updateHerdr(id) {
    if (locked(id)) return;
    page.said.delete(id);
    const ended = await appUpdates.runHerdr(id);
    if (ended?.startFailed) page.said.set(id, { text: ended.detail, error: true });
    render();
  }

  async function updateApp(id) {
    if (locked(id)) return;
    page.said.delete(id);
    const ended = await appUpdates.run(id);
    if (ended?.startFailed) page.said.set(id, { text: ended.detail, error: true });
    render();
  }

  // Update all on one machine: one question first, for all of them, then
  // each update waited for before the next.
  function updateAll(id) {
    const todo = plan(id);
    if (locked(id) || updateAllCount(todo) === 0) return Promise.resolve();
    const app = appLine(id);
    const herdr = herdrCheck(id);
    const name = machineName(id);
    const question = updateAllConfirmText(name, todo, {
      appLine: app?.text, appDetails: todo.app ? appConfirmDetails(appUpdates.state(id).check) : "",
      herdrLine: herdrUpdateText(herdr) ?? "", herdrDetails: todo.herdr ? herdrConfirmDetails() : "",
    });
    if (!window.confirm(question)) return Promise.resolve();
    const names = [...todo.plugins.map((plugin) => plugin.name), ...(todo.herdr ? ["Herdr"] : []), ...(todo.app ? ["HerdRabbit"] : [])];
    const done = [];
    let failure = null;
    return hold(id, "all", async () => {
      try {
        for (const plugin of todo.plugins) {
          page.said.set(id, { text: `Update all: Updating ${plugin.name}…`, error: false });
          render();
          const result = await pluginUpdate(id, plugin);
          if (!result.ok) {
            failure = result.text;
            break;
          }
          done.push(plugin.name);
        }
        if (!failure && todo.herdr) {
          page.said.set(id, { text: "Update all: Updating Herdr…", error: false });
          render();
          failure = herdrFailure(await appUpdates.runHerdr(id, { confirmed: true }));
          if (!failure) done.push("Herdr");
        }
        if (!failure && todo.app) {
          page.said.set(id, { text: "Update all: Updating HerdRabbit…", error: false });
          render();
          failure = appFailure(id, await appUpdates.run(id, { confirmed: true }));
          if (!failure) done.push("HerdRabbit");
        }
      } finally {
        page.said.set(id, updateAllResultText(done, names.slice(done.length + (failure ? 1 : 0)), failure));
      }
    });
  }

  checkButton.addEventListener("click", () => {
    void appUpdates.refresh({ fresh: true });
    void loadPlugins();
  });

  // HerdRabbit's or Herdr's update moved on: the rows follow.
  appUpdates.subscribe(() => render());

  // Settings tells the page whether it is on screen; it reads each machine's
  // plugins as it comes into view.
  function sync({ visible }) {
    if (visible === page.visible) {
      if (visible) render();
      return;
    }
    page.visible = visible;
    if (!visible) return;
    render();
    for (const { id } of machines()) void appUpdates.follow(id);
    void loadPlugins();
  }

  return { sync };
}
