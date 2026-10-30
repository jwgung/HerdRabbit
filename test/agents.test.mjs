import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS, MARK_PRIORITY, agentLabelFor, agentNamesWith, listOfNames } from "../public/agents.js";

test("every agent has its own name", () => {
  const names = AGENTS.map((agent) => agent.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z]+$/u);
});

test("a feature's list is the agents that have it, in the table's order", () => {
  assert.deepEqual(agentNamesWith("chat"), ["claude", "codex", "opencode", "kiro", "agy"]);
  assert.deepEqual(agentNamesWith("card"), ["claude", "codex", "opencode", "kiro", "agy"]);
  assert.deepEqual(agentNamesWith("slash"), ["claude", "codex", "opencode"]);
  assert.deepEqual(agentNamesWith("stop"), ["claude", "codex", "opencode"]);
  assert.deepEqual(agentNamesWith("nothing"), []);
});

test("the mark order names every agent that wears a mark, once", () => {
  const marked = AGENTS.filter((agent) => agent.marks?.length).map((agent) => agent.name).sort();
  assert.deepEqual([...MARK_PRIORITY].sort(), marked);
  assert.equal(new Set(MARK_PRIORITY).size, MARK_PRIORITY.length);
});

test("an agent's label is looked up by its name in any case, and unknown ones are 'The agent'", () => {
  assert.equal(agentLabelFor("claude"), "Claude");
  assert.equal(agentLabelFor("KIRO"), "Kiro");
  assert.equal(agentLabelFor("agy"), "Antigravity");
  assert.equal(agentLabelFor("cursor"), "The agent", "Cursor has a mark but no name of its own to show");
  assert.equal(agentLabelFor(null), "The agent");
});

test("names read as a sentence", () => {
  assert.equal(listOfNames([]), "");
  assert.equal(listOfNames(["A"]), "A");
  assert.equal(listOfNames(["A", "B"]), "A and B");
  assert.equal(listOfNames(["A", "B", "C"]), "A, B and C");
});

test("the table cannot be changed by a caller", () => {
  assert.throws(() => { AGENTS.push({ name: "x" }); }, TypeError);
  assert.throws(() => { AGENTS[0].chat = false; }, TypeError);
  assert.throws(() => { MARK_PRIORITY.push("x"); }, TypeError);
});
