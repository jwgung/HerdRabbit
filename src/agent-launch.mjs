import { access, constants, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

// The command typed into a new session to start each agent public/agents.js
// lists, in that table's order. A plain word: it is typed at a shell prompt,
// so it must never be built from anything a request carries.
export const AGENT_COMMANDS = Object.freeze({
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  kiro: "kiro-cli",
  agy: "agy",
  cursor: "cursor-agent",
});

export function agentCommand(name) {
  return typeof name === "string" && Object.hasOwn(AGENT_COMMANDS, name) ? AGENT_COMMANDS[name] : null;
}

async function isExecutableFile(path) {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Which agents this machine has: those whose command is an executable file
// in a folder on this server's PATH (the PATH Herdr, and so a new session's
// shell, was started with). Nothing is run to find out. The answer is kept
// for a little while, since the New session dialog asks each time it opens.
export class InstalledAgents {
  #searchPath;
  #isExecutable;
  #now;
  #ttlMs;
  #kept = null;

  constructor({
    searchPath = () => process.env.PATH,
    isExecutable = isExecutableFile,
    now = () => Date.now(),
    ttlMs = 30_000,
  } = {}) {
    this.#searchPath = searchPath;
    this.#isExecutable = isExecutable;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  list() {
    const kept = this.#kept;
    if (kept && this.#now() - kept.at < this.#ttlMs) return kept.answer;
    const answer = this.#look();
    const entry = { at: this.#now(), answer };
    this.#kept = entry;
    // A failed look is not kept; the next question looks again.
    answer.catch(() => { if (this.#kept === entry) this.#kept = null; });
    return answer;
  }

  async #look() {
    const folders = [...new Set(String(this.#searchPath() ?? "").split(delimiter).filter((folder) => folder && isAbsolute(folder)))];
    const found = await Promise.all(Object.entries(AGENT_COMMANDS).map(async ([name, command]) => {
      for (const folder of folders) {
        if (await this.#isExecutable(join(folder, command))) return name;
      }
      return null;
    }));
    return found.filter(Boolean);
  }
}

// Only names a request may carry, each once, in the table's order.
export function knownAgentNames(names) {
  if (!Array.isArray(names)) return [];
  const wanted = new Set(names.filter((name) => agentCommand(name) !== null));
  return Object.keys(AGENT_COMMANDS).filter((name) => wanted.has(name));
}
