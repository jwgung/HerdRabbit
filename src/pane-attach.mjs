// Claude Code 2.1.3xx can run a session in its background daemon and leave the
// pane only the attach client (`claude attach <short id>`), which herdr does
// not recognise as an agent. This names such a pane as Claude on the job's
// session, in the snapshot itself, so the page treats it like any Claude pane.
import { basename, join } from "node:path";
import { JOB_SHORT_ID, claudeProjectDir, readTail } from "./conversation/claude.mjs";
import { defaultClaudeConfigDir, localTranscriptStore, readBackgroundJob } from "./conversation/stores.mjs";
import { paneAgentName, paneForegroundProcesses } from "./pane-agent.mjs";

export const ATTACH_SOURCE = "herdrabbit:attach";
// How long what a pane's process is stays believed before it is looked at
// again (in the background: a snapshot never waits on the second look).
const PROCESS_TTL_MS = 10_000;
// How long the first look at a pane may hold a snapshot.
const FIRST_LOOK_MS = 1_500;
const MAX_CACHED_PANES = 512;
// herdr's own agent states; a job state outside them leaves the status alone.
const STATUSES = new Set(["working", "idle", "blocked", "done"]);
// The job writes its state when a turn ends, not when the user answers it: a
// "blocked" or "done" can stand for minutes while the next turn runs. Such a
// state is believed until the transcript holds a turn entry written after it.
const SETTLED_STATES = new Set(["blocked", "done"]);
// How much of the transcript's end is looked at for that entry.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const VERSIONED_CLAUDE = /\/claude\/versions\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

// The job's short id when this process is a Claude attach client, else null.
export function attachedJobShort(processInfo) {
  const argv = Array.isArray(processInfo?.argv) ? processInfo.argv : [];
  const [exe, verb, short] = argv;
  if (typeof exe !== "string" || verb !== "attach" || typeof short !== "string" || !JOB_SHORT_ID.test(short)) return null;
  return basename(exe) === "claude" || VERSIONED_CLAUDE.test(exe) ? short : null;
}

// Whether `text` (a transcript's tail) has a user or assistant entry on the
// main thread stamped after `since` (ms): the agent went on past the state it
// last wrote. A tool waiting on permission writes nothing more, so during that
// wait the "blocked" stands.
export function wentOnSince(text, since) {
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if ((entry?.type !== "user" && entry?.type !== "assistant") || entry.isSidechain === true) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) return at > since;
  }
  return false;
}

async function jobState(configDir, short, wentOn) {
  try {
    const job = await readBackgroundJob(configDir, short);
    if (!job) return null;
    let status = STATUSES.has(job.state) ? job.state : null;
    const since = Date.parse(job.updatedAt ?? "");
    if (SETTLED_STATES.has(status) && job.cwd && Number.isFinite(since)) {
      const path = join(configDir, "projects", claudeProjectDir(job.cwd), `${job.session}.jsonl`);
      if (await wentOn(path, since)) status = "working";
    }
    return { session: job.session, status };
  } catch {
    return null;
  }
}

export class AttachedClaudePanes {
  #cache = new Map();
  #transcripts = new Map();

  constructor({ configDir = defaultClaudeConfigDir(), now = () => Date.now() } = {}) {
    this.configDir = configDir;
    this.store = localTranscriptStore({ configDir });
    this.now = now;
  }

  // Names the agent-less panes of `snapshot` that run an attach client, in place.
  async enrich(snapshot, herdr) {
    const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
    const candidates = panes.filter((pane) => pane && !paneAgentName(pane) && typeof pane.pane_id === "string");
    this.#forget(candidates, herdr);
    const shorts = await Promise.all(candidates.map((pane) => this.#short(herdr, pane)));
    await Promise.all(candidates.map(async (pane, index) => {
      if (!shorts[index]) return;
      const job = await jobState(this.configDir, shorts[index], (path, since) => this.#wentOn(path, since));
      if (!job) return;
      pane.agent = "claude";
      pane.agent_session = { agent: "claude", kind: "id", source: ATTACH_SOURCE, value: job.session };
      if (job.status && (!pane.agent_status || pane.agent_status === "unknown")) pane.agent_status = job.status;
    }));
    return snapshot;
  }

  // wentOnSince over the transcript's tail, read again only when the
  // transcript or the state changed
  async #wentOn(path, since) {
    try {
      const info = await this.store.stat(path);
      if (!info) return false;
      const key = `${info.identity}:${info.size}:${info.mtimeMs}:${since}`;
      const known = this.#transcripts.get(path);
      if (known?.key === key) return known.wentOn;
      const wentOn = wentOnSince(await readTail(this.store, path, info, TRANSCRIPT_TAIL_BYTES), since);
      if (this.#transcripts.size >= MAX_CACHED_PANES) this.#transcripts.clear();
      this.#transcripts.set(path, { key, wentOn });
      return wentOn;
    } catch {
      return false;
    }
  }

  #forget(candidates, herdr) {
    if (this.#cache.size <= MAX_CACHED_PANES) return;
    const live = new Set(candidates.map((pane) => this.#key(herdr, pane)));
    for (const key of this.#cache.keys()) if (!live.has(key)) this.#cache.delete(key);
  }

  #key(herdr, pane) {
    const id = typeof pane.terminal_id === "string" && pane.terminal_id ? pane.terminal_id : pane.pane_id;
    return `${herdr?.sessionName ?? ""}\0${id}`;
  }

  // The job a pane's foreground process attaches to, or null. A known answer
  // is returned at once even when stale; a stale one is refreshed behind it.
  async #short(herdr, pane) {
    const key = this.#key(herdr, pane);
    const known = this.#cache.get(key);
    if (known) {
      if (!known.pending && this.now() - known.at >= PROCESS_TTL_MS) void this.#look(herdr, key, pane);
      return known.short;
    }
    const first = this.#look(herdr, key, pane);
    return Promise.race([first, new Promise((resolve) => setTimeout(() => resolve(null), FIRST_LOOK_MS).unref?.())]);
  }

  #look(herdr, key, pane) {
    const entry = this.#cache.get(key) ?? { at: 0, short: null, pending: null };
    entry.pending = paneForegroundProcesses(herdr, pane.pane_id)
      .then((processes) => {
        entry.short = processes.map(attachedJobShort).find(Boolean) ?? null;
        return entry.short;
      })
      .catch(() => null)
      .finally(() => {
        entry.at = this.now();
        entry.pending = null;
      });
    this.#cache.set(key, entry);
    return entry.pending;
  }
}
