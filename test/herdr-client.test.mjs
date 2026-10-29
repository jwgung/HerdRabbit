import test from "node:test";
import assert from "node:assert/strict";
import {
  namesImage,
  HerdrClient,
  HerdrCommandError,
  InputValidationError,
  validation,
} from "../src/herdr-client.mjs";

test("accepts alphanumeric Herdr IDs and rejects malformed IDs", () => {
  assert.equal(validation.validatePaneId("wB:p1"), "wB:p1");
  assert.equal(validation.validatePaneId("wB:pA"), "wB:pA");
  assert.equal(validation.validateWorkspaceId("wB"), "wB");
  assert.equal(validation.validateTabId("wB:tA"), "wB:tA");
  for (const id of ["wB:p1/", "wB:p1\n", "--help", "w:p", "wB:p1;id"]) {
    assert.throws(() => validation.validatePaneId(id), InputValidationError);
  }
});

function recordingRunner(responses) {
  const calls = [];
  const runner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, runner };
}

test("unwraps the Herdr snapshot envelope", async () => {
  const fixture = { workspaces: [{ workspace_id: "w1" }], tabs: [], panes: [] };
  const fake = recordingRunner([
    { stdout: JSON.stringify({ id: "cli:api", result: { snapshot: fixture } }), stderr: "" },
  ]);
  const client = new HerdrClient({ binary: "/opt/herdr", runner: fake.runner });

  assert.deepEqual(await client.snapshot(), fixture);
  assert.deepEqual(fake.calls[0].args, ["api", "snapshot"]);
  assert.equal(fake.calls[0].binary, "/opt/herdr");
});

test("scopes Herdr commands to a named persistent session", async () => {
  const fixture = { workspaces: [], tabs: [], panes: [], agents: [] };
  const fake = recordingRunner([
    { stdout: JSON.stringify({ result: { snapshot: fixture } }), stderr: "" },
  ]);
  const client = new HerdrClient({ runner: fake.runner, sessionName: "review" });

  assert.deepEqual(await client.snapshot(), fixture);
  assert.deepEqual(fake.calls[0].args, [
    "--session=review",
    "api",
    "snapshot",
  ]);
});

test("lists persistent Herdr sessions without selecting one", async () => {
  const sessions = [{ name: "default", default: true, running: true }];
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions }), stderr: "" },
  ]);
  const client = new HerdrClient({ runner: fake.runner });

  assert.deepEqual(await client.listSessions(), sessions);
  assert.deepEqual(fake.calls[0].args, ["session", "list", "--json"]);
});

test("reads ANSI terminal output by default with bounded rows", async () => {
  const fake = recordingRunner([{ stdout: "hello\n", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });

  assert.equal(await client.readPane("w12:p3", { lines: 90 }), "hello\n");
  assert.deepEqual(fake.calls[0].args, [
    "pane",
    "read",
    "w12:p3",
    "--source",
    "recent-unwrapped",
    "--lines",
    "90",
    "--format",
    "ansi",
  ]);
});

test("can explicitly read plain terminal text", async () => {
  const fake = recordingRunner([{ stdout: "hello\n", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });

  await client.readPane("w12:p3", { lines: 90, format: "text" });
  assert.equal(fake.calls[0].args.at(-1), "text");
});

test("reads the live screen herdr detects agent states on, the visible screen, and no other source", async () => {
  const fake = recordingRunner([{ stdout: "hello\n", stderr: "" }, { stdout: "styled\n", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });

  await client.readPane("w12:p3", { lines: 120, format: "text", source: "detection" });
  assert.deepEqual(fake.calls[0].args.slice(3, 5), ["--source", "detection"]);
  await assert.rejects(client.readPane("w12:p3", { source: "--raw" }), /Read source/);
  // the visible screen with its styles, as OpenCode's cards read it
  await client.readPane("w12:p3", { lines: 120, format: "ansi", source: "visible" });
  assert.deepEqual(fake.calls.at(-1).args.slice(3, 5), ["--source", "visible"]);
});

test("submits text through Herdr's atomic pane run command", async () => {
  const ok = { stdout: "", stderr: "" };
  const fake = recordingRunner([ok]);
  const client = new HerdrClient({ runner: fake.runner });

  assert.equal(
    await client.sendText("w1:p2", "$(touch /tmp/not-run)", { submit: true }),
    "",
  );

  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "run", "w1:p2", "$(touch /tmp/not-run)"],
  ]);
});

test("a message naming an image gets its Enter a moment after the text, so the agent attaches it first", async () => {
  const ok = { stdout: "", stderr: "" };
  const fake = recordingRunner([ok, ok]);
  const waited = [];
  const client = new HerdrClient({ runner: fake.runner, imageSettleMs: 700, sleep: async (ms) => { waited.push(ms); } });
  const text = "look at /home/me/.local/share/herdrabbit/files/pasted-2026-10-15T00-44-38.png please";
  await client.sendText("w1:p2", text, { submit: true });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "send-text", "w1:p2", text],
    ["pane", "send-keys", "w1:p2", "enter"],
  ]);
  assert.deepEqual(waited, [700]);
});

test("input to one pane goes in order: a message waiting on its Enter is not cut into", async () => {
  const ok = { stdout: "", stderr: "" };
  const fake = recordingRunner([ok, ok, ok, ok, ok]);
  let release;
  const client = new HerdrClient({ runner: fake.runner, sleep: () => new Promise((resolve) => { release = resolve; }) });
  const image = client.sendText("w1:p2", "see /tmp/a.png", { submit: true });
  const next = client.sendText("w1:p2", "and then this", { submit: true });
  const keys = client.sendKeys("w1:p2", ["esc"]);
  const other = client.sendText("w1:p3", "another pane", { submit: true });
  await other;
  // another pane is not held up; this one waits behind the image's Enter
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "send-text", "w1:p2", "see /tmp/a.png"],
    ["pane", "run", "w1:p3", "another pane"],
  ]);
  release();
  await Promise.all([image, next, keys]);
  assert.deepEqual(fake.calls.map((call) => call.args).filter((args) => args[2] === "w1:p2"), [
    ["pane", "send-text", "w1:p2", "see /tmp/a.png"],
    ["pane", "send-keys", "w1:p2", "enter"],
    ["pane", "run", "w1:p2", "and then this"],
    ["pane", "send-keys", "w1:p2", "esc"],
  ]);
});

test("the order holds across clients made for the same Herdr, as the bridge makes one per call", async () => {
  const ok = { stdout: "", stderr: "" };
  const fake = recordingRunner([ok, ok, ok]);
  let release;
  const first = new HerdrClient({ runner: fake.runner, sessionName: "work", sleep: () => new Promise((resolve) => { release = resolve; }) });
  const second = new HerdrClient({ runner: fake.runner, sessionName: "work" });
  const image = first.sendText("w9:p1", "see /tmp/a.png", { submit: true });
  const next = second.sendText("w9:p1", "after", { submit: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.calls.filter((call) => call.args.includes("w9:p1")).length, 1, "the second client cut in");
  release();
  await Promise.all([image, next]);
  assert.deepEqual(fake.calls.map((call) => call.args.filter((arg) => !arg.startsWith("--session"))).filter((args) => args.includes("w9:p1")), [
    ["pane", "send-text", "w9:p1", "see /tmp/a.png"],
    ["pane", "send-keys", "w9:p1", "enter"],
    ["pane", "run", "w9:p1", "after"],
  ]);
});

test("tells an image path in a message from other text", async () => {
  for (const text of ["/tmp/a.png", "see ~/shots/b.JPG", "./c.webp and more", '"/x y/d.gif"', "(/p/e.jpeg)", "@shots/a.png", '@"my folder/a.png" now', "@/tmp/b.webp",
    "확인해 줘: /tmp/a.png, 그리고", "look at /tmp/a.png.", "[/tmp/a.png]", "@shots/a.png,", "see /tmp/a.png?"]) {
    assert.equal(namesImage(text), true, text);
  }
  for (const text of ["no image here", "image.png", "/tmp/notes.md", "a.png.txt at /tmp/f.png.bak", "https://x.test/a.png", "@src/app.js", "me@x.png"]) {
    assert.equal(namesImage(text), false, text);
  }
});

test("accepts an empty successful response when sending terminal keys", async () => {
  const fake = recordingRunner([{ stdout: "", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });

  assert.equal(await client.sendKeys("w1:p2", ["ctrl+c"]), "");
  assert.deepEqual(fake.calls[0].args, ["pane", "send-keys", "w1:p2", "ctrl+c"]);
});

test("direct text is sent literally without an option separator or automatic Enter", async () => {
  const fake = recordingRunner([{ stdout: "", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });
  assert.equal(await client.sendText("w1:p2", "/$한글 --help"), "");
  assert.deepEqual(fake.calls[0].args, ["pane", "send-text", "w1:p2", "/$한글 --help"]);
});

test("renames a workspace with one validated label argument", async () => {
  const fake = recordingRunner([
    { stdout: JSON.stringify({ result: { workspace: { workspace_id: "w12", label: "새 프로젝트" } } }), stderr: "" },
  ]);
  const client = new HerdrClient({ runner: fake.runner });

  await client.renameWorkspace("w12", "  새 프로젝트  ");

  assert.deepEqual(fake.calls[0].args, [
    "workspace",
    "rename",
    "w12",
    "새 프로젝트",
  ]);
});

test("renames a session with one validated label argument", async () => {
  // A name with spaces has to reach the CLI as one argument: `tab rename` takes
  // the label as trailing words, so a split name would silently become several.
  const fake = recordingRunner([
    { stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2", label: "배포 확인" } } }), stderr: "" },
  ]);
  const client = new HerdrClient({ runner: fake.runner });

  await client.renameTab("w1:t2", "  배포 확인  ");

  assert.deepEqual(fake.calls[0].args, ["tab", "rename", "w1:t2", "배포 확인"]);
});

test("creates and closes shell workspaces and tabs without changing Herdr focus", async () => {
  const ok = { stdout: "", stderr: "" };
  const fake = recordingRunner([ok, ok, ok, ok]);
  const client = new HerdrClient({ runner: fake.runner });

  await client.createWorkspace("  새 프로젝트  ");
  await client.createTab("w12");
  await client.closeTab("w12:t3");
  await client.closeWorkspace("w12");

  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["workspace", "create", "--label", "새 프로젝트", "--no-focus"],
    ["tab", "create", "--workspace", "w12", "--no-focus"],
    ["tab", "close", "w12:t3"],
    ["workspace", "close", "w12"],
  ]);
});

test("rejects invalid pane ids, row counts, text and keys", async () => {
  const client = new HerdrClient({ runner: async () => assert.fail("runner must not execute") });

  await assert.rejects(() => client.readPane("../../socket", { lines: 10 }), InputValidationError);
  await assert.rejects(
    () => client.readPane("w1:p1", { lines: 100_002 }),
    InputValidationError,
  );
  await assert.rejects(() => client.sendText("w1:p1", ""), InputValidationError);
  await assert.rejects(() => client.sendKeys("w1:p1", ["ctrl+\n"]), InputValidationError);
  await assert.rejects(() => client.renameWorkspace("../w1", "프로젝트"), InputValidationError);
  await assert.rejects(() => client.renameWorkspace("w1", "   "), InputValidationError);
  await assert.rejects(() => client.renameWorkspace("w1", "첫째\n둘째"), InputValidationError);
  await assert.rejects(() => client.createWorkspace("  "), InputValidationError);
  await assert.rejects(() => client.createTab("../w1"), InputValidationError);
  await assert.rejects(() => client.closeTab("w1:p1"), InputValidationError);
  await assert.rejects(() => client.renameTab("w1", "세션"), InputValidationError);
  await assert.rejects(() => client.renameTab("w1:t1", "   "), InputValidationError);
  await assert.rejects(() => client.renameTab("w1:t1", "첫째\n둘째"), InputValidationError);
  await assert.rejects(() => client.closeWorkspace("w1:t1"), InputValidationError);
  assert.throws(
    () => new HerdrClient({ sessionName: "bad\nsession" }),
    InputValidationError,
  );
  assert.throws(
    () => new HerdrClient({ sessionName: "가".repeat(81) }),
    InputValidationError,
  );
});

test("does not reflect arbitrary stderr into browser-facing errors", async () => {
  const commandError = Object.assign(new Error("failed"), {
    stderr: "secret host path and token",
  });
  const fake = recordingRunner([commandError]);
  const client = new HerdrClient({ runner: fake.runner });

  await assert.rejects(
    () => client.snapshot(),
    (error) => {
      assert.ok(error instanceof HerdrCommandError);
      assert.equal(error.message, "Herdr command failed");
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("terminalTarget names the attach command, the session's socket and the pane's size", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const pane = json({ pane: { pane_id: "w1:p2", terminal_id: "term_9" } });
  const sessions = json({ sessions: [{ name: "default", running: true, socket_path: "/run/herdr.sock" }] });
  const layout = json({ layout: { panes: [{ pane_id: "w1:p2", rect: { width: 120, height: 40 } }] } });
  const fake = recordingRunner([pane, sessions, layout]);
  const client = new HerdrClient({ binary: "/opt/herdr", runner: fake.runner });
  assert.deepEqual(await client.terminalTarget("w1:p2"), {
    command: "/opt/herdr", args: ["terminal", "attach", "term_9"], env: { HERDR_SOCKET_PATH: "/run/herdr.sock" },
    terminalId: "term_9", cols: 120, rows: 40,
  });
  assert.deepEqual(fake.calls.map((call) => call.args.slice(0, 2)), [["pane", "get"], ["session", "list"], ["pane", "layout"]]);

  const noLayout = recordingRunner([pane, sessions, new Error("layout failed")]);
  const sized = await new HerdrClient({ runner: noLayout.runner }).terminalTarget("w1:p2");
  assert.equal(sized.cols, undefined, "a pane whose layout cannot be read has no size of its own");

  const stopped = recordingRunner([pane, json({ sessions: [{ name: "default", running: false }] }), layout]);
  await assert.rejects(new HerdrClient({ runner: stopped.runner }).terminalTarget("w1:p2"), { code: "server_unavailable" });
  const other = recordingRunner([pane, sessions, layout]);
  await assert.rejects(new HerdrClient({ runner: other.runner, sessionName: "review" }).terminalTarget("w1:p2"), { code: "server_unavailable" });

  const noTerminal = recordingRunner([json({ pane: { pane_id: "w1:p2" } }), sessions, layout]);
  await assert.rejects(new HerdrClient({ runner: noTerminal.runner }).terminalTarget("w1:p2"), { code: "no_terminal" });
  await assert.rejects(new HerdrClient({ runner: recordingRunner([]).runner }).terminalTarget("--help"), InputValidationError);
});

test("terminalTarget bounds each herdr call by the time it is given", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([
    json({ pane: { pane_id: "w1:p2", terminal_id: "term_9" } }),
    json({ sessions: [{ name: "default", running: true, socket_path: "/run/herdr.sock" }] }),
    json({ layout: { panes: [] } }),
  ]);
  await new HerdrClient({ runner: fake.runner, timeoutMs: 5_000 }).terminalTarget("w1:p2", 300);
  assert.deepEqual(fake.calls.map((call) => call.options.timeout), [300, 300, 300]);
});

test("a client given a socket sends every command there, as its only session", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([
    json({ snapshot: { panes: [] } }),
    json({ pane: { pane_id: "w1:p2", terminal_id: "term_9" } }),
    json({ layout: { panes: [] } }),
  ]);
  const client = new HerdrClient({ binary: "herdr", runner: fake.runner, sessionName: "work", socketPath: "/run/m/herdr.sock" });
  await client.snapshot();
  assert.deepEqual(fake.calls[0].args, ["api", "snapshot"], "no --session: the socket names the server");
  assert.equal(fake.calls[0].options.env.HERDR_SOCKET_PATH, "/run/m/herdr.sock");
  assert.deepEqual(await client.listSessions(), [{ name: "work", default: true, running: true, socket_path: "/run/m/herdr.sock" }]);
  assert.equal(fake.calls.length, 1, "this machine's session list is not asked");
  const target = await client.terminalTarget("w1:p2");
  assert.equal(target.env.HERDR_SOCKET_PATH, "/run/m/herdr.sock");
});

test("a terminal id that could read as an option is refused", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([json({ pane: { pane_id: "w1:p2", terminal_id: "--takeover" } }), json({ layout: { panes: [] } })]);
  const client = new HerdrClient({ runner: fake.runner, socketPath: "/run/m/x.sock" });
  await assert.rejects(client.terminalTarget("w1:p2"), { code: "no_terminal" });
});

test("terminal ids with hyphens, dots or colons inside are taken as they are", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  for (const id of ["term-9", "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", "term_65da1de08bbbc11", "w1:t2.p3"]) {
    const fake = recordingRunner([json({ pane: { pane_id: "w1:p2", terminal_id: id } }), json({ layout: { panes: [] } })]);
    const client = new HerdrClient({ runner: fake.runner, socketPath: "/run/m/x.sock" });
    assert.equal((await client.terminalTarget("w1:p2")).terminalId, id);
  }
});

test("asks herdr for a pane's processes, by a validated pane id", async () => {
  const info = { process_info: { pane_id: "w1:p2", shell_pid: 10, foreground_processes: [{ pid: 11, argv: ["codex"] }] } };
  const fake = recordingRunner([{ stdout: JSON.stringify({ id: "cli:pane", result: info }), stderr: "" }]);
  const client = new HerdrClient({ binary: "/opt/herdr", runner: fake.runner });
  assert.deepEqual(await client.paneProcessInfo("w1:p2"), info);
  assert.deepEqual(fake.calls[0].args, ["pane", "process-info", "--pane", "w1:p2"]);
  await assert.rejects(client.paneProcessInfo("--current"), InputValidationError);
  assert.equal(fake.calls.length, 1);
});

const jsonReply = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
const layoutOf = (...panes) => jsonReply({ layout: { panes: panes.map(([pane_id, x, y, width, height]) => ({ pane_id, rect: { x, y, width, height } })) } });

test("splits a pane in its own folder after checking the tab has room", async () => {
  const fake = recordingRunner([
    jsonReply({ pane: { pane_id: "w1:p1", cwd: "/work/app" } }),
    jsonReply({ pane: { pane_id: "w1:p2" } }),
  ]);
  const client = new HerdrClient({ runner: fake.runner });
  assert.deepEqual(await client.splitPane("w1:p1", "right"), { pane_id: "w1:p2" });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "get", "w1:p1"],
    ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/work/app", "--no-focus"],
  ]);
  await assert.rejects(client.splitPane("w1:p1", "left"), InputValidationError);
  await assert.rejects(client.splitPane("--current", "right"), InputValidationError);
});

test("a pane that cannot be read first is not split, and Herdr's reason reaches the caller", async () => {
  const fake = recordingRunner([
    Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code: "pane_get_failed", message: "no such pane" } }) }),
    jsonReply({ pane: { pane_id: "w1:p2" } }),
  ]);
  const client = new HerdrClient({ runner: fake.runner });
  await assert.rejects(client.splitPane("w1:p1", "down"), { code: "pane_get_failed", message: "no such pane" });
  assert.deepEqual(fake.calls.map((call) => call.args), [["pane", "get", "w1:p1"]], "no split is asked for");
});

test("what Herdr refuses in a split reaches the caller with Herdr's own code", async () => {
  const refused = Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code: "pane_split_failed", message: "no room to split" } }) });
  const fake = recordingRunner([jsonReply({ pane: { pane_id: "w1:p1", cwd: "/x" } }), refused]);
  await assert.rejects(new HerdrClient({ runner: fake.runner }).splitPane("w1:p1", "right"), { code: "pane_split_failed", message: "no room to split" });
});

test("closes and zooms a pane by validated id", async () => {
  const fake = recordingRunner([{ stdout: "", stderr: "" }, { stdout: "", stderr: "" }]);
  const client = new HerdrClient({ runner: fake.runner });
  await client.closePane("w1:p2");
  await client.zoomPane("w1:p2");
  assert.deepEqual(fake.calls.map((call) => call.args), [["pane", "close", "w1:p2"], ["pane", "zoom", "--pane", "w1:p2", "--toggle"]]);
  await assert.rejects(client.closePane("nope"), InputValidationError);
});

test("moves a lone pane beside another, swapping for left and up", async () => {
  const info = (pane_id, tab_id) => jsonReply({ pane: { pane_id, tab_id } });
  const run = (side, extra = []) => {
    const fake = recordingRunner([
      info("w1:p5", "w1:t2"), info("w1:p1", "w1:t1"), layoutOf(["w1:p5", 0, 0, 100, 40]),
      jsonReply({ pane: { pane_id: "w1:p6", tab_id: "w1:t1" } }), ...extra,
    ]);
    return { fake, client: new HerdrClient({ runner: fake.runner }) };
  };
  const right = run("right");
  assert.deepEqual(await right.client.movePaneSplit("w1:p5", "w1:p1", "right"), { pane_id: "w1:p6" });
  assert.deepEqual(right.fake.calls.at(-1).args, ["pane", "move", "w1:p5", "--tab", "w1:t1", "--split", "right", "--target-pane", "w1:p1", "--no-focus"]);
  const up = run("up", [{ stdout: "", stderr: "" }]);
  assert.deepEqual(await up.client.movePaneSplit("w1:p5", "w1:p1", "up"), { pane_id: "w1:p6" });
  assert.deepEqual(up.fake.calls.at(-2).args.slice(5, 7), ["--split", "down"]);
  assert.deepEqual(up.fake.calls.at(-1).args, ["pane", "swap", "--pane", "w1:p6", "--direction", "up"]);
  // The move has happened when the swap fails: the new id still comes back.
  const refused = Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code: "pane_swap_failed", message: "no pane to the left" } }) });
  const left = run("left", [refused]);
  assert.deepEqual(await left.client.movePaneSplit("w1:p5", "w1:p1", "left"), { pane_id: "w1:p6", placed: false, message: "no pane to the left" });
});

test("a pane moves only when alone in its tab and dropped on another pane", async () => {
  const info = (pane_id, tab_id) => jsonReply({ pane: { pane_id, tab_id } });
  const split = recordingRunner([info("w1:p5", "w1:t2"), info("w1:p1", "w1:t1"), layoutOf(["w1:p5", 0, 0, 5, 5], ["w1:p8", 5, 0, 5, 5])]);
  await assert.rejects(new HerdrClient({ runner: split.runner }).movePaneSplit("w1:p5", "w1:p1", "right"), { code: "split_session" });
  assert.equal(split.calls.length, 3);
  const same = recordingRunner([]);
  await assert.rejects(new HerdrClient({ runner: same.runner }).movePaneSplit("w1:p5", "w1:p5", "right"), InputValidationError);
  await assert.rejects(new HerdrClient({ runner: same.runner }).movePaneSplit("w1:p5", "w1:p1", "middle"), InputValidationError);
  assert.equal(same.calls.length, 0);
});

// A tab's layout as `pane layout` answers it, with its tab and project.
const tabLayout = (panes, extra = {}) => jsonReply({ layout: {
  tab_id: "w1:t1", workspace_id: "w1", zoomed: false, ...extra,
  panes: panes.map((pane_id, index) => ({ pane_id, rect: { x: index * 40, y: 0, width: 40, height: 40 } })),
} });
const herdrRefusal = (code, message) => Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code, message } }) });
const done = { stdout: "", stderr: "" };

test("two panes of one tab trade places", async () => {
  const fake = recordingRunner([tabLayout(["w1:p1", "w1:p2", "w1:p3"]), done]);
  assert.deepEqual(await new HerdrClient({ runner: fake.runner }).swapPanes("w1:p1", "w1:p3"), { pane_id: "w1:p1" });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "layout", "--pane", "w1:p1"],
    ["pane", "swap", "--source-pane", "w1:p1", "--target-pane", "w1:p3"],
  ]);
});

test("panes are swapped or relocated only within one unzoomed tab, never onto themselves", async () => {
  const none = recordingRunner([]);
  const client = new HerdrClient({ runner: none.runner });
  await assert.rejects(client.swapPanes("w1:p1", "w1:p1"), InputValidationError);
  await assert.rejects(client.relocatePane("w1:p1", "w1:p1", "left"), InputValidationError);
  await assert.rejects(client.relocatePane("w1:p1", "w1:p2", "middle"), InputValidationError);
  await assert.rejects(client.swapPanes("w1:p1", "--help"), InputValidationError);
  assert.equal(none.calls.length, 0, "nothing is asked of Herdr");
  // Another tab's pane.
  const apart = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), tabLayout(["w1:p1", "w1:p2"])]);
  await assert.rejects(new HerdrClient({ runner: apart.runner }).swapPanes("w1:p1", "w1:p9"), InputValidationError);
  await assert.rejects(new HerdrClient({ runner: apart.runner }).relocatePane("w1:p1", "w1:p9", "right"), InputValidationError);
  assert.equal(apart.calls.length, 2, "only the layout was read");
  // A zoomed tab.
  const zoomed = recordingRunner([tabLayout(["w1:p1", "w1:p2"], { zoomed: true }), tabLayout(["w1:p1", "w1:p2"], { zoomed: true })]);
  await assert.rejects(new HerdrClient({ runner: zoomed.runner }).swapPanes("w1:p1", "w1:p2"), /Unzoom/u);
  await assert.rejects(new HerdrClient({ runner: zoomed.runner }).relocatePane("w1:p1", "w1:p2", "down"), /Unzoom/u);
  assert.equal(zoomed.calls.length, 2);
  // A swap Herdr refuses says Herdr's reason.
  const refused = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), herdrRefusal("pane_swap_failed", "cannot swap")]);
  await assert.rejects(new HerdrClient({ runner: refused.runner }).swapPanes("w1:p1", "w1:p2"), { code: "pane_swap_failed", message: "cannot swap" });
});

test("a pane relocates within its tab by leaving it and splitting back in beside the target", async () => {
  const lifted = jsonReply({ move_result: { changed: true, pane: { pane_id: "w1:p1", tab_id: "w1:t7" }, created_tab: { tab_id: "w1:t7" } } });
  const back = jsonReply({ move_result: { changed: true, pane: { pane_id: "w1:p1", tab_id: "w1:t1" } } });
  const right = recordingRunner([tabLayout(["w1:p1", "w1:p2", "w1:p3"]), lifted, back]);
  assert.deepEqual(await new HerdrClient({ runner: right.runner }).relocatePane("w1:p1", "w1:p3", "right"), { pane_id: "w1:p1" });
  assert.deepEqual(right.calls.map((call) => call.args), [
    ["pane", "layout", "--pane", "w1:p1"],
    ["pane", "move", "w1:p1", "--new-tab", "--workspace", "w1", "--no-focus"],
    ["pane", "move", "w1:p1", "--tab", "w1:t1", "--split", "right", "--target-pane", "w1:p3", "--no-focus"],
  ]);
  // Up is down and then a swap up.
  const up = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), lifted, back, done]);
  assert.deepEqual(await new HerdrClient({ runner: up.runner }).relocatePane("w1:p1", "w1:p2", "up"), { pane_id: "w1:p1" });
  assert.deepEqual(up.calls.at(-2).args.slice(5, 7), ["--split", "down"]);
  assert.deepEqual(up.calls.at(-1).args, ["pane", "swap", "--pane", "w1:p1", "--direction", "up"]);
  // A swap that fails after the move: the pane is beside the target, on the other side.
  const left = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), lifted, back, herdrRefusal("pane_swap_failed", "no pane to the left")]);
  assert.deepEqual(await new HerdrClient({ runner: left.runner }).relocatePane("w1:p1", "w1:p2", "left"),
    { pane_id: "w1:p1", placed: false, message: "no pane to the left" });
  // Herdr's answer names the pane under a new id: that is the one returned.
  const renamed = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), lifted,
    jsonReply({ move_result: { pane: { pane_id: "w1:p8", tab_id: "w1:t1" } } })]);
  assert.deepEqual(await new HerdrClient({ runner: renamed.runner }).relocatePane("w1:p1", "w1:p2", "down"), { pane_id: "w1:p8" });
  // Without a tab or project in the layout, the pane's own record says them.
  const bare = recordingRunner([
    jsonReply({ layout: { panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] } }),
    jsonReply({ pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } }), lifted, back,
  ]);
  assert.deepEqual(await new HerdrClient({ runner: bare.runner }).relocatePane("w1:p1", "w1:p2", "right"), { pane_id: "w1:p1" });
  assert.deepEqual(bare.calls[1].args, ["pane", "get", "w1:p1"]);
});

test("a relocate whose lift fails leaves the pane where it was and says why", async () => {
  const fake = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), herdrRefusal("pane_move_failed", "cannot move")]);
  await assert.rejects(new HerdrClient({ runner: fake.runner }).relocatePane("w1:p1", "w1:p2", "right"), { code: "pane_move_failed", message: "cannot move" });
  assert.equal(fake.calls.length, 2, "nothing more is tried");
});

test("a relocate that cannot split back in puts the pane back in its tab, or says it is alone now", async () => {
  const lifted = jsonReply({ move_result: { pane: { pane_id: "w1:p1", tab_id: "w1:t7" }, created_tab: { tab_id: "w1:t7" } } });
  const full = () => herdrRefusal("pane_split_failed", "There is no room to split this pane.");
  // Back beside a neighbour that was not the target.
  const restored = recordingRunner([tabLayout(["w1:p1", "w1:p2", "w1:p3"]), lifted, full(),
    jsonReply({ move_result: { pane: { pane_id: "w1:p1", tab_id: "w1:t1" } } })]);
  assert.deepEqual(await new HerdrClient({ runner: restored.runner }).relocatePane("w1:p1", "w1:p3", "left"), {
    pane_id: "w1:p1", placed: false, restored: true,
    message: "There is no room to split this pane. The pane was put back in its session.",
  });
  assert.deepEqual(restored.calls.at(-1).args, ["pane", "move", "w1:p1", "--tab", "w1:t1", "--split", "right", "--target-pane", "w1:p2", "--no-focus"]);
  assert.equal(restored.calls.filter((call) => call.args[1] === "swap").length, 0, "no swap after a failed placement");
  // Of two panes, the target is the only neighbour: it is tried right, then down.
  const second = recordingRunner([tabLayout(["w1:p1", "w1:p2"]), lifted, full(), full(),
    jsonReply({ move_result: { pane: { pane_id: "w1:p1", tab_id: "w1:t1" } } })]);
  const answer = await new HerdrClient({ runner: second.runner }).relocatePane("w1:p1", "w1:p2", "right");
  assert.equal(answer.restored, true);
  assert.deepEqual(second.calls.at(-1).args.slice(5, 9), ["--split", "down", "--target-pane", "w1:p2"]);
  // Nothing takes it back: it stays in the session it was lifted into, and says so.
  const stranded = recordingRunner([tabLayout(["w1:p1", "w1:p2", "w1:p3"]), lifted, full(), full(), full(), full(), full()]);
  assert.deepEqual(await new HerdrClient({ runner: stranded.runner }).relocatePane("w1:p1", "w1:p3", "down"), {
    pane_id: "w1:p1", placed: false, restored: false, tab_id: "w1:t7",
    message: "There is no room to split this pane. The pane is in a session of its own now.",
  });
  assert.equal(stranded.calls.length, 7, "the target and its one other neighbour, each right and down");
});

// Two columns of a 120-wide tab, the border at `at`.
const columns = (at, extra = {}) => jsonReply({ layout: { area: { x: 0, y: 0, width: 120, height: 40 }, zoomed: false, ...extra,
  panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: at, height: 40 } }, { pane_id: "w1:p2", rect: { x: at, y: 0, width: 120 - at, height: 40 } }] } });

test("a tab's panes are evened out one resize at a time, the layout read after each", async () => {
  const fake = recordingRunner([columns(90), done, columns(60)]);
  assert.deepEqual(await new HerdrClient({ runner: fake.runner }).evenLayout("w1:p1"), { pane_id: "w1:p1", changed: true, steps: 1, even: true });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "layout", "--pane", "w1:p1"],
    ["pane", "resize", "--pane", "w1:p2", "--direction", "left", "--amount", "0.2500"],
    ["pane", "layout", "--pane", "w1:p1"],
  ]);
  // Already even: nothing is resized.
  const even = recordingRunner([columns(61)]);
  assert.deepEqual(await new HerdrClient({ runner: even.runner }).evenLayout("w1:p2"), { pane_id: "w1:p2", changed: false, steps: 0, even: true });
  assert.equal(even.calls.length, 1);
});

test("a zoomed tab, a lone pane and a bad id are not evened out", async () => {
  const none = recordingRunner([]);
  await assert.rejects(new HerdrClient({ runner: none.runner }).evenLayout("--help"), InputValidationError);
  assert.equal(none.calls.length, 0);
  const zoomed = recordingRunner([columns(90, { zoomed: true })]);
  await assert.rejects(new HerdrClient({ runner: zoomed.runner }).evenLayout("w1:p1"), /Unzoom/u);
  const alone = recordingRunner([layoutOf(["w1:p1", 0, 0, 120, 40])]);
  await assert.rejects(new HerdrClient({ runner: alone.runner }).evenLayout("w1:p1"), { code: "split_session" });
  assert.equal(zoomed.calls.length + alone.calls.length, 2, "only the layout was read");
  // Panes that do not tile as splits: said, and nothing moved.
  const gap = recordingRunner([layoutOf(["w1:p1", 0, 0, 50, 40], ["w1:p2", 60, 0, 60, 40])]);
  const answer = await new HerdrClient({ runner: gap.runner }).evenLayout("w1:p1");
  assert.equal(answer.even, false);
  assert.equal(answer.changed, false);
  assert.match(answer.message, /not made of splits/u);
});

test("an even-out that Herdr will not take further stops where it got, or goes back when that is worse", async () => {
  // A resize that moves nothing: it stops, closer than it began, and says so.
  const stuck = recordingRunner([columns(90), done, columns(80), done, columns(80)]);
  const answer = await new HerdrClient({ runner: stuck.runner }).evenLayout("w1:p1");
  assert.deepEqual({ ...answer, message: undefined }, { pane_id: "w1:p1", changed: true, steps: 2, even: false, message: undefined });
  assert.match(answer.message, /could not all be evened out/u);
  assert.equal(stuck.calls.length, 5, "no way back is tried");
  // Overshot, then refused: the border goes back to where it was.
  const refused = recordingRunner([columns(70), done, columns(40), herdrRefusal("pane_resize_failed", "cannot resize"), columns(40), done, columns(70)]);
  const back = await new HerdrClient({ runner: refused.runner }).evenLayout("w1:p1");
  assert.equal(back.even, false);
  assert.equal(back.restored, true);
  assert.equal(back.steps, 2);
  assert.match(back.message, /cannot resize\. They were moved back/u);
  assert.deepEqual(refused.calls.at(-2).args, ["pane", "resize", "--pane", "w1:p1", "--direction", "right", "--amount", "0.2500"]);
});

test("an even-out stops at its cap of resizes", async () => {
  // A Herdr that moves the border one cell per resize, however far it is asked.
  const wide = (at) => jsonReply({ layout: { area: { x: 0, y: 0, width: 400, height: 40 }, zoomed: false, panes: [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: at, height: 40 } }, { pane_id: "w1:p2", rect: { x: at, y: 0, width: 400 - at, height: 40 } }] } });
  const slow = [wide(390)];
  for (let at = 389; at > 300; at -= 1) slow.push(done, wide(at));
  const fake = recordingRunner(slow);
  const capped = await new HerdrClient({ runner: fake.runner }).evenLayout("w1:p1");
  assert.equal(fake.calls.filter((call) => call.args[1] === "resize").length, 60, "no more than 60 resizes");
  assert.equal(capped.steps, 60);
  assert.equal(capped.even, false);
  assert.match(capped.message, /too many steps/u);
});

test("moves a pane out of its split session into a tab of its own, returning what Herdr names", async () => {
  const fake = recordingRunner([
    layoutOf(["w1:p5", 0, 0, 50, 40], ["w1:p6", 50, 0, 50, 40]),
    jsonReply({ move_result: { pane: { pane_id: "w1:p5", tab_id: "w1:t4" }, created_tab: { tab_id: "w1:t4" } } }),
  ]);
  const client = new HerdrClient({ runner: fake.runner });
  assert.deepEqual(await client.movePaneOut("w1:p5"), { pane_id: "w1:p5", tab_id: "w1:t4" });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["pane", "layout", "--pane", "w1:p5"],
    ["pane", "move", "w1:p5", "--new-tab", "--no-focus"],
  ]);
  // Should Herdr give the pane a new id, that is the one that comes back.
  const renamed = recordingRunner([
    layoutOf(["w1:p5", 0, 0, 50, 40], ["w1:p6", 50, 0, 50, 40]),
    jsonReply({ move_result: { pane: { pane_id: "w1:p9", tab_id: "w1:t4" } } }),
  ]);
  assert.deepEqual(await new HerdrClient({ runner: renamed.runner }).movePaneOut("w1:p5"), { pane_id: "w1:p9", tab_id: "w1:t4" });
  const garbled = recordingRunner([layoutOf(["w1:p5", 0, 0, 5, 5], ["w1:p6", 5, 0, 5, 5]), jsonReply({ move_result: {} })]);
  await assert.rejects(new HerdrClient({ runner: garbled.runner }).movePaneOut("w1:p5"), { code: "invalid_herdr_response" });
});

test("a pane alone in its tab is not moved out, and a bad id asks Herdr nothing", async () => {
  const alone = recordingRunner([layoutOf(["w1:p5", 0, 0, 100, 40])]);
  await assert.rejects(new HerdrClient({ runner: alone.runner }).movePaneOut("w1:p5"), { code: "split_session" });
  assert.equal(alone.calls.length, 1, "only the layout is read");
  const none = recordingRunner([]);
  await assert.rejects(new HerdrClient({ runner: none.runner }).movePaneOut("--new-tab"), InputValidationError);
  await assert.rejects(new HerdrClient({ runner: none.runner }).movePaneOut("w1:t1"), InputValidationError);
  assert.equal(none.calls.length, 0);
});
