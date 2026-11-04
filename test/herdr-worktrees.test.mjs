import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient, HerdrCommandError } from "../src/herdr-client.mjs";
import { HerdrBridgeClient } from "../src/herdr-bridge-client.mjs";
import { errorResponse } from "../src/error-response.mjs";
import { WorktreeInputError, validateBaseRef, validateBranchName, worktreeList } from "../src/herdr-worktrees.mjs";

// Herdr 0.9.5's answers, as `herdr worktree …` prints them.
const LIST = {
  id: "cli:worktree:list",
  result: {
    type: "worktree_list",
    source: { repo_key: "/work/shop/.git", repo_name: "shop", repo_root: "/work/shop", source_checkout_path: "/work/shop", source_workspace_id: "w1" },
    worktrees: [
      { branch: "main", is_bare: false, is_detached: false, is_linked_worktree: false, is_prunable: false, label: "shop", open_workspace_id: "w1", path: "/work/shop" },
      { branch: "feat/cart", is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: "shop", open_workspace_id: "w2", path: "/work/worktrees/shop/feat-cart" },
      { branch: null, is_bare: false, is_detached: true, is_linked_worktree: true, is_prunable: false, label: "shop", path: "/work/worktrees/shop/detached" },
    ],
  },
};
const opened = (type, extra = {}) => ({
  id: `cli:worktree:${type}`,
  result: {
    type: `worktree_${type}`,
    workspace: { workspace_id: "w3", label: "cart" },
    tab: { tab_id: "w3:t1" },
    root_pane: { pane_id: "w3:p1" },
    worktree: { branch: "feat/cart", is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: "shop", path: "/work/worktrees/shop/feat-cart" },
    ...extra,
  },
});
const out = (payload) => ({ stdout: JSON.stringify(payload), stderr: "" });
const refusal = (code, message) => Object.assign(new Error("exit 1"), { stderr: JSON.stringify({ error: { code, message }, id: "cli:worktree" }) });

function recordingRunner(responses) {
  const calls = [];
  const runner = async (binary, args, options) => {
    calls.push({ args, timeout: options.timeout });
    const response = typeof responses === "function" ? responses(args) : responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, runner };
}

test("a branch name is one Git takes, narrowed to plain characters", () => {
  for (const name of ["feat/cart", "fix-12", "release/1.4.x", "a_b", "  spaced-out  "]) assert.equal(validateBranchName(name), name.trim());
  for (const name of ["", "-x", "--help", "/x", "x/", "x.", "a..b", "a//b", ".x", "a/.b", "x.lock", "a/b.lock/c", "a b", "a:b", "a~1", "a^", "HEAD", "기능", "a\nb", `${"x".repeat(201)}`, 7, null]) {
    assert.throws(() => validateBranchName(name), WorktreeInputError, JSON.stringify(name));
  }
  for (const base of ["main", "origin/main", "v1.2.0", "HEAD~2", "main^", "HEAD^^", "0123abc"]) assert.equal(validateBaseRef(base), base);
  for (const base of ["", "-x", "~1", "a~b", "a..b", "@{-1}", "a b"]) assert.throws(() => validateBaseRef(base), WorktreeInputError, base);
  assert.deepEqual(errorResponse(new WorktreeInputError("x")), { status: 400, code: "invalid_input", message: "x" });
});

test("worktree commands go to Herdr as argv, by workspace, without taking focus", async () => {
  const fake = recordingRunner([out(LIST), out(opened("created")), out(opened("opened", { already_open: true })), out({ result: { type: "worktree_removed", workspace_id: "w2", path: "/work/worktrees/shop/feat-cart", forced: true } })]);
  const client = new HerdrClient({ runner: fake.runner });

  const list = await client.listWorktrees("w1");
  assert.deepEqual(list.source, { repo_name: "shop", repo_root: "/work/shop" });
  assert.deepEqual(list.worktrees.map((item) => [item.branch, item.path, item.open_workspace_id, item.is_linked_worktree]), [
    ["main", "/work/shop", "w1", false],
    ["feat/cart", "/work/worktrees/shop/feat-cart", "w2", true],
    [null, "/work/worktrees/shop/detached", null, true],
  ]);
  assert.deepEqual(await client.createWorktree("w1", { branch: " feat/cart ", base: "origin/main", label: " Cart " }), {
    workspace_id: "w3", tab_id: "w3:t1", pane_id: "w3:p1", path: "/work/worktrees/shop/feat-cart", branch: "feat/cart", already_open: false,
  });
  assert.equal((await client.openWorktree("w1", { path: "/work/worktrees/shop/feat-cart; rm -rf ~" })).already_open, true);
  assert.deepEqual(await client.removeWorktree("w2", { force: true }), { workspace_id: "w2", path: "/work/worktrees/shop/feat-cart", forced: true });

  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["worktree", "list", "--workspace", "w1"],
    ["worktree", "create", "--workspace", "w1", "--branch", "feat/cart", "--base", "origin/main", "--label", "Cart", "--no-focus"],
    ["worktree", "open", "--workspace", "w1", "--path", "/work/worktrees/shop/feat-cart; rm -rf ~", "--no-focus"],
    ["worktree", "remove", "--workspace", "w2", "--force"],
  ]);
  // Git's work takes longer than a workspace command's few seconds.
  assert.ok(fake.calls.slice(1).every((call) => call.timeout >= 60_000));
});

test("optional parts are left out, and a bad name or id never reaches Herdr", async () => {
  const fake = recordingRunner([out(opened("created")), out({ result: { workspace_id: "w2", path: "/p", forced: false } })]);
  const client = new HerdrClient({ runner: fake.runner });
  await client.createWorktree("w1", { branch: "cart" });
  await client.removeWorktree("w2");
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["worktree", "create", "--workspace", "w1", "--branch", "cart", "--no-focus"],
    ["worktree", "remove", "--workspace", "w2"],
  ]);
  for (const attempt of [
    () => client.listWorktrees("--help"),
    () => client.createWorktree("w1", { branch: "--force" }),
    () => client.createWorktree("w1", {}),
    () => client.createWorktree("w1", { branch: "a", base: "-x" }),
    () => client.createWorktree("w1", { branch: "a", label: "" }),
    () => client.openWorktree("w1", { path: "relative" }),
    () => client.openWorktree("w1", {}),
    () => client.removeWorktree("w1", { force: "yes" }),
  ]) await assert.rejects(attempt);
  assert.equal(fake.calls.length, 2);
});

test("Herdr's refusals keep their code: a folder outside Git, a dirty checkout", async () => {
  const fake = recordingRunner([
    refusal("not_git_worktree", "Herdr worktree actions require a workspace inside a Git work tree"),
    refusal("dirty_worktree_requires_force", "worktree has uncommitted changes; use --force"),
  ]);
  const client = new HerdrClient({ runner: fake.runner });
  const notGit = await client.listWorktrees("w1").catch((error) => error);
  assert.ok(notGit instanceof HerdrCommandError);
  assert.equal(notGit.code, "not_git_worktree");
  assert.equal(errorResponse(notGit).status, 409);
  const dirty = await client.removeWorktree("w2").catch((error) => error);
  assert.deepEqual(errorResponse(dirty), { status: 409, code: "dirty_worktree_requires_force", message: "worktree has uncommitted changes; use --force" });
});

test("a worktree workspace's branch is added to the snapshot from its repository's list, kept a while", async () => {
  let now = 0;
  const snapshot = () => out({ result: { snapshot: {
    workspaces: [
      { workspace_id: "w1", label: "shop", worktree: { repo_key: "/work/shop/.git", checkout_path: "/work/shop", is_linked_worktree: false } },
      { workspace_id: "w2", label: "cart", worktree: { repo_key: "/work/shop/.git", checkout_path: "/work/worktrees/shop/feat-cart", is_linked_worktree: true } },
      { workspace_id: "w9", label: "notes" },
    ],
    tabs: [], panes: [],
  } } });
  const fake = recordingRunner((args) => (args[0] === "api" ? snapshot() : out(LIST)));
  const client = new HerdrClient({ runner: fake.runner, now: () => now });

  const first = await client.snapshot();
  assert.deepEqual(first.workspaces.map((item) => item.worktree?.branch ?? null), ["main", "feat/cart", null]);
  assert.equal(fake.calls.filter((call) => call.args[0] === "worktree").length, 1, "one list per repository");
  assert.ok(fake.calls[1].timeout <= 2_000, "a snapshot waits on the list only briefly");

  await client.snapshot();
  assert.equal(fake.calls.filter((call) => call.args[0] === "worktree").length, 1, "kept, not asked again");
  now = 20_000;
  assert.equal((await client.snapshot()).workspaces[1].worktree.branch, "feat/cart", "the kept branch, while it is asked again");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.filter((call) => call.args[0] === "worktree").length, 2);
});

test("a repository Herdr cannot list just has no branch, and the snapshot still comes", async () => {
  const fake = recordingRunner((args) => (args[0] === "api"
    ? out({ result: { snapshot: { workspaces: [{ workspace_id: "w2", worktree: { repo_key: "k", checkout_path: "/p" } }] } } })
    : refusal("not_git_worktree", "no")));
  const client = new HerdrClient({ runner: fake.runner });
  assert.equal((await client.snapshot()).workspaces[0].worktree.branch, undefined);
});

test("the bridge scopes the workspace ids of a list and of what a worktree made", async () => {
  const fake = recordingRunner((args) => {
    if (args.includes("list") && args.includes("session")) return out({ result: { sessions: [{ name: "default", default: true, running: true }] } });
    if (args.includes("list")) return out(LIST);
    if (args.includes("remove")) return out({ result: { workspace_id: "w2", path: "/p", forced: false } });
    return out(opened("created"));
  });
  const bridge = new HerdrBridgeClient({ runner: fake.runner });
  const session = "hs_ZGVmYXVsdA";
  const list = await bridge.listWorktrees(`${session}~w1`);
  assert.deepEqual(list.worktrees.map((item) => item.open_workspace_id), [`${session}~w1`, `${session}~w2`, null]);
  const made = await bridge.createWorktree(`${session}~w1`, { branch: "feat/cart" });
  assert.deepEqual([made.workspace_id, made.tab_id, made.pane_id], [`${session}~w3`, `${session}~w3:t1`, `${session}~w3:p1`]);
  assert.equal((await bridge.removeWorktree(`${session}~w2`)).workspace_id, `${session}~w2`);
  await assert.rejects(() => bridge.listWorktrees("w1"));
});

test("the list keeps only what it names: a checkout without a folder is dropped", () => {
  const list = worktreeList({ source: null, worktrees: [{ branch: "x" }, { path: "/a", branch: 7, open_workspace_id: "../w1" }] });
  assert.deepEqual(list, {
    source: { repo_name: null, repo_root: null },
    worktrees: [{ path: "/a", branch: null, label: null, is_linked_worktree: false, is_detached: false, is_bare: false, is_prunable: false, open_workspace_id: null }],
  });
});
