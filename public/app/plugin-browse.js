import { createElement } from "./dom.js?v=1.4.45";
import {
  marketplaceDetails, marketplaceInstalled, marketplaceSummary, marketplaceUrl,
} from "./plugin-model.js?v=1.4.45";

const SEARCH_DELAY_MS = 300;
const PAGE = 50;

// Settings → Plugins → Browse: Herdr's plugin marketplace as the hub reads it
// (GET /api/plugins/marketplace, src/plugin-marketplace.mjs), searched,
// sorted and read a page at a time. Each listing says whether the machine
// chosen in Machine has it already; Install… opens the page's own install
// dialog with Source filled in, so it goes through the same confirm step.
// HerdRabbit is listed with no Install: it is this app, updated from its
// row in Installed.
export function createPluginBrowse({ api, installed, locked, install }) {
  const search = document.querySelector("#plugins-search");
  const sort = document.querySelector("#plugins-sort");
  const status = document.querySelector("#plugins-browse-status");
  const list = document.querySelector("#plugins-browse-list");
  const more = document.querySelector("#plugins-more");

  const state = {
    started: false, loading: false, items: [], total: 0, query: "", sort: "popular",
    generation: 0, timer: null,
  };

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.dataset.error = String(isError);
  }

  function row(item) {
    const entry = createElement("li", { className: "plugin-row market-row" });
    entry.dataset.spec = item.spec;
    const identity = createElement("div", { className: "plugin-identity" });
    const title = createElement("div", { className: "plugin-title" });
    title.append(createElement("strong", { text: item.name }));
    if (item.version) title.append(createElement("span", { className: "plugin-version", text: item.version }));
    identity.append(title);
    const url = marketplaceUrl(item);
    if (url) {
      const link = createElement("a", { className: "plugin-source", text: item.spec });
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      identity.append(link);
    } else {
      identity.append(createElement("small", { className: "plugin-source", text: item.spec }));
    }
    if (item.description) identity.append(createElement("small", { className: "plugin-description", text: item.description }));
    identity.append(createElement("small", { className: "market-details", text: marketplaceDetails(item) }));
    const actions = createElement("div", { className: "plugin-actions" });
    const { plugins, loaded } = installed();
    if (item.protected) {
      actions.append(createElement("span", { className: "plugin-badge", text: "This app" }));
    } else if (loaded && marketplaceInstalled(item, plugins)) {
      actions.append(createElement("span", { className: "plugin-badge", text: "Installed" }));
    } else {
      const button = createElement("button", { className: "secondary-button market-install", text: "Install…" });
      button.type = "button";
      button.setAttribute("aria-label", `Install ${item.name} (${item.spec})…`);
      button.disabled = locked();
      button.addEventListener("click", () => install(item.spec, button));
      actions.append(button);
    }
    entry.append(identity, actions);
    return entry;
  }

  // Listings again, with what is installed and whether a change runs now.
  function render() {
    if (!state.started) return;
    list.replaceChildren(...state.items.map(row));
    more.hidden = state.loading || state.items.length >= state.total;
    more.disabled = state.loading;
  }

  async function read({ append = false } = {}) {
    const generation = ++state.generation;
    clearTimeout(state.timer);
    // A search still waiting for its pause is the one read now.
    const typed = search.value.trim();
    if (typed !== state.query) {
      state.query = typed;
      append = false;
    }
    state.loading = true;
    if (!append) {
      state.items = [];
      state.total = 0;
    }
    setStatus(append ? "Reading more…" : "Reading Herdr's plugin marketplace…");
    render();
    const query = new URLSearchParams({ sort: state.sort, offset: String(append ? state.items.length : 0), limit: String(PAGE) });
    if (state.query) query.set("q", state.query);
    try {
      const answer = await api(`/api/plugins/marketplace?${query}`);
      if (generation !== state.generation) return;
      const items = Array.isArray(answer.items) ? answer.items : [];
      state.items = append ? [...state.items, ...items] : items;
      state.total = Number(answer.total) || 0;
      state.loading = false;
      setStatus(marketplaceSummary(answer, state.query), Boolean(answer.stale));
    } catch (error) {
      if (generation !== state.generation) return;
      state.loading = false;
      if (!append) state.items = [];
      setStatus(error.code === "marketplace_unavailable" && error.status === 502 ? error.message
        : `${error.message || "Herdr's plugin marketplace could not be read."} You can still install a plugin by its GitHub owner/repo with Install plugin….`, true);
    }
    render();
  }

  function searchSoon() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const query = search.value.trim();
      if (query === state.query) return;
      state.query = query;
      void read();
    }, SEARCH_DELAY_MS);
  }

  search.addEventListener("input", searchSoon);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void read();
  });
  sort.addEventListener("change", () => {
    state.sort = sort.value;
    void read();
  });
  more.addEventListener("click", () => void read({ append: true }));

  // Browse came into view: the first time it reads the first page.
  function show() {
    if (state.started) {
      render();
      return;
    }
    state.started = true;
    state.sort = sort.value;
    void read();
  }

  return { show, render };
}
