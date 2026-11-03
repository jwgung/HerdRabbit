import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_COMMANDS } from "./agent-launch.mjs";
import { SESSION_ID as CLAUDE_SESSION_ID, claudeProjectDir, parseClaudeTranscript } from "./conversation/claude.mjs";
import { THREAD_ID } from "./conversation/codex.mjs";
import { kiroWorkspaceHash, parseKiroTranscript } from "./conversation/kiro.mjs";
import { OPENCODE_SESSION_ID } from "./conversation/opencode.mjs";
import { localTranscriptStore } from "./conversation/stores.mjs";

// A folder's earlier agent sessions, and how one is resumed. The stores are
// the ones the Chat view reads (src/conversation/); this only lists what they
// already find.

// How many sessions a list holds at most.
export const MAX_LISTED_SESSIONS = 20;
const MAX_TITLE = 120;
// How much of a transcript's start and end is read for its title and first prompt.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_META_BYTES = 64 * 1024;
const KIRO_SESSION = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// What each agent's CLI takes to resume a session, checked against its own
// --help (claude 2.x, codex, opencode, kiro-cli chat), and the shape of its
// session ids. Only an id of exactly that shape is ever put after the flag.
// agy (`--conversation <id>`) has a flag but no way here to tell which of its
// conversations ran in a folder, so it is not listed.
const RESUME = Object.freeze({
  claude: Object.freeze({ id: CLAUDE_SESSION_ID, args: "--resume" }),
  codex: Object.freeze({ id: THREAD_ID, args: "resume" }),
  opencode: Object.freeze({ id: OPENCODE_SESSION_ID, args: "--session" }),
  kiro: Object.freeze({ id: KIRO_SESSION, args: "chat --resume-id" }),
});

export function canResume(agent) {
  return typeof agent === "string" && Object.hasOwn(RESUME, agent);
}

// The command that resumes `id` with `agent`: the agent's own command, its
// fixed flag and the id, or null when the id is not that agent's kind.
export function resumeCommand(agent, id) {
  if (!canResume(agent) || typeof id !== "string" || !RESUME[agent].id.test(id)) return null;
  return `${AGENT_COMMANDS[agent]} ${RESUME[agent].args} ${id}`;
}

// A title as a list shows it: one line of plain text, cut short.
export function sessionTitle(text) {
  if (typeof text !== "string") return "";
  const line = text.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

// A list another machine sent: only that agent's ids, each once, in the
// order sent, at most MAX_LISTED_SESSIONS.
export function cleanSessionList(agent, list) {
  if (!canResume(agent) || !Array.isArray(list)) return [];
  const seen = new Set();
  const clean = [];
  for (const item of list) {
    if (clean.length >= MAX_LISTED_SESSIONS) break;
    if (item === null || typeof item !== "object" || resumeCommand(agent, item.id) === null || seen.has(item.id)) continue;
    seen.add(item.id);
    clean.push({ id: item.id, title: sessionTitle(item.title), updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null });
  }
  return clean;
}

const validFolder = (cwd) => typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(cwd);

// Whole lines of a part of a file: a cut first or last line is dropped.
function lines(text, { cutStart = false, cutEnd = false } = {}) {
  const all = text.split("\n");
  if (cutStart) all.shift();
  if (cutEnd) all.pop();
  return all;
}

async function readSmall(path, max) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const firstPrompt = (turns) => turns.find((turn) => turn.role === "user" && !turn.queued)?.parts
  .filter((part) => part.kind === "text").map((part) => part.text).join(" ") ?? "";

export class AgentSessions {
  #store;
  #limit;

  constructor({ store = localTranscriptStore(), limit = MAX_LISTED_SESSIONS } = {}) {
    this.#store = store;
    this.#limit = limit;
  }

  // [{ id, title, updatedAt }] of `agent` in folder `cwd`, newest first; null
  // for an agent this cannot resume. A store that cannot be read throws.
  async list(agent, cwd) {
    if (!canResume(agent)) return null;
    if (!validFolder(cwd)) return [];
    const found = agent === "claude" ? await this.#claude(cwd)
      : agent === "codex" ? await this.#store.codex.recentThreads(cwd, this.#limit)
        : agent === "kiro" ? await this.#kiro(cwd)
          : await this.#store.opencode.recent(cwd, this.#limit);
    return cleanSessionList(agent, found).slice(0, this.#limit);
  }

  // Claude keeps a folder's sessions as `<uuid>.jsonl` under the folder's
  // project directory. The title is the user's name for it, else Claude's own,
  // else its first prompt; one with neither (nothing said in it) is skipped.
  async #claude(cwd) {
    const project = join(this.#store.configDir, "projects", claudeProjectDir(cwd));
    let names;
    try { names = await readdir(project); } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
      throw error;
    }
    const files = [];
    for (const name of names) {
      const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
      if (!CLAUDE_SESSION_ID.test(id)) continue;
      const info = await this.#store.stat(join(project, name));
      if (info) files.push({ id, path: join(project, name), ...info });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sessions = [];
    for (const file of files) {
      if (sessions.length >= this.#limit) break;
      const title = await this.#claudeTitle(file);
      if (title) sessions.push({ id: file.id, title, updatedAt: Math.round(file.mtimeMs) });
    }
    return sessions;
  }

  async #claudeTitle({ path, size }) {
    const headLength = Math.min(size, HEAD_BYTES);
    const head = (await this.#store.read(path, 0, headLength)).toString("utf8");
    const tailStart = Math.max(headLength, size - TAIL_BYTES);
    const tail = tailStart < size ? (await this.#store.read(path, tailStart, size - tailStart)).toString("utf8") : "";
    const headLines = lines(head, { cutEnd: headLength < size });
    let named = "";
    let titled = "";
    for (const line of [...headLines, ...lines(tail, { cutStart: true })]) {
      if (!line.includes("-title")) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "custom-title" && typeof entry.customTitle === "string") named = entry.customTitle;
      if (entry?.type === "ai-title" && typeof entry.aiTitle === "string") titled = entry.aiTitle;
    }
    return sessionTitle(named) || sessionTitle(titled) || sessionTitle(firstPrompt(parseClaudeTranscript(headLines.join("\n"))));
  }

  // Kiro names a session `sess_<uuid>` under the folder's workspace hash; its
  // session.json holds Kiro's title, else the first prompt is shown.
  async #kiro(cwd) {
    const found = (await this.#store.kiro.sessionsIn(kiroWorkspaceHash(cwd))).slice(0, this.#limit);
    const sessions = [];
    for (const { session, path, mtimeMs } of found) {
      let title = "";
      const meta = await readSmall(join(dirname(path), "session.json"), MAX_META_BYTES);
      try { title = sessionTitle(JSON.parse(meta ?? "null")?.title); } catch { /* a torn file has no title */ }
      if (!title) {
        const info = await this.#store.stat(path);
        const length = Math.min(info?.size ?? 0, HEAD_BYTES);
        const head = length > 0 ? (await this.#store.read(path, 0, length)).toString("utf8") : "";
        title = sessionTitle(firstPrompt(parseKiroTranscript(lines(head, { cutEnd: length < (info?.size ?? 0) }).join("\n"))));
      }
      sessions.push({ id: `sess_${session}`, title, updatedAt: Math.round(mtimeMs) });
    }
    return sessions;
  }
}
