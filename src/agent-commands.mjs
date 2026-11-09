// An agent's own `/` commands as the version a pane runs has them, rather than
// the fixed lists src/slash-commands.mjs keeps (those stay the fallback).
//
// The version comes from where the pane's agent executable is installed
// (/proc/<pid>/exe): the standalone Codex keeps each release in
// `.../releases/<version>-<target>/bin/codex`, Claude Code in
// `.../versions/<version>`. Codex cannot be asked for its commands; they are an
// enum of its TUI, so that file is read from the release's tag, once per
// version, and kept on disk.
import { spawn } from "node:child_process";
import { mkdir, readFile, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
const EXECUTABLES = {
  codex: /\/releases\/(\d+\.\d+\.\d+)-[^/]+\/bin\/codex$/u,
  claude: /\/versions\/(\d+\.\d+\.\d+)$/u,
};
const MAX_PIDS = 32;
// A version whose source could not be had is asked for again after this.
const RETRY_MS = 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 512 * 1024;

// The version of `agent` among a pane's foreground processes ({ pid }), by the
// path its executable is installed at; null when none of them tells.
export async function agentVersion(agent, processes, options = {}) {
  return (await agentExecutable(agent, processes, options))?.version ?? null;
}

// { version, path } of `agent`'s executable among a pane's foreground
// processes: `path` runs that very build, the process's own link to it when
// an update removed the file while it runs. Null when none of them tells.
export async function agentExecutable(agent, processes, { procRoot = "/proc" } = {}) {
  const pattern = EXECUTABLES[agent];
  if (!pattern || !Array.isArray(processes)) return null;
  for (const item of processes.slice(0, MAX_PIDS)) {
    const pid = item?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const link = join(procRoot, String(pid), "exe");
    let target;
    let path;
    try {
      // the real file: a shim or symlink named `codex` says nothing of the version
      target = await realpath(link);
      path = target;
    } catch {
      // one updated away while it runs is only its link, " (deleted)" after its old path
      try {
        target = (await readlink(link)).replace(/ \(deleted\)$/u, "");
        path = link;
      } catch {
        continue;
      }
    }
    const version = pattern.exec(target)?.[1];
    if (version && VERSION.test(version)) return { version, path };
  }
  return null;
}

// Claude Code answers an SDK `initialize` request with the commands that
// build has, its bundled skills included, before any model is asked: the
// request is sent to that very build, run without the user's settings (so no
// hooks or plugins), without MCP servers, in an empty folder. Its answer
// leaves out the commands only its terminal UI has; src/slash-commands.mjs
// adds those from the list it keeps.
const CLAUDE_REQUEST_ID = "herdrabbit-commands";
export const CLAUDE_ARGS = Object.freeze(["-p", "--setting-sources", "", "--strict-mcp-config", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
// Commands Claude Code lists but never shows: internal ones, and these hidden in 2.1.319.
const CLAUDE_HIDDEN = new Set(["workflow-launch-exec", "extra-usage", "design-consent", "design-revoke"]);
const COMMAND_NAME = /^[a-z0-9][a-z0-9:-]{0,99}$/u;
const MAX_DESCRIPTION = 200;

const shortLine = (text) => {
  const flat = oneLine(text);
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
};
const oneLine = (text) => String(text).replace(/\s+/gu, " ").trim();

// [{ name, description }] of Claude Code's own commands, from what it wrote
// for the initialize request: the built-in ones, each once, less the hidden.
export function parseClaudeCommands(output) {
  for (const line of String(output).split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "control_response" || entry.response?.request_id !== CLAUDE_REQUEST_ID) continue;
    const listed = entry.response?.response?.commands;
    if (!Array.isArray(listed)) return [];
    const commands = [];
    for (const command of listed) {
      const name = command?.name;
      if (typeof name !== "string" || !COMMAND_NAME.test(name) || command.builtin === false || CLAUDE_HIDDEN.has(name)) continue;
      if (commands.some((other) => other.name === name)) continue;
      commands.push({ name, description: shortLine(typeof command.description === "string" ? command.description : "") });
    }
    return commands;
  }
  return [];
}

// Runs `executable` with `args`, hands it the initialize request and gives
// back what it wrote up to its answer, or throws. Never waits long, never
// leaves it running.
export function runClaudeInitialize(executable, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: process.env });
    let output = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error("Claude Code did not answer")), timeoutMs);
    child.on("error", finish);
    child.on("close", () => finish(null));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > MAX_SOURCE_BYTES * 8) finish(new Error("Claude Code answered too much"));
      else if (output.includes(`"request_id":"${CLAUDE_REQUEST_ID}"`) && output.endsWith("\n")) finish(null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify({ type: "control_request", request_id: CLAUDE_REQUEST_ID, request: { subtype: "initialize" } })}\n`);
  });
}

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Codex's popup as codex-rs/tui/src/slash_command.rs defines it: the enum's
// variants in its order (the popup's), each named in kebab case or as its
// strum attribute says, with its description; less the ones a Linux build
// does not show (`is_visible`: debug builds only, other platforms only) and
// the "DO NOT USE" ones.
export function parseCodexSlashCommands(source) {
  const text = String(source);
  const body = /pub enum SlashCommand\s*\{([\s\S]*?)\n\}/u.exec(text)?.[1];
  if (!body) return [];
  const variants = [];
  let named = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    const attribute = /^#\[strum\((.*)\)\]$/u.exec(line);
    if (attribute) {
      named = /to_string\s*=\s*"([^"]+)"/u.exec(attribute[1])?.[1] ?? /serialize\s*=\s*"([^"]+)"/u.exec(attribute[1])?.[1] ?? null;
      continue;
    }
    const variant = /^([A-Z]\w*)\s*,?$/u.exec(line)?.[1];
    if (!variant) continue;
    variants.push({ variant, name: named ?? kebab(variant) });
    named = null;
  }
  const arms = (fn) => {
    const block = new RegExp(`fn ${fn}\\(self\\)[^{]*\\{\\s*match self \\{([\\s\\S]*?)\\n\\s{8}\\}`, "u").exec(text)?.[1] ?? "";
    const found = new Map();
    for (const arm of block.matchAll(/((?:SlashCommand::\w+\s*\|?\s*)+)=>\s*(\{[\s\S]*?\}|[^\n]+?),?\s*$/gmu)) {
      for (const each of arm[1].matchAll(/SlashCommand::(\w+)/gu)) found.set(each[1], arm[2]);
    }
    return found;
  };
  const descriptions = arms("description");
  const visibility = arms("is_visible");
  // a Linux build shows a command unless only debug builds or only other platforms do
  const hiddenOnLinux = (expression) => {
    if (expression === undefined) return false;
    if (/debug_assertions/u.test(expression)) return true;
    const platforms = [...expression.matchAll(/target_os\s*=\s*"(\w+)"/gu)].map((match) => match[1]);
    if (platforms.length === 0) return false;
    const negated = /^!\s*cfg!/u.test(expression.trim());
    return negated ? platforms.includes("linux") : !platforms.includes("linux");
  };
  const commands = [];
  for (const { variant, name } of variants) {
    const description = /"((?:[^"\\]|\\.)*)"/u.exec(descriptions.get(variant) ?? "")?.[1];
    if (description === undefined || /^DO NOT USE$/iu.test(description) || hiddenOnLinux(visibility.get(variant))) continue;
    commands.push({ name, description: sentence(description.replace(/\\(["\\])/gu, "$1")) });
  }
  return commands;
}

const SOURCES = {
  codex: {
    // the popup's enum, from the tag the release was built from
    async load(version, _executable, { fetch }) {
      const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/tui/src/slash_command.rs`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = response?.ok ? await response.text() : "";
      return text.length <= MAX_SOURCE_BYTES ? parseCodexSlashCommands(text) : [];
    },
  },
  claude: {
    needsExecutable: true,
    async load(version, executable, { runClaude }) {
      return parseClaudeCommands(await runClaude(executable, [...CLAUDE_ARGS]));
    },
  },
};

// An agent version's own commands, from that version itself: kept in memory
// and in `cacheDir` (one file per agent and version), so each version is
// looked up once. `fetch` and `runClaude` are how (a test hands in its own).
export class AgentCommandSource {
  constructor({ cacheDir, fetch = globalThis.fetch, runClaude = runClaudeInitialize, now = () => Date.now() } = {}) {
    this.cacheDir = cacheDir;
    this.deps = { fetch, runClaude };
    this.now = now;
    // `${agent}@${version}` -> commands, or { failedAt } for one that could not be had
    this.known = new Map();
    this.pending = new Map();
  }

  // [{ name, description, source: "built-in" }] for that version, or null when
  // there is no source for it or it cannot be had now. `executable` is the
  // pane's own build of it (agentExecutable), for an agent that is asked itself.
  async builtIn(agent, version, { executable = null } = {}) {
    const source = SOURCES[agent];
    if (!source || typeof version !== "string" || !VERSION.test(version)) return null;
    const key = `${agent}@${version}`;
    const known = this.known.get(key);
    if (Array.isArray(known)) return known;
    if (known && this.now() - known.failedAt < RETRY_MS) return null;
    if (!this.pending.has(key)) {
      this.pending.set(key, this.#load(agent, version, source, executable).finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }

  async #load(agent, version, source, executable) {
    const key = `${agent}@${version}`;
    const file = this.cacheDir ? join(this.cacheDir, `${agent}-${version}.json`) : null;
    const kept = file ? await readKept(file) : null;
    if (kept) {
      this.known.set(key, kept);
      return kept;
    }
    // nothing to ask yet: not a failure, asked once a pane shows where it runs
    if (source.needsExecutable && (typeof executable !== "string" || !executable.startsWith("/"))) return null;
    let commands = null;
    try {
      commands = builtIn(await source.load(version, executable, this.deps));
    } catch {
      commands = null;
    }
    if (!commands || commands.length === 0) {
      this.known.set(key, { failedAt: this.now() });
      return null;
    }
    this.known.set(key, commands);
    if (file) await keep(file, commands).catch(() => {});
    return commands;
  }
}

const builtIn = (commands) => Object.freeze(commands.map(({ name, description }) => Object.freeze({ name, description, source: "built-in" })));

async function readKept(file) {
  try {
    const list = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(list) || list.length === 0) return null;
    if (!list.every((item) => typeof item?.name === "string" && typeof item?.description === "string")) return null;
    return builtIn(list);
  } catch {
    return null;
  }
}

// Written whole, then moved into place: a reader never sees half a file.
async function keep(file, commands) {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const partial = `${file}.${process.pid}.tmp`;
  await writeFile(partial, JSON.stringify(commands.map(({ name, description }) => ({ name, description }))), { mode: 0o600 });
  await rename(partial, file);
}
