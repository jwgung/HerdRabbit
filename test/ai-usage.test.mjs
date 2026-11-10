import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AiUsage, AiUsageError, parseAgyUsage, parseClaudeUsage, parseCodexRateLimits, parseKiroUsage, readKiroUsage } from "../src/ai-usage.mjs";

const fixture = (name) => readFile(new URL(`./fixtures/ai-usage/${name}`, import.meta.url), "utf8");

test("Claude's /usage gives the session and each week, with when they reset as it says it", async () => {
  const usage = parseClaudeUsage(await fixture("claude.txt"));
  assert.deepEqual(usage.meters, [
    { label: "Session", usedPercent: 16, resetsAt: null, resetsText: "Nov 11, 10:50am (Asia/Seoul)", detail: null },
    { label: "Week · all models", usedPercent: 98, resetsAt: null, resetsText: "Nov 11, 8am (Asia/Seoul)", detail: null },
    { label: "Week · Fable", usedPercent: 4, resetsAt: null, resetsText: "Nov 11, 8am (Asia/Seoul)", detail: null },
  ]);
  assert.deepEqual(usage.notes, ["This sign-in ends between 2026-11-15 and 2026-11-18 (in 5 days at the earliest)."]);
});

test("Claude without plan limits says why instead of showing nothing", () => {
  assert.throws(() => parseClaudeUsage("/usage is only available for subscription plans.\n"),
    (error) => error instanceof AiUsageError && error.message === "/usage is only available for subscription plans.");
});

test("Codex's rate limits name each window by its length, with credits and free resets as notes", async () => {
  const usage = parseCodexRateLimits(JSON.parse(await fixture("codex.json")));
  assert.deepEqual(usage.meters, [
    { label: "Week", usedPercent: 93, resetsAt: 1794379131000, resetsText: null, detail: null },
  ]);
  assert.deepEqual(usage.notes, ["48,192 credits left", "2 free limit resets available"]);
});

test("Codex's five-hour and weekly windows both show, shortest first", () => {
  const usage = parseCodexRateLimits({ rateLimits: {
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 200 },
  } });
  assert.deepEqual(usage.meters.map((meter) => [meter.label, meter.usedPercent]), [["5 hours", 12.5], ["Week", 40]]);
  assert.deepEqual(usage.notes, []);
});

test("Antigravity says what is left; shown as what is used", async () => {
  const usage = parseAgyUsage(await fixture("agy.txt"));
  assert.deepEqual(usage.meters, [
    { label: "Week · Gemini Models", usedPercent: 0, resetsAt: Date.parse("2026-11-17T22:40:51Z"), resetsText: null, detail: null },
    { label: "Week · Claude and GPT models", usedPercent: 63, resetsAt: Date.parse("2026-11-17T22:40:51Z"), resetsText: null, detail: null },
  ]);
});

test("Kiro's credits come out of its drawn panel, not the context gauge beside it", async () => {
  const usage = parseKiroUsage(await fixture("kiro-pty.txt"));
  assert.deepEqual(usage.meters, [
    { label: "Credits", usedPercent: 54.8, resetsAt: null, resetsText: "2026-12-01", detail: "5,483 of 10,000 · KIRO POWER" },
  ]);
});

test("a panel that is not there is an error, never a zero", () => {
  assert.throws(() => parseKiroUsage("Default · claude-opus-5.5 · medium · ◔ 1%"), AiUsageError);
  assert.throws(() => parseAgyUsage(""), AiUsageError);
});

// A fake terminal: answers like Kiro once it has been typed to.
function fakeKiro({ ready = true, panel = true } = {}) {
  const typed = [];
  let onData = () => {};
  let killed = false;
  const spawnPty = ({ onData: listen }) => {
    onData = listen;
    setTimeout(() => onData(ready ? "\x1b[2m›  ask a question or describe a task ↵\x1b[0m" : "loading…"), 5);
    return {
      write(data) {
        typed.push(data);
        if (data === "\r" && panel) setTimeout(() => onData(" Estimated Usage | resets on 2026-12-01 | KIRO POWER\r\n Credits (10 of 100 covered in plan)\r\n"), 5);
      },
      kill() { killed = true; },
    };
  };
  return { spawnPty, typed, killed: () => killed };
}

test("Kiro is typed to only once its prompt is up, and closed after its panel", async () => {
  const kiro = fakeKiro();
  const usage = await readKiroUsage({ spawnPty: kiro.spawnPty, cwd: "/tmp", settleMs: 1, timeoutMs: 2_000 });
  assert.equal(usage.meters[0].usedPercent, 10);
  assert.deepEqual(kiro.typed.slice(0, 2), ["/usage", "\r"]);
  assert.equal(kiro.killed(), true);
});

test("Kiro whose prompt never shows is never typed to, so nothing reaches its model", async () => {
  const kiro = fakeKiro({ ready: false });
  await assert.rejects(readKiroUsage({ spawnPty: kiro.spawnPty, cwd: "/tmp", settleMs: 1, timeoutMs: 100 }), AiUsageError);
  assert.deepEqual(kiro.typed.filter((data) => data.includes("usage")), []);
  assert.equal(kiro.killed(), true);
});

test("usage is kept for a minute, asked again on refresh, and one read serves callers at once", async () => {
  let now = 0;
  let reads = 0;
  const usage = new AiUsage({
    readers: { claude: async () => { reads += 1; return { meters: [{ label: "Session", usedPercent: reads, resetsAt: null, resetsText: null, detail: null }], notes: [] }; } },
    now: () => now,
  });
  const [a, b] = await Promise.all([usage.read("claude"), usage.read("claude")]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.equal(a.cli, "claude");
  assert.equal(a.checkedAt, 0);
  assert.equal(a.method, "cli");
  now = 30_000;
  assert.equal((await usage.read("claude")).meters[0].usedPercent, 1);
  assert.equal((await usage.read("claude", { refresh: true })).meters[0].usedPercent, 2);
  now = 200_000;
  assert.equal((await usage.read("claude")).meters[0].usedPercent, 3);
});

test("a CLI with no reader, or one that fails, is an error naming the CLI", async () => {
  const usage = new AiUsage({ readers: { codex: async () => { throw new Error("spawn codex ENOENT"); } } });
  await assert.rejects(usage.read("nope"), /Unknown CLI/u);
  await assert.rejects(usage.read("codex"), (error) => error instanceof AiUsageError && /Codex/u.test(error.message));
});

test("switching accounts forgets the usage read for the one before", async () => {
  let reads = 0;
  const usage = new AiUsage({ readers: { claude: async () => { reads += 1; return { meters: [], notes: [] }; } } });
  await usage.read("claude");
  usage.forget("claude");
  await usage.read("claude");
  assert.equal(reads, 2);
});
