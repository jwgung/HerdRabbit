import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { AiAccountError } from "./ai-accounts.mjs";
import { InputValidationError } from "./herdr-client.mjs";

// How much of its plan limits the signed-in account of each AI CLI has used.
// Every CLI is asked itself -- Claude Code and Antigravity print /usage, Codex
// answers over its app server, Kiro draws /usage in its terminal -- so each
// keeps refreshing its own sign-in and nothing here touches a token.
//
// A usage is { meters: [{ label, usedPercent, resetsAt, resetsText, detail }],
// notes: [text] }: resetsAt in ms when the CLI gives a time, else resetsText as
// it words it.

const LABELS = Object.freeze({ claude: "Claude Code", codex: "Codex", agy: "Antigravity CLI", kiro: "Kiro CLI" });
const CACHE_MS = 60_000;
const RUN_TIMEOUT_MS = 45_000;

export class AiUsageError extends AiAccountError {
  constructor(message) {
    // 409 like the other account refusals, so a connected PC's passes through
    // the hub as itself rather than as "that PC is broken"
    super("usage_unavailable", message, { status: 409 });
    this.name = "AiUsageError";
  }
}

const meter = (label, usedPercent, { resetsAt = null, resetsText = null, detail = null } = {}) =>
  ({ label, usedPercent, resetsAt, resetsText, detail });

const round1 = (value) => Math.round(value * 10) / 10;

// A cursor move becomes a space, not nothing: Kiro lays its panel out by
// moving the cursor, and words either side of a move would otherwise run
// together.
export function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/gu, " ")
    .replace(/\x1b[@-_]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, (char) => (char === "\n" || char === "\r" ? "\n" : ""));
}

function firstLine(text) {
  return String(text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

// `Current session: 16% used · resets Nov 11, 10:50am (Asia/Seoul)` and one
// such line per week. The reset is kept in Claude's words: it names a day
// without a year, in a zone it states.
export function parseClaudeUsage(text) {
  const meters = [];
  for (const match of String(text).matchAll(/^Current ([^:\n]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+([^\n]+))?$/gmu)) {
    const [, name, percent, resets] = match;
    const week = /^week\s*\(([^)]+)\)$/iu.exec(name.trim());
    const label = week ? `Week · ${week[1]}` : name.trim().replace(/^session$/iu, "Session").replace(/^week$/iu, "Week");
    meters.push(meter(label, Number(percent), { resetsText: resets?.trim() || null }));
  }
  if (meters.length === 0) throw new AiUsageError(firstLine(text) || "Claude Code did not say how much is used");
  const notes = [];
  const ends = /this sign-in ends (between [^()\n]+?\([^)]*\)|on [^.\n]+)/iu.exec(text);
  if (ends) notes.push(`This sign-in ends ${ends[1]}.`);
  return { meters, notes };
}

function windowLabel(minutes) {
  if (minutes === 10_080) return "Week";
  if (minutes === 1_440) return "Day";
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes} minutes` : "Limit";
}

// The answer to Codex's account/rateLimits/read: a primary and maybe a
// secondary window, each with its length, how much is used and when it resets.
export function parseCodexRateLimits(result) {
  const limits = result?.rateLimits;
  const windows = [limits?.primary, limits?.secondary]
    .filter((window) => window && Number.isFinite(window.usedPercent))
    .sort((a, b) => (a.windowDurationMins ?? 0) - (b.windowDurationMins ?? 0));
  if (windows.length === 0) throw new AiUsageError("Codex did not say how much is used");
  const meters = windows.map((window) => meter(windowLabel(window.windowDurationMins), window.usedPercent, {
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null,
  }));
  const notes = [];
  const credits = limits.credits;
  if (credits?.unlimited) notes.push("Unlimited credits");
  else if (credits?.hasCredits && Number.isFinite(Number(credits.balance))) {
    notes.push(`${Math.round(Number(credits.balance)).toLocaleString("en-US")} credits left`);
  }
  const resets = result.rateLimitResetCredits?.availableCount;
  if (Number.isInteger(resets) && resets > 0) notes.push(`${resets} free limit reset${resets === 1 ? "" : "s"} available`);
  return { meters, notes };
}

// `agy -p /usage`: one tab-separated line per model group --
// `Gemini Models  Weekly Limit Remaining  100%  2026-11-17T22:40:51Z`.
export function parseAgyUsage(text) {
  const meters = [];
  for (const line of String(text).split("\n")) {
    const [group, kind, percent, resets] = line.split("\t").map((cell) => cell.trim());
    const left = /^(\d+(?:\.\d+)?)%$/u.exec(percent ?? "");
    if (!group || !kind || !left) continue;
    const span = /weekly/iu.test(kind) ? "Week" : /daily/iu.test(kind) ? "Day" : kind.replace(/\s*remaining$/iu, "");
    const at = Date.parse(resets ?? "");
    meters.push(meter(`${span} · ${group}`, round1(100 - Number(left[1])), { resetsAt: Number.isFinite(at) ? at : null }));
  }
  if (meters.length === 0) throw new AiUsageError(firstLine(text) || "Antigravity did not say how much is used");
  return { meters, notes: [] };
}

// Kiro's /usage panel as its terminal drew it:
// ` Estimated Usage | resets on 2026-12-01 | KIRO POWER`
// ` Credits (5482.72 of 10000 covered in plan)`.
export function parseKiroUsage(raw) {
  const text = stripAnsi(raw).replace(/[ \t]+/gu, " ");
  const credits = /Credits \(([\d.,]+) of ([\d.,]+) covered in plan\)/u.exec(text);
  if (!credits) throw new AiUsageError("Kiro did not show its usage");
  const used = Number(credits[1].replaceAll(",", ""));
  const total = Number(credits[2].replaceAll(",", ""));
  if (!(total > 0)) throw new AiUsageError("Kiro did not show its usage");
  const header = /resets on (\d{4}-\d{2}-\d{2})(?: \| ([^\n|]+))?/u.exec(text);
  const plan = header?.[2]?.trim();
  const amount = `${Math.round(used).toLocaleString("en-US")} of ${Math.round(total).toLocaleString("en-US")}`;
  return {
    meters: [meter("Credits", round1((used / total) * 100), {
      resetsText: header?.[1] ?? null,
      detail: plan ? `${amount} · ${plan}` : amount,
    })],
    notes: [],
  };
}

function run(command, args, { cwd, env, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const said = firstLine(stderr) || firstLine(stdout);
        reject(new Error(error.code === "ENOENT" ? `${command} is not installed` : said || error.message));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// --no-session-persistence keeps the question out of Claude's conversations.
export async function readClaudeUsage({ cwd, env }) {
  // the sign-in's end date is a warning on stderr
  const { stdout, stderr } = await run("claude", ["-p", "/usage", "--no-session-persistence"], { cwd, env });
  return parseClaudeUsage(`${stdout}\n${stderr}`);
}

export async function readAgyUsage({ cwd, env }) {
  return parseAgyUsage((await run("agy", ["-p", "/usage"], { cwd, env })).stdout);
}

// Codex's app server speaks JSON-RPC, a message per line: initialize, then ask.
export function readCodexUsage({ cwd, env, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Codex did not answer in time")), timeoutMs);
    child.on("error", (error) => finish(new Error(error.code === "ENOENT" ? "codex is not installed" : error.message)));
    child.on("exit", () => finish(new Error("Codex stopped before it answered")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        finish(new Error("Codex answered with more than expected"));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) finish(new Error(message.error.message || "Codex could not read its limits"));
        else {
          try {
            finish(null, parseCodexRateLimits(message.result));
          } catch (error) {
            finish(error);
          }
        }
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stdin.on("error", () => {});
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdrabbit", version: "1" } } });
    send({ method: "initialized" });
    send({ id: 2, method: "account/rateLimits/read" });
  });
}

// Kiro has no way to print /usage: run without a terminal it takes the words
// as a prompt for its model. So it is started in a terminal, typed to only once
// its prompt is drawn -- before that the words could land anywhere -- and
// closed as soon as its panel shows, or when it does not.
const KIRO_READY = /ask a question or describe a task/u;
const KIRO_PANEL = /Credits \([\d.,]+ of [\d.,]+ covered in plan\)/u;
const KIRO_SIZE = Object.freeze({ cols: 120, rows: 40 });
// The rest of the panel's line comes in the same or the next write.
const KIRO_PANEL_TAIL_MS = 200;
// Its startup screen is about 120 KB; anything far past that is not a panel coming.
const KIRO_MAX_OUTPUT = 1024 * 1024;

export function readKiroUsage({ spawnPty, cwd, env = {}, timeoutMs = RUN_TIMEOUT_MS, settleMs = 400 }) {
  if (!spawnPty) return Promise.reject(new AiUsageError("Kiro's usage needs a terminal, and this PC cannot open one (node-pty is unavailable)"));
  return new Promise((resolve, reject) => {
    let output = "";
    let typedAt = -1;
    let settled = false;
    let term = null;
    const timers = new Set();
    const later = (ms, work) => { const timer = setTimeout(() => { timers.delete(timer); work(); }, ms); timers.add(timer); };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // either may throw once Kiro has already closed
      try {
        term?.write("\x1b");
      } catch {}
      try {
        term?.kill();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    later(timeoutMs, () => finish(new AiUsageError(typedAt < 0
      ? "Kiro did not get ready to be asked"
      : "Kiro did not show its usage in time")));
    try {
      term = spawnPty({
        command: "kiro-cli",
        args: ["chat", "--trust-workspace"],
        cwd,
        env,
        ...KIRO_SIZE,
        onData: (data) => {
          output += data;
          if (output.length > KIRO_MAX_OUTPUT) {
            finish(new AiUsageError("Kiro said too much without showing its usage"));
            return;
          }
          if (typedAt < 0 && KIRO_READY.test(stripAnsi(output))) {
            typedAt = output.length;
            later(settleMs, () => {
              term.write("/usage");
              later(settleMs, () => term.write("\r"));
            });
          } else if (typedAt >= 0 && KIRO_PANEL.test(stripAnsi(output.slice(typedAt)))) {
            later(Math.min(settleMs, KIRO_PANEL_TAIL_MS), () => {
              try {
                finish(null, parseKiroUsage(output.slice(typedAt)));
              } catch (error) {
                finish(error);
              }
            });
          }
        },
        onExit: () => finish(new AiUsageError("Kiro stopped before it showed its usage")),
      });
    } catch (error) {
      finish(new AiUsageError(`Kiro could not start: ${error.message}`));
    }
  });
}

// node-pty's own spawn, so Kiro opens in the usage directory rather than in
// HOME, where the panes' spawner starts every shell.
export function ptySpawner(pty) {
  return ({ command, args, cwd, env, cols, rows, onData, onExit }) => {
    const term = pty.spawn(command, args, { name: "xterm-256color", cols, rows, cwd, env: { ...env, TERM: "xterm-256color" } });
    term.onData(onData);
    term.onExit(() => onExit());
    return { write: (data) => term.write(data), kill: () => term.kill() };
  };
}

// pty() is asked when Kiro is read: node-pty is loaded after the accounts.
export function defaultUsageReaders({ pty = () => null } = {}) {
  return {
    claude: readClaudeUsage,
    codex: readCodexUsage,
    agy: readAgyUsage,
    kiro: (options) => {
      const module = pty();
      return readKiroUsage({ ...options, spawnPty: module ? ptySpawner(module) : null });
    },
  };
}

// Each CLI's usage, kept a minute so reopening the dialog does not start the
// CLI again, and read once however many ask at the same time.
export class AiUsage {
  constructor({ readers = defaultUsageReaders(), directory = null, env = process.env, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
    this.readers = readers;
    this.directory = directory;
    this.env = env;
    this.now = now;
    this.cacheMs = cacheMs;
    this.cache = new Map();
    this.reading = new Map();
    // Bumped by forget(): a read that started before a switch keeps its answer
    // to whoever asked, but does not keep it for the account signed in since.
    this.generation = new Map();
  }

  // The CLIs run in a directory of their own, so anything one leaves behind
  // for "this project" is kept apart from real work.
  async #cwd() {
    if (!this.directory) return this.env.HOME || "/";
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.directory;
  }

  // Another account is signed in now; what was read was the old one's.
  forget(cli) {
    this.cache.delete(cli);
    this.reading.delete(cli);
    this.generation.set(cli, (this.generation.get(cli) ?? 0) + 1);
  }

  async read(cli, { refresh = false } = {}) {
    const reader = typeof cli === "string" && Object.hasOwn(this.readers, cli) ? this.readers[cli] : null;
    if (!reader) throw new InputValidationError("Unknown CLI");
    const kept = this.cache.get(cli);
    if (!refresh && kept && this.now() - kept.checkedAt < this.cacheMs) return kept;
    if (this.reading.has(cli)) return this.reading.get(cli);
    const generation = this.generation.get(cli) ?? 0;
    const task = (async () => {
      try {
        const usage = await reader({ cwd: await this.#cwd(), env: this.env });
        const result = { cli, method: "cli", checkedAt: this.now(), meters: usage.meters, notes: usage.notes };
        if ((this.generation.get(cli) ?? 0) === generation) this.cache.set(cli, result);
        return result;
      } catch (error) {
        // a reader's own refusal already says which CLI; anything else gets it
        throw error instanceof AiUsageError ? error : new AiUsageError(`Could not read ${LABELS[cli] ?? cli} usage: ${error.message}`);
      } finally {
        if (this.reading.get(cli) === task) this.reading.delete(cli);
      }
    })();
    this.reading.set(cli, task);
    return task;
  }
}
