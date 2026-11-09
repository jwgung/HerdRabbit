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
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
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
// Codex's slash_command.rs is about 15 KiB; nothing past this is read.
const MAX_SOURCE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
// Claude Code's answer to initialize is about 100 KiB (its skills' long descriptions included).
const MAX_CLAUDE_OUTPUT_BYTES = 4 * 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 20_000;
// What a typed `/name` can be, as src/slash-commands.mjs holds it.
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u;
const MAX_DESCRIPTION = 200;
const MAX_COMMANDS = 500;

// The real path behind a /proc/<pid>/exe link, and what to run it by: the
// file itself, or the link when an update removed the file while it runs
// (the link then reads as its old path with " (deleted)" after it).
async function executableBehind(link) {
  try {
    const target = await realpath(link);
    return { target, path: target };
  } catch {
    try {
      return { target: (await readlink(link)).replace(/ \(deleted\)$/u, ""), path: link };
    } catch {
      return null;
    }
  }
}

// { version, path } of `agent`'s executable among a pane's foreground
// processes ({ pid }), by the path it is installed at: `path` runs that very
// build. Null when none of them tells. A shim or symlink named `codex` says
// nothing of the version, so the real file is what is read.
export async function agentExecutable(agent, processes, { procRoot = "/proc" } = {}) {
  const pattern = EXECUTABLES[agent];
  if (!pattern || !Array.isArray(processes)) return null;
  for (const item of processes.slice(0, MAX_PIDS)) {
    const pid = item?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const found = await executableBehind(join(procRoot, String(pid), "exe"));
    const version = found ? pattern.exec(found.target)?.[1] : undefined;
    if (version && VERSION.test(version)) return { version, path: found.path };
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

// A description on one line, without control characters, cut to what a list row shows.
function shortLine(text) {
  // eslint-disable-next-line no-control-regex
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
}

// What any source of an agent's commands (a build's answer, a release's
// source, the file kept on disk) is held to: names a typed `/name` can be,
// each once, one-line descriptions, MAX_COMMANDS at most.
export function cleanCommands(items) {
  const commands = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const name = item?.name;
    if (typeof name !== "string" || !COMMAND_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, description: shortLine(typeof item.description === "string" ? item.description : "") });
    if (commands.length >= MAX_COMMANDS) break;
  }
  return commands;
}

// [{ name, description }] of Claude Code's own commands, from what it wrote
// for the initialize request: the built-in ones, less the hidden.
export function parseClaudeCommands(output) {
  for (const line of String(output).split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "control_response" || entry.response?.request_id !== CLAUDE_REQUEST_ID) continue;
    const listed = entry.response?.response?.commands;
    if (!Array.isArray(listed)) return [];
    return cleanCommands(listed.filter((command) => command?.builtin !== false && !CLAUDE_HIDDEN.has(command?.name)
      && !String(command?.name).startsWith("_")));
  }
  return [];
}

// Runs `executable` with `args`, hands it the initialize request and gives
// back what it wrote up to its answer, or throws. Never waits long, never
// leaves it running.
export function runClaudeInitialize(executable, args, { timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
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
      if (output.length > MAX_CLAUDE_OUTPUT_BYTES) finish(new Error("Claude Code answered too much"));
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
  // A match's arms: each `SlashCommand::A | SlashCommand::B => …` and what
  // follows it up to the next arm, read one pattern after the other.
  const arms = (fn) => {
    const start = text.indexOf(`fn ${fn}(self)`);
    const found = new Map();
    if (start === -1) return found;
    const end = text.indexOf("\n    }", start);
    const block = text.slice(start, end === -1 ? undefined : end);
    const heads = [...block.matchAll(/((?:SlashCommand::\w+[ \t\r\n|]*)+)=>/gu)];
    heads.forEach((head, index) => {
      const after = block.slice(head.index + head[0].length, heads[index + 1]?.index ?? block.length);
      for (const each of head[1].matchAll(/SlashCommand::(\w+)/gu)) found.set(each[1], after);
    });
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
  return cleanCommands(commands);
}

// A response body, read no further than `limit` bytes; null past it.
async function boundedText(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body?.getReader) {
    const text = await response.text();
    return text.length <= limit ? text : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// How each agent's commands are had: a list (empty when they could not be),
// or null when there is nothing to ask yet, which is no failure.
const SOURCES = {
  codex: {
    // the popup's enum, from the tag the release was built from
    async load({ version, fetch }) {
      const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/tui/src/slash_command.rs`;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const text = response?.ok ? await boundedText(response, MAX_SOURCE_BYTES) : null;
      return text === null ? [] : parseCodexSlashCommands(text);
    },
  },
  claude: {
    // the pane's own build, asked once a pane shows where it runs
    async load({ executable, runClaude }) {
      if (typeof executable !== "string" || !executable.startsWith("/")) return null;
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
    let commands = null;
    try {
      const listed = await source.load({ version, executable, ...this.deps });
      if (listed === null) return null;
      commands = builtIn(listed);
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
    const list = cleanCommands(JSON.parse(await readFile(file, "utf8")));
    return list.length > 0 ? builtIn(list) : null;
  } catch {
    return null;
  }
}

// Written whole under a fresh name, then moved into place: a reader never sees
// half a file, and nothing already there (a link, say) is written through.
async function keep(file, commands) {
  const folder = join(file, "..");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const partial = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(partial, JSON.stringify(commands.map(({ name, description }) => ({ name, description }))), { mode: 0o600, flag: "wx" });
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
