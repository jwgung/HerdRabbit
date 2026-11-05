import assert from "node:assert/strict";
import test from "node:test";
import { agentMonogram, hasAgentMark, integrationIconKind } from "../public/app/agent-icons.js";

test("a Herdr integration name maps to the mark kind of its program", () => {
  for (const name of ["claude", "codex", "opencode", "cursor", "pi", "copilot", "devin", "kimi", "hermes", "qwen", "grok", "kilo", "kiro"]) {
    assert.equal(integrationIconKind(name), name);
  }
  assert.equal(integrationIconKind("antigravity-cli"), "agy");
  assert.equal(integrationIconKind("qodercli"), "qoder");
  assert.equal(integrationIconKind("mastracode"), "mastra");
  assert.equal(integrationIconKind("Claude"), "claude");
});

test("a program with no mark has no kind, and is never the shell or other", () => {
  for (const name of ["droid", "letta", "omp", "future-agent", "constructor", "shell", "other", "", undefined]) {
    assert.equal(integrationIconKind(name), null, String(name));
  }
});

test("every mapped kind has a mark", () => {
  for (const kind of ["claude", "codex", "agy", "cursor", "pi", "copilot", "devin", "kimi", "kilo", "hermes", "qoder", "qwen", "mastra", "grok", "opencode", "kiro", "shell", "other"]) {
    assert.equal(hasAgentMark(kind), true, kind);
  }
  assert.equal(hasAgentMark("constructor"), false);
});

test("the monogram is one or two letters", () => {
  assert.equal(agentMonogram("droid"), "Dr");
  assert.equal(agentMonogram("letta"), "Le");
  assert.equal(agentMonogram("omp"), "Om");
  assert.equal(agentMonogram("foo-bar"), "FB");
  assert.equal(agentMonogram("x"), "X");
  assert.equal(agentMonogram(""), "?");
});
