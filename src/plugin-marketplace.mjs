import { HttpError } from "./http-basics.mjs";
import { PLUGIN_ID } from "./config.mjs";
import { cleanText, cleanTime, isHerdRabbitPlugin, validatePluginRef, validatePluginSource } from "./herdr-plugins.mjs";

// Herdr's plugin marketplace (herdr.dev/plugins) for Settings → Plugins →
// Browse. The list is the index that page itself reads: public GitHub
// repositories tagged `herdr-plugin`, each with the plugin manifests found in
// it. It is not a documented API and nobody reviews what is in it, so this
// reads it with a timeout and a size cap, keeps only fields that pass the
// same rules an install does, and the page says the listings are unreviewed.
// It is the same for every machine, so the hub reads it once for all.

export const MARKETPLACE_URL = "https://assets.herdr.dev/plugins/index.json";
const SCHEMA_VERSION = 1;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
// Kept this long, then read again; a failed read is not retried sooner than
// RETRY_MS, and meanwhile the copy already read (if any) is served.
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const MAX_REPOSITORIES = 10_000;
const MAX_MANIFESTS = 20;
const MAX_ITEMS = 10_000;
const MAX_PLATFORMS = 8;
const PLATFORM = /^[a-z0-9_-]{1,20}$/u;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,30})?$/u;
const MANIFEST = "herdr-plugin.toml";
// The commit a repository's default branch was at when Herdr read it.
const HEAD_COMMIT = /^[0-9a-f]{40}$/u;
// How long the plugin list waits for an index not read yet; after that it
// answers without "Update available" and the read goes on for the next look.
const UPDATE_WAIT_MS = 5_000;

// The page's query: words to look for, an order, and a page of the list.
// The orders are Herdr's own on herdr.dev/plugins; `stars` and `updated`
// are other names for two of them.
export const MARKETPLACE_SORTS = Object.freeze(["popular", "trending", "recent", "newest", "name"]);
const SORT_ALIASES = new Map([["stars", "popular"], ["updated", "recent"]]);
const MAX_QUERY = 100;
export const MARKETPLACE_PAGE = 50;
const MAX_PAGE = 100;
const MAX_OFFSET = MAX_ITEMS;
// Herdr's "Trending" counts a plugin only from this many new stars a week.
const TRENDING_MIN_GAIN = 10;

const unavailable = (detail) => new HttpError(502, "marketplace_unavailable",
  `Herdr's plugin marketplace could not be read (${detail}). You can still install a plugin by its GitHub owner/repo with Install plugin….`);

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function platformsOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && PLATFORM.test(item)))].slice(0, MAX_PLATFORMS);
}

// owner/repo[/folder] for the manifest at `path` in a repository: the folder
// the manifest is in. Null unless an install would take it as it is.
function specOf(owner, repo, path) {
  if (typeof path !== "string" || path.length > 300) return null;
  if (path !== MANIFEST && !path.endsWith(`/${MANIFEST}`)) return null;
  const folder = path.slice(0, -MANIFEST.length).replace(/\/$/u, "");
  try {
    return validatePluginSource(folder ? `${owner}/${repo}/${folder}` : `${owner}/${repo}`);
  } catch {
    return null;
  }
}

// What "Update available" needs from a repository entry: the commit its
// default branch is at, the branch's name when the index gives one (it does
// not yet), and which plugin ids are in which folder.
function repositoryHead(raw, entries) {
  const headCommit = typeof raw.headCommit === "string" && HEAD_COMMIT.test(raw.headCommit) ? raw.headCommit : null;
  if (!headCommit || entries.length === 0) return null;
  let defaultBranch = null;
  try { defaultBranch = validatePluginRef(raw.defaultBranch ?? raw.default_branch ?? null); } catch { defaultBranch = null; }
  return { headCommit, defaultBranch, manifests: entries.map(({ item }) => ({ id: item.id, subdir: item.subdir })) };
}

// Every plugin a repository entry names, as the page shows it. A repository
// whose owner or name GitHub would not take is left out whole.
function cleanRepository(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.manifests)) return [];
  const owner = typeof raw.owner === "string" ? raw.owner : null;
  const repo = typeof raw.name === "string" ? raw.name : null;
  if (!owner || !repo || !specOf(owner, repo, MANIFEST)) return [];
  const repoDescription = cleanText(raw.description, 300);
  const stars = count(raw.stars);
  const starsThisWeek = Number.isSafeInteger(raw.starsDelta7d) ? Math.max(0, Math.min(raw.starsDelta7d, stars)) : 0;
  const pushedAt = cleanTime(raw.pushedAt);
  const listedAt = cleanTime(raw.firstSeenAt) ?? cleanTime(raw.createdAt);
  const extra = [cleanText(raw.language, 40), ...(Array.isArray(raw.topics) ? raw.topics.slice(0, 30).map((topic) => cleanText(topic, 50)) : [])];
  return raw.manifests.slice(0, MAX_MANIFESTS).flatMap((manifest) => {
    const source = specOf(owner, repo, manifest?.path);
    const id = manifest?.id;
    if (!source || typeof id !== "string" || !PLUGIN_ID.test(id)) return [];
    const version = typeof manifest.version === "string" && VERSION.test(manifest.version) ? manifest.version : null;
    const minHerdrVersion = typeof manifest.minHerdrVersion === "string" && VERSION.test(manifest.minHerdrVersion)
      ? manifest.minHerdrVersion : null;
    const name = cleanText(manifest.name, 100) ?? id;
    const description = cleanText(manifest.description, 300) ?? repoDescription;
    const url = source.subdir
      ? `https://github.com/${owner}/${repo}/tree/HEAD/${source.subdir}`
      : `https://github.com/${owner}/${repo}`;
    const item = {
      owner, repo, subdir: source.subdir, spec: source.spec, name, id, version, description,
      stars, starsThisWeek, pushedAt, listedAt, platforms: platformsOf(manifest.platforms), minHerdrVersion, url,
      protected: isHerdRabbitPlugin(id, { kind: "github", owner, repo }),
    };
    const words = [item.spec, name, id, description, repoDescription, ...extra].filter(Boolean).join(" ").toLowerCase();
    return [{ item, words }];
  });
}

// What a read of the index keeps: when Herdr made it, and each plugin once.
export function cleanMarketplace(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== SCHEMA_VERSION) {
    throw unavailable(`it is in a form this HerdRabbit does not know: schema ${cleanText(String(raw?.schemaVersion ?? "none"), 20)}`);
  }
  if (!Array.isArray(raw.plugins)) throw unavailable("it has no plugin list");
  const seen = new Set();
  const entries = [];
  const heads = new Map();
  const repositories = new Set();
  for (const repository of raw.plugins.slice(0, MAX_REPOSITORIES)) {
    const listed = cleanRepository(repository);
    for (const entry of listed) {
      const key = entry.item.spec.toLowerCase();
      if (seen.has(key) || entries.length >= MAX_ITEMS) continue;
      seen.add(key);
      entries.push(entry);
    }
    // A repository listed twice is taken as it is listed first, as its plugins are.
    const key = listed.length ? `${listed[0].item.owner}/${listed[0].item.repo}`.toLowerCase() : null;
    if (!key || repositories.has(key)) continue;
    repositories.add(key);
    const head = repositoryHead(repository, listed);
    if (head) heads.set(key, head);
  }
  return { generatedAt: cleanTime(raw.generatedAt), entries, heads };
}

// Whether an installed plugin (as cleanPluginState leaves it) is behind its
// repository in the index: true or false, or null when that cannot be told.
// Only a plugin installed from GitHub that follows the default branch is
// compared: no ref asked for, or the default branch by name when the index
// gives it. A pinned branch, tag or commit, a linked plugin, HerdRabbit
// (its own update, from its row in Plugins) and a plugin the index does not list are null.
export function pluginUpdateAvailable(plugin, heads) {
  const source = plugin?.source;
  if (!heads || plugin?.protected || source?.kind !== "github" || !source.commit) return null;
  const head = heads.get(`${source.owner}/${source.repo}`.toLowerCase());
  if (!head) return null;
  if (source.ref && source.ref !== head.defaultBranch) return null;
  const subdir = source.subdir ?? null;
  const listed = head.manifests.some((manifest) => manifest.id === plugin.id) ||
    head.manifests.some((manifest) => (manifest.subdir ?? null) === subdir);
  if (!listed) return null;
  return !head.headCommit.startsWith(source.commit.toLowerCase());
}

const time = (value) => (value ? Date.parse(value) : 0);
// One collator for every comparison: localeCompare with options builds one
// each time, which on the whole list takes half a second.
const collator = new Intl.Collator("en", { sensitivity: "base" });
const byName = (a, b) => collator.compare(a.name, b.name) || collator.compare(a.spec, b.spec);
const trendingScore = (item) => (item.starsThisWeek < TRENDING_MIN_GAIN ? -1
  : item.starsThisWeek / Math.max(item.stars - item.starsThisWeek, 1));
const ORDERS = {
  popular: (a, b) => b.stars - a.stars || time(b.pushedAt) - time(a.pushedAt) || byName(a, b),
  trending: (a, b) => trendingScore(b) - trendingScore(a) || b.starsThisWeek - a.starsThisWeek || b.stars - a.stars || byName(a, b),
  recent: (a, b) => time(b.pushedAt) - time(a.pushedAt) || byName(a, b),
  newest: (a, b) => time(b.listedAt) - time(a.listedAt) || byName(a, b),
  name: byName,
};

function wholeNumber(value, fallback, max, name) {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,6}$/u.test(value) || Number(value) > max) {
    throw new HttpError(400, "invalid_input", `${name} must be a whole number up to ${max}.`);
  }
  return Number(value);
}

// The query from the URL; anything out of bounds is refused, not trimmed.
export function marketplaceQuery(params) {
  const q = (params.get("q") ?? "").trim();
  if (q.length > MAX_QUERY) throw new HttpError(400, "invalid_input", `Search is at most ${MAX_QUERY} characters.`);
  const asked = params.get("sort") || "popular";
  const sort = SORT_ALIASES.get(asked) ?? asked;
  if (!MARKETPLACE_SORTS.includes(sort)) {
    throw new HttpError(400, "invalid_input", `Sort is one of ${MARKETPLACE_SORTS.join(", ")}.`);
  }
  const limit = wholeNumber(params.get("limit"), MARKETPLACE_PAGE, MAX_PAGE, "limit");
  if (limit === 0) throw new HttpError(400, "invalid_input", `limit must be a whole number up to ${MAX_PAGE}.`);
  return { q: q.toLowerCase(), sort, offset: wholeNumber(params.get("offset"), 0, MAX_OFFSET, "offset"), limit };
}

export class PluginMarketplace {
  #copy = null;
  #reading = null;
  #failure = null;
  #orders = new Map();

  // `fetch` is the global one; tests stand in for the network with it.
  constructor({
    fetch = globalThis.fetch, url = MARKETPLACE_URL, now = () => Date.now(),
    timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, freshMs = FRESH_MS, retryMs = RETRY_MS,
  } = {}) {
    Object.assign(this, { fetch, url, now, timeoutMs, maxBytes, freshMs, retryMs });
  }

  // The list as last read: fresh, read again, or (when reading again fails)
  // the copy already read, marked stale. With no copy at all, the error.
  async catalog() {
    const now = this.now();
    if (this.#copy && now - this.#copy.fetchedAt < this.freshMs) return this.#view(false);
    if (this.#failure && now - this.#failure.at < this.retryMs) {
      if (this.#copy) return this.#view(true);
      throw this.#failure.error;
    }
    // One read at a time: every caller meanwhile waits for the same one.
    this.#reading ??= this.#read().finally(() => { this.#reading = null; });
    try {
      await this.#reading;
      return this.#view(false);
    } catch (error) {
      if (this.#copy) return this.#view(true);
      throw error;
    }
  }

  // One page of the list, for GET /api/plugins/marketplace.
  async page({ q = "", sort = "popular", offset = 0, limit = MARKETPLACE_PAGE } = {}) {
    const catalog = await this.catalog();
    const terms = q.split(/\s+/u).filter(Boolean);
    const ordered = this.#ordered(sort);
    const found = terms.length ? ordered.filter((entry) => terms.every((term) => entry.words.includes(term))) : ordered;
    return {
      generatedAt: catalog.generatedAt,
      fetchedAt: catalog.fetchedAt,
      total: found.length,
      offset,
      limit,
      sort,
      items: found.slice(offset, offset + limit).map((entry) => entry.item),
      ...(catalog.stale ? { stale: true } : {}),
    };
  }

  // The plugins of a list, each with `updateAvailable` (pluginUpdateAvailable).
  // Never fails: an index that cannot be read, is only an old copy, or takes
  // longer than `waitMs` to read leaves every plugin at null.
  async updatesFor(plugins, { waitMs = UPDATE_WAIT_MS } = {}) {
    let timer;
    const reading = this.catalog().then((view) => !view.stale, () => false);
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); });
    const fresh = await Promise.race([reading, late]).finally(() => clearTimeout(timer));
    const heads = fresh ? this.#copy?.heads ?? null : null;
    return plugins.map((plugin) => ({ ...plugin, updateAvailable: pluginUpdateAvailable(plugin, heads) }));
  }

  #view(stale) {
    return { generatedAt: this.#copy.generatedAt, fetchedAt: new Date(this.#copy.fetchedAt).toISOString(), stale };
  }

  #ordered(sort) {
    let ordered = this.#orders.get(sort);
    if (!ordered) {
      const order = Object.hasOwn(ORDERS, sort) ? ORDERS[sort] : ORDERS.popular;
      ordered = [...this.#copy.entries].sort((a, b) => order(a.item, b.item));
      this.#orders.set(sort, ordered);
    }
    return ordered;
  }

  async #read() {
    try {
      const { generatedAt, entries, heads } = cleanMarketplace(await this.#download());
      this.#copy = { generatedAt, entries, heads, fetchedAt: this.now() };
      this.#orders = new Map();
      this.#failure = null;
    } catch (error) {
      const failure = error instanceof HttpError ? error : unavailable("it could not be read");
      this.#failure = { at: this.now(), error: failure };
      throw failure;
    }
  }

  // The index, parsed: within the timeout (headers and body both), and no
  // more than maxBytes of it, counted as it arrives.
  async #download() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable("it took too long to answer"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.#fetchJson(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async #fetchJson(signal) {
    let response;
    try {
      // Only this address: a redirect elsewhere is not followed.
      response = await this.fetch(this.url, { signal, redirect: "error", headers: { Accept: "application/json" } });
    } catch {
      throw unavailable("it could not be reached");
    }
    if (!response.ok) throw unavailable(`it answered HTTP ${Number(response.status) || "error"}`);
    const tooLarge = () => unavailable(`it is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    if (Number(response.headers?.get?.("content-length")) > this.maxBytes) throw tooLarge();
    const chunks = [];
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof HttpError ? error : unavailable("its answer broke off");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw unavailable("its answer is not JSON");
    }
  }
}
