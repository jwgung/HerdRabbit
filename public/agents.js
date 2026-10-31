// What the page knows of each code agent, in one table. A feature that only
// some agents have is a field here, and the lists the rest of the page keeps
// (who Chat reads, who is asked for a prompt card, who takes `/` commands, who
// has a Stop button, what the program is called) are made from it.
//
//   name     the name herdr gives the agent, lower case
//   label    what a row or a card calls it; none, and it is "The agent"
//   product  what the program is called in a sentence, when that is not `label`
//   marks    the program names (prefixes) that wear this agent's mark
//   chat     the server reads its conversation, so the Chat lens is offered
//   card     its pane is asked for a prompt card whatever herdr says it is doing
//            (any other agent only while blocked)
//   slash    its `/` commands are listed in the composer
//   stop     Chat offers a Stop button: Esc interrupts it (one Esc for Kiro
//            CLI 2.35.1 and Antigravity CLI 1.4.10 too, checked 2026-10-30)
//
// The order is the order these are listed in. The mark a pane wears when the
// names it carries disagree is MARK_PRIORITY's, not this order's. The drawing
// of a mark is in app.js (AGENT_MARKS); an agent with none is drawn as "other".
// The server has its own table of what it can read (src/conversation/service.mjs,
// src/prompt/service.mjs).
export const AGENTS = Object.freeze([
  { name: "claude", label: "Claude", product: "Claude Code", marks: ["claude"], chat: true, card: true, slash: true, stop: true },
  { name: "codex", label: "Codex", marks: ["codex"], chat: true, card: true, slash: true, stop: true },
  { name: "opencode", label: "OpenCode", marks: ["opencode"], chat: true, card: true, slash: true, stop: true },
  { name: "kiro", label: "Kiro", marks: ["kiro"], chat: true, card: true, stop: true },
  { name: "agy", label: "Antigravity", marks: ["agy", "antigravity"], chat: true, card: true, stop: true },
  { name: "cursor", marks: ["cursor"] },
].map((agent) => Object.freeze(agent)));

// Which agent's mark a pane wears when the names it carries name more than one
// (a session another agent left behind can name a different agent than the
// pane's): the first of these.
export const MARK_PRIORITY = Object.freeze(["claude", "codex", "agy", "opencode", "cursor", "kiro"]);

// The names of the agents with a feature, in the table's order.
export function agentNamesWith(feature) {
  return AGENTS.filter((agent) => agent[feature] === true).map((agent) => agent.name);
}

// What a row or a card calls the agent herdr names.
export function agentLabelFor(name) {
  const wanted = String(name ?? "").toLowerCase();
  return AGENTS.find((agent) => agent.name === wanted)?.label ?? "The agent";
}

// "A", "A and B", "A, B and C".
export function listOfNames(names) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// What the program is called in a sentence, for the agents with a feature.
export function productNamesWith(feature) {
  return AGENTS.filter((agent) => agent[feature] === true).map((agent) => agent.product ?? agent.label);
}
