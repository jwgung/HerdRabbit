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
