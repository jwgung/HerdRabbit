import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_AGENTS, chatAgent, chatUnavailableText } from "../public/lens-preference.js";
import { SLASH_AGENTS } from "../public/composer-slash.js";
import { agentLabel, showsStop } from "../public/chat/chat-activity.js";
import { shouldWatchPrompt } from "../public/chat/prompt-card.js";
import { paneAgentKind } from "../public/ui-model.js";

// What the page does for each agent it knows, through the functions it uses.
// The one place that says which agent has which feature is public/agents.js;
// this pins what it says.
const MATRIX = {
  claude:   { label: "Claude",      chat: true, card: true, slash: true,  stop: true },
  codex:    { label: "Codex",       chat: true, card: true, slash: true,  stop: true },
  opencode: { label: "OpenCode",    chat: true, card: true, slash: true,  stop: true },
  kiro:     { label: "Kiro",        chat: true, card: true, slash: false, stop: true },
  agy:      { label: "Antigravity", chat: true, card: true, slash: false, stop: true },
};

test("each agent is offered exactly the features it has", () => {
  for (const [name, want] of Object.entries(MATRIX)) {
    assert.equal(chatAgent({ agent: name }, null), want.chat ? name : null, `${name} chat`);
    assert.equal(shouldWatchPrompt("idle", name), want.card, `${name} card`);
    assert.equal(SLASH_AGENTS.includes(name), want.slash, `${name} slash`);
    assert.equal(showsStop({ lens: "chat", agent: name, status: "working" }), want.stop, `${name} stop`);
    assert.equal(agentLabel(name), want.label, `${name} label`);
    assert.equal(paneAgentKind({ agent: name }, null), name, `${name} mark`);
  }
});

test("an agent is found by its name in any case, where the page already did", () => {
  assert.equal(agentLabel("CLAUDE"), "Claude");
  assert.equal(showsStop({ lens: "chat", agent: "OpenCode", status: "working" }), true);
  assert.equal(chatAgent({ agent: " Kiro " }, null), "kiro");
  assert.equal(paneAgentKind({ agent: "Claude-Code" }, null), "claude", "a program name only has to start with the agent's");
});

test("Cursor has a mark and nothing else", () => {
  assert.equal(paneAgentKind({ agent: "cursor" }, null), "cursor");
  assert.equal(chatAgent({ agent: "cursor" }, null), null);
  assert.equal(shouldWatchPrompt("idle", "cursor"), false);
  assert.equal(SLASH_AGENTS.includes("cursor"), false);
  assert.equal(showsStop({ lens: "chat", agent: "cursor", status: "working" }), false);
  assert.equal(agentLabel("cursor"), "The agent");
});

test("another name wears the other mark, is waited on only when blocked, and has no label", () => {
  assert.equal(paneAgentKind({ agent: "mystery" }, null), "other");
  assert.equal(shouldWatchPrompt("idle", "mystery"), false);
  assert.equal(shouldWatchPrompt("blocked", "mystery"), true);
  assert.equal(shouldWatchPrompt("idle", null), false);
  assert.equal(agentLabel("mystery"), "The agent");
  assert.equal(agentLabel(undefined), "The agent");
});

test("Antigravity is also known by its product name when choosing a mark", () => {
  assert.equal(paneAgentKind({ agent: "antigravity" }, null), "agy");
});

test("no agent, or only shell names, is a shell", () => {
  assert.equal(paneAgentKind({}, null), "shell");
  assert.equal(paneAgentKind({ agent: "bash" }, null), "shell");
});

test("when names disagree the mark follows a fixed order, not the field they came from", () => {
  // A session another agent left behind can name a different agent than the pane's.
  const kind = (pane) => paneAgentKind(pane, null);
  assert.equal(kind({ agent: "codex", agent_session: { agent: "claude" } }), "claude");
  assert.equal(kind({ agent: "claude", agent_session: { agent: "codex" } }), "claude");
  assert.equal(kind({ agent: "opencode", agent_session: { agent: "agy" } }), "agy");
  assert.equal(kind({ agent: "agy", agent_session: { agent: "opencode" } }), "agy");
  assert.equal(kind({ agent: "kiro", agent_session: { agent: "opencode" } }), "opencode");
  assert.equal(kind({ agent: "kiro", agent_session: { agent: "agy" } }), "agy");
  assert.equal(kind({ agent: "kiro", agent_session: { agent: "cursor" } }), "cursor");
  assert.equal(kind({ agent: "cursor", agent_session: { agent: "opencode" } }), "opencode");
});

test("the lists keep their order, and the tooltip names the agents Chat reads", () => {
  assert.deepEqual([...CHAT_AGENTS], ["claude", "codex", "opencode", "kiro", "agy"]);
  assert.deepEqual([...SLASH_AGENTS], ["claude", "codex", "opencode"]);
  assert.equal(
    chatUnavailableText("not_supported_agent"),
    "Chat is only for Claude Code, Codex, OpenCode, Kiro and Antigravity panes.",
  );
});
