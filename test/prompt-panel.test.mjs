// The panel card: a panel an agent's own `/` command opens (Claude's
// /usage, Codex's /config, Kiro's /usage, Antigravity's /help, OpenCode's
// /status, ...) read off the pane's screen while herdr calls the pane idle,
// with the keys its hint line names as the card's buttons.
import test from "node:test";
import assert from "node:assert/strict";
import { panelShown, parsePanel } from "../src/prompt/panel.mjs";
import { answerSteps, publicCard } from "../src/prompt/screen.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "./fixtures/claude-prompt.mjs";
import * as screens from "./fixtures/panel-screens.mjs";

const plain = (screen) => screen.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
const labels = (parsed) => parsed?.options.map((option) => option.label);
const steps = (parsed, label) => {
  const index = labels(parsed).indexOf(label);
  assert.notEqual(index, -1, `the card has a ${label} button`);
  return answerSteps(parsed, { option: index }).flatMap((step) => step.keys ?? [`text:${step.text}`]);
};

test("Claude's /usage: the settings panel's tabs, the tab shown, its text and ← → Esc", () => {
  const parsed = parsePanel(screens.claudeUsage, { agent: "claude" });
  assert.equal(parsed.agent, "claude");
  assert.equal(parsed.kind, "panel");
  assert.equal(parsed.panel, true);
  assert.equal(parsed.title, "Usage");
  assert.deepEqual(parsed.tabs, [
    { label: "Status", selected: false }, { label: "Config", selected: false },
    { label: "Usage", selected: true }, { label: "Stats", selected: false },
  ]);
  assert.match(parsed.body, /Current week \(all models\)/u);
  assert.match(parsed.body, /^Session$/mu, "the body is dedented to the panel's own margin");
  assert.doesNotMatch(parsed.body, /Esc to cancel|Settings {2}Status/u, "neither the hint nor the tab row is body");
  assert.deepEqual(labels(parsed), ["←", "→", "Esc"]);
  assert.deepEqual(steps(parsed, "←"), ["left"]);
  assert.deepEqual(steps(parsed, "Esc"), ["esc"]);
  assert.equal(parsed.options.at(-1).description, "Close");
});

test("the same panel on another tab keeps its card id; its words change", () => {
  const usage = parsePanel(screens.claudeUsage, { agent: "claude" });
  const status = parsePanel(screens.claudeStatus, { agent: "claude" });
  assert.equal(status.title, "Status");
  assert.equal(status.id, usage.id);
  assert.notEqual(status.body, usage.body);
});

test("Claude's /usage taller than the pane: herdr's recent lines hold its tab row", () => {
  const parsed = parsePanel(screens.claudeUsageTall, { agent: "claude" });
  assert.equal(parsed.title, "Usage");
  assert.equal(parsed.panelName, "Settings");
  assert.match(parsed.body, /Current week \(all models\)/u);
  assert.doesNotMatch(parsed.body, /Fable 5\.2 is here|❯ \/usage/u, "what is above the panel is not the panel");
});

test("Claude's Stats tab draws no hint line: its tab row under the last rule still says the panel is open", () => {
  const parsed = parsePanel(screens.claudeStatsNoHint, { agent: "claude" });
  assert.equal(parsed.title, "Stats");
  assert.deepEqual(labels(parsed), ["←", "→", "Esc"]);
  assert.match(parsed.body, /Favorite model/u);
  assert.equal(panelShown(plain(screens.claudeStatsNoHint), "claude"), true);
  // the input box's rules under it: the panel is closed
  assert.equal(parsePanel(`${screens.claudeStatsNoHint}\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ⏵⏵ auto mode on`, { agent: "claude" }), null);
  assert.equal(parsePanel(screens.claudeStatsNoHint, { agent: "codex" }), null, "Claude's alone");
});

test("Claude's /config names its own keys: ← → Tab ↓ and Esc, and its rows take ↑ too", () => {
  const parsed = parsePanel(screens.claudeConfig, { agent: "claude" });
  assert.equal(parsed.title, "Config");
  assert.deepEqual(labels(parsed), ["←", "→", "↑", "↓", "Tab", "Esc"]);
  assert.equal(parsed.options[0].description, "Switch");
  assert.match(parsed.body, /Search settings/u);
});

test("Claude's lists: /mcp with ↑ ↓ Enter Esc, /plugin's Space, and no button for typing", () => {
  const mcp = parsePanel(screens.claudeMcp, { agent: "claude" });
  assert.equal(mcp.title, "Manage MCP servers");
  assert.equal(mcp.tabs, undefined);
  assert.deepEqual(labels(mcp), ["↑", "↓", "Enter", "Esc"]);
  assert.match(mcp.body, /❯ ✔ notes-mcp/u);
  const plugin = parsePanel(screens.claudePlugin, { agent: "claude" });
  assert.equal(plugin.panelName, "Plugins");
  assert.equal(plugin.title, "Discover");
  assert.deepEqual(labels(plugin), ["←", "→", "↑", "↓", "Space", "Enter", "Esc"]);
  assert.deepEqual(steps(plugin, "Space"), ["space"]);
  assert.equal(parsePanel(screens.claudeMemory, { agent: "claude" }).title, "Memory");
});

test("Claude's /help is a panel; its link escapes are no text", () => {
  const parsed = parsePanel(screens.claudeHelp, { agent: "claude" });
  assert.ok(parsed);
  assert.doesNotMatch(parsed.body, /\u001b|\]8;/u);
  assert.match(parsed.body, /https:\/\/code\.claude\.com\/docs\/en\/overview/u);
});

test("Codex: /usage under earlier output, /config's groups, /hooks; /model stays the terminal's", () => {
  const usage = parsePanel(screens.codexUsage, { agent: "codex" });
  assert.equal(usage.title, "Usage");
  assert.match(usage.body, /› 1\. View analytics/u);
  assert.doesNotMatch(usage.body, /OpenAI Codex|Weekly limit/u, "the /status output above the panel is not the panel");
  assert.deepEqual(labels(usage), ["↑", "↓", "Enter", "Esc"], "a list with a row picked moves by ↑ ↓, which its hint leaves out");
  const config = parsePanel(screens.codexConfig, { agent: "codex" });
  assert.equal(config.title, "Appearance");
  assert.deepEqual(config.tabs.map((tab) => tab.label), ["Appearance", "Notifications", "Input", "Sessions", "Text selection"]);
  assert.deepEqual(labels(config), ["←", "→", "↑", "↓", "/", "Enter", "Esc"]);
  assert.deepEqual(steps(config, "/"), ["text:/"]);
  assert.equal(parsePanel(screens.codexHooks, { agent: "codex" }).title, "Hooks");
  assert.equal(parsePanel(screens.codexModel, { agent: "codex" }), null);
  assert.equal(parsePanel(screens.codexStatusInline, { agent: "codex" }), null, "/mcp prints and opens nothing");
});

test("Kiro: the panel between its rules, titled by its command", () => {
  const usage = parsePanel(screens.kiroUsage, { agent: "kiro" });
  assert.equal(usage.title, "/usage");
  assert.match(usage.body, /Estimated Usage/u);
  assert.doesNotMatch(usage.body, /─{8}|legacy desktop app/u);
  assert.deepEqual(labels(usage), ["Tab", "Esc"]);
  assert.equal(usage.options[0].description, "Switch to /context");
  const config = parsePanel(screens.kiroConfig, { agent: "kiro" });
  assert.deepEqual(labels(config), ["↑", "↓", "Enter", "Esc"]);
  assert.match(config.body, /❯ agents/u);
  const mcp = parsePanel(screens.kiroMcp, { agent: "kiro" });
  assert.equal(mcp.title, "/mcp list · 2 configured", "a command with its state, between two rules");
  assert.deepEqual(labels(mcp), ["Ctrl+J", "Ctrl+K", "Ctrl+A", "Esc"]);
  assert.deepEqual(steps(mcp, "Ctrl+J"), ["ctrl+j"]);
  const model = parsePanel(screens.kiroModel, { agent: "kiro" });
  assert.equal(model.title, "/model");
  assert.match(model.body, /Settings for selected model/u, "both of its panes");
  assert.deepEqual(steps(model, "Esc"), ["esc"]);
});

test("Antigravity: /help's views, /usage's paging keys, and no button that kills or removes", () => {
  const help = parsePanel(screens.agyHelp, { agent: "agy" });
  assert.deepEqual(help.tabs.map((tab) => tab.label), ["general", "commands", "shortcuts"]);
  assert.equal(help.title, "general");
  assert.equal(parsePanel(screens.agyHelpCommands, { agent: "agy" }).title, "commands");
  assert.deepEqual(labels(help), ["←", "→", "↑", "↓", "Esc"], "the arrows always in one order");
  assert.doesNotMatch(help.body, /Claude Sonnet 4\.6 \(Thinking\)/u, "the model line under the hint is not the panel's");
  const usage = parsePanel(screens.agyUsage, { agent: "agy" });
  assert.equal(usage.title, "Models & Quota");
  assert.deepEqual(labels(usage), ["↑", "↓", "PgUp", "PgDn", "Ctrl+End", "Ctrl+Home", "Esc"]);
  const tasks = parsePanel(screens.agyTasks, { agent: "agy" });
  assert.equal(tasks.title, "Tasks");
  assert.deepEqual(labels(tasks), ["←", "→", "↑", "↓", "Enter", "Esc"], "k Kill Task and x Remove are left to the terminal; Esc is always there");
  assert.equal(parsePanel(screens.agyPermissions, { agent: "agy" }).title, "Permission Config Editor");
  // a search box's underline is no rule across the pane: the panel is the whole settings list
  const config = parsePanel(screens.agyConfig, { agent: "agy" });
  assert.equal(config.title, "Settings");
  assert.match(config.body, /> Agent Mode/u);
});

test("OpenCode: a dialog with no search is a panel; a picker is not", () => {
  const status = parsePanel(screens.opencodeStatus, { agent: "opencode" });
  assert.equal(status.title, "Status");
  assert.match(status.body, /No MCP servers/u);
  assert.doesNotMatch(status.body, /Ask anything/u);
  assert.deepEqual(labels(status), ["Esc"]);
  const help = parsePanel(screens.opencodeHelp, { agent: "opencode" });
  assert.deepEqual(labels(help), ["Enter", "Esc"]);
  assert.equal(parsePanel(screens.opencodeAgents, { agent: "opencode" }), null);
  // as herdr reads it: the screen around the box is dimmed, on a colour of its own
  const read = parsePanel(screens.opencodeStatusHerdr, { agent: "opencode" });
  assert.equal(read.body, "No MCP servers");
});

test("no panel: an idle prompt, a working line, a blank screen", () => {
  const idle = "❯ /usage\n  ⎿  Usage dialog dismissed\n────────\n❯ \n────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n";
  assert.equal(parsePanel(idle, { agent: "claude" }), null);
  assert.equal(parsePanel("✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)\n", { agent: "claude" }), null);
  assert.equal(parsePanel("", { agent: "claude" }), null);
  assert.equal(parsePanel(screens.claudeUsage, { agent: "gemini" }), null, "only the agents whose panels are known");
});

test("panelShown tells from the plain screen alone whether a styled read is worth it", () => {
  for (const [name, agent] of [["claudeUsage", "claude"], ["codexUsage", "codex"], ["kiroUsage", "kiro"], ["agyTasks", "agy"]]) {
    assert.equal(panelShown(plain(screens[name]), agent), true, name);
  }
  assert.equal(panelShown("❯ \n  ⏵⏵ auto mode on\n", "claude"), false);
});

test("the browser gets the panel's tabs and that it is one", () => {
  const card = publicCard(parsePanel(screens.claudeUsage, { agent: "claude" }));
  assert.equal(card.panel, true);
  assert.equal(card.tabs.length, 4);
  assert.equal(card.options.at(-1).label, "Esc");
});

// --- the service ---------------------------------------------------------

function service(panes, outputs) {
  const herdr = fakePromptHerdr({ panes, outputs });
  return { herdr, prompts: new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 100, pollMs: 60_000 }) };
}

test("an idle pane on a panel gets the panel card, read with its styles", async () => {
  const { herdr, prompts } = service([{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }], { "w1:p1": screens.claudeUsage });
  const card = await prompts.card("w1:p1");
  assert.equal(card.panel, true);
  assert.equal(card.title, "Usage");
  assert.ok(herdr.reads.some((read) => read.format === "ansi" && read.source === "recent-unwrapped"), "the tab shown is known by its style, and a tall panel by its lines above the screen");
});

test("an Antigravity pane is read for a panel whatever herdr says; blocked, it still gets the fallback", async () => {
  const { prompts } = service([
    { pane_id: "w1:p1", agent: "agy", agent_status: "idle" },
    { pane_id: "w1:p2", agent: "agy", agent_status: "blocked" },
  ], { "w1:p1": screens.agyHelp, "w1:p2": "Overwrite?\nContinue? (y/n)" });
  assert.equal((await prompts.card("w1:p1")).title, "general");
  assert.equal((await prompts.card("w1:p2")).fallback, true);
});

test("a blocked pane on a panel gets the panel card, not the fallback (herdr calls Claude's /mcp blocked)", async () => {
  const { prompts } = service([{ pane_id: "w1:p1", agent: "claude", agent_status: "blocked" }], { "w1:p1": screens.claudeMcp });
  const card = await prompts.card("w1:p1");
  assert.equal(card.panel, true);
  assert.equal(card.fallback, undefined);
});

test("a panel's keys go as they are, again and again, and the card stays", async () => {
  const { herdr, prompts } = service([{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }], { "w1:p1": screens.claudeUsage });
  const card = await prompts.card("w1:p1");
  const right = card.options.findIndex((option) => option.label === "→");
  assert.deepEqual(await prompts.answer("w1:p1", { cardId: card.id, option: right }), { ok: true, stays: true });
  // the next tab: the same panel, so the same card id, and the same key again at once
  herdr.outputs["w1:p1"] = screens.claudeStatus;
  assert.deepEqual(await prompts.answer("w1:p1", { cardId: card.id, option: right }), { ok: true, stays: true });
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["right"], ["right"]]);
});

test("a panel that closed, or another one, refuses the key (409)", async () => {
  const { herdr, prompts } = service([{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }], { "w1:p1": screens.claudeUsage });
  const card = await prompts.card("w1:p1");
  herdr.outputs["w1:p1"] = screens.claudeMcp;
  await assert.rejects(prompts.answer("w1:p1", { cardId: card.id, option: 0 }), (error) => error.status === 409);
  herdr.outputs["w1:p1"] = "❯ \n";
  await assert.rejects(prompts.answer("w1:p1", { cardId: card.id, option: 0 }), (error) => error.status === 409);
  assert.deepEqual(herdr.sent, []);
});
