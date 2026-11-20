// Claude Code 2.1.3xx can run a session in its background daemon and leave the
// pane only the attach client (`claude attach <short id>`), which herdr does
// not recognise as an agent. This names such a pane as Claude on the job's
// session, in the snapshot itself, so the page treats it like any Claude pane.
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { JOB_SHORT_ID, SESSION_ID } from "./conversation/claude.mjs";
import { defaultClaudeConfigDir } from "./conversation/stores.mjs";
import { paneAgentName, paneForegroundProcesses } from "./pane-agent.mjs";

export const ATTACH_SOURCE = "herdrabbit:attach";
// How long what a pane's process is stays believed before it is looked at
// again (in the background: a snapshot never waits on the second look).
const PROCESS_TTL_MS = 10_000;
// How long the first look at a pane may hold a snapshot.
const FIRST_LOOK_MS = 1_500;
const MAX_JOB_STATE_BYTES = 256 * 1024;
const MAX_CACHED_PANES = 512;
// herdr's own agent states; a job state outside them leaves the status alone.
const STATUSES = new Set(["working", "idle", "blocked", "done"]);
const VERSIONED_CLAUDE = /\/claude\/versions\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

// The job's short id when this process is a Claude attach client, else null.
export function attachedJobShort(processInfo) {
  const argv = Array.isArray(processInfo?.argv) ? processInfo.argv : [];
  const [exe, verb, short] = argv;
  if (typeof exe !== "string" || verb !== "attach" || typeof short !== "string" || !JOB_SHORT_ID.test(short)) return null;
  return basename(exe) === "claude" || VERSIONED_CLAUDE.test(exe) ? short : null;
}

async function jobState(configDir, short) {
  try {
    const path = join(configDir, "jobs", short, "state.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_JOB_STATE_BYTES) return null;
    const state = JSON.parse(await readFile(path, "utf8"));
    const session = state?.sessionId;
    if (typeof session !== "string" || !SESSION_ID.test(session) || !session.startsWith(short)) return null;
    return { session, status: typeof state.state === "string" && STATUSES.has(state.state) ? state.state : null };
  } catch {
    return null;
  }
}

export class AttachedClaudePanes {
  #cache = new Map();

  constructor({ configDir = defaultClaudeConfigDir(), now = () => Date.now() } = {}) {
    this.configDir = configDir;
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
      const job = await jobState(this.configDir, shorts[index]);
      if (!job) return;
      pane.agent = "claude";
      pane.agent_session = { agent: "claude", kind: "id", source: ATTACH_SOURCE, value: job.session };
      if (job.status && (!pane.agent_status || pane.agent_status === "unknown")) pane.agent_status = job.status;
    }));
    return snapshot;
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
