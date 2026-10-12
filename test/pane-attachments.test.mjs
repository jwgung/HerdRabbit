import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "../src/output-window.mjs";

const HELD = "\x1b[?1049l\x1b[?25h\x1b[0 qherdr: terminal attach failed: terminal term_1 already has an attached client; retry with --takeover\r\n";
const RACE = "herdr: terminal attach failed: terminal term_1 has a read in progress; retry\r\n";
const TAKEN = "\x1b[?1049l\x1b[?25h\x1b[0 qherdr: server shut down: terminal attach taken over\r\n";

// Each spawn is one `herdr terminal attach`; the test plays herdr's part.
function fakeHerdr() {
  const spawns = [];
  const spawnPty = (options) => {
    let resolveExit;
    const pty = {
      options, written: [], sizes: [], paused: false, killed: false,
      exited: new Promise((resolve) => { resolveExit = resolve; }),
      write(data) { this.written.push(data); },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      pause() { this.paused = true; },
      resume() { this.paused = false; },
      kill() { if (!this.killed) { this.killed = true; resolveExit(); } },
      emit(data) { options.onData(data); },
      exit(code) { this.killed = true; resolveExit(); options.onExit(code); },
    };
    spawns.push(pty);
    return pty;
  };
  return { spawns, spawnPty };
}

function client(mode = "interact") {
  return {
    mode, closed: false, messages: [], buffered: 0,
    send(message) { this.messages.push(message); },
    bufferedAmount() { return this.buffered; },
    close(code) { this.closed = code; },
    types() { return this.messages.map((message) => message.type); },
    output() { return this.messages.filter((message) => message.type === "pty-data").map((message) => message.data).join(""); },
  };
}

function setup({ terminals = ["term_1"], resolve } = {}) {
  const herdr = fakeHerdr();
  let lookups = 0;
  const resolveTerminal = resolve ?? (async () => {
    const terminalId = terminals[Math.min(lookups++, terminals.length - 1)];
    return { command: "herdr", args: ["terminal", "attach", terminalId], env: { HERDR_SOCKET_PATH: "/sock" }, terminalId, cols: 120, rows: 40 };
  });
  const attachments = new PaneAttachments({
    resolveTerminal, spawnPty: herdr.spawnPty, log: () => {},
    options: { holdMs: 5, heldRetryMs: 20, retryMs: 5, retryMaxMs: 10, relookupMs: 5, relookupForMs: 200, refusalExitMs: 50 },
  });
  return { herdr, attachments };
}

test("one attach per pane, shared; a joiner gets the screen so far and an observer cannot type or resize", async () => {
  const { herdr, attachments } = setup();
  const desk = client();
  await attachments.attach(desk, "p", { cols: 100, rows: 30 });
  assert.equal(herdr.spawns.length, 1);
  assert.deepEqual(herdr.spawns[0].options.args, ["terminal", "attach", "term_1"]);
  assert.equal(herdr.spawns[0].options.env.HERDR_SOCKET_PATH, "/sock");
  herdr.spawns[0].emit("\x1b[?1049h");
  herdr.spawns[0].emit("hello");
  await sleep(20);
  assert.ok(desk.types().includes("input-ready"));
  assert.equal(desk.output(), "\x1b[?1049hhello");
  assert.equal(attachments.input(desk, "p", "ls\r"), true);
  assert.deepEqual(herdr.spawns[0].written, ["ls\r"]);

  const phone = client("observe");
  await attachments.attach(phone, "p", { cols: 40, rows: 20 });
  assert.equal(herdr.spawns.length, 1, "the joiner shares the pty");
  assert.equal(phone.output(), "\x1b[?1049hhello");
  assert.deepEqual(phone.messages.at(-1), { type: "pane-geometry", pane_id: "p", cols: 100, rows: 30 });
  assert.equal(attachments.input(phone, "p", "rm\r"), false);
  assert.equal(attachments.resize(phone, "p", 40, 20), false);
  assert.equal(attachments.resize(desk, "p", 90, 25), true);
  assert.deepEqual(herdr.spawns[0].sizes.at(-1), [90, 25]);

  attachments.detach(desk, "p");
  assert.equal(herdr.spawns[0].killed, false, "someone still has it open");
  attachments.detach(phone, "p");
  assert.equal(herdr.spawns[0].killed, true);
});

test("a refused attach is never painted: it waits for the holder, then a takeover takes the slot", async () => {
  const { herdr, attachments } = setup();
  const desk = client();
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit(HELD);
  herdr.spawns[0].exit(1);
  assert.ok(desk.types().includes("attach-held"));
  assert.equal(desk.output(), "", "herdr's refusal is not the pane's output");
  assert.equal(attachments.input(desk, "p", "x"), false);
  await sleep(40);
  assert.equal(herdr.spawns.length, 2, "tried again while someone here wants it");
  assert.deepEqual(herdr.spawns[1].options.args, ["terminal", "attach", "term_1"]);
  herdr.spawns[1].emit(HELD);
  herdr.spawns[1].exit(1);
  assert.equal(attachments.takeOver(desk, "p"), true);
  assert.deepEqual(herdr.spawns.at(-1).options.args, ["terminal", "attach", "term_1", "--takeover"]);
  herdr.spawns.at(-1).emit("screen");
  await sleep(20);
  assert.deepEqual(desk.types().slice(-3), ["attach-resumed", "input-ready", "pty-data"]);
  attachments.close();
});

test("being taken over elsewhere is held too, without herdr's diagnostic on screen", async () => {
  const { herdr, attachments } = setup();
  const desk = client();
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit("screen");
  await sleep(20);
  herdr.spawns[0].emit(TAKEN);
  herdr.spawns[0].exit(1);
  assert.ok(!desk.output().includes("taken over"));
  assert.equal(desk.types().filter((type) => type === "attach-held").length, 1);
  attachments.close();
});

test("an attach that races a read is retried quietly", async () => {
  const { herdr, attachments } = setup();
  const desk = client();
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit(RACE);
  herdr.spawns[0].exit(1);
  await sleep(30);
  assert.equal(herdr.spawns.length, 2);
  assert.ok(!desk.types().includes("attach-held"));
  assert.equal(desk.output(), "");
  attachments.close();
});

test("after a live handoff the same clients follow the pane to its new terminal; a pane that is gone ends", async () => {
  const { herdr, attachments } = setup({ terminals: ["term_1", "term_1", "term_2"] });
  const desk = client();
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit("before");
  await sleep(20);
  herdr.spawns[0].exit(1);
  await sleep(40);
  assert.equal(herdr.spawns.length, 2);
  assert.deepEqual(herdr.spawns[1].options.args, ["terminal", "attach", "term_2"]);
  assert.ok(!desk.types().includes("pty-exit"));

  let gone = false;
  const ended = setup({ resolve: async () => {
    if (gone) throw Object.assign(new Error("pane not found"), { code: "pane_not_found" });
    return { command: "herdr", args: ["terminal", "attach", "term_1"], env: {}, terminalId: "term_1" };
  } });
  const other = client();
  await ended.attachments.attach(other, "q", { cols: 80, rows: 24 });
  gone = true;
  ended.herdr.spawns[0].exit(0);
  await sleep(20);
  assert.deepEqual(other.messages.at(-1), { type: "pty-exit", pane_id: "q", code: 0 });
  attachments.close();
});

test("output stops while a client is behind, and a client that stays behind is dropped", async () => {
  const { herdr, attachments } = setup();
  const desk = client();
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit("ready");
  await sleep(20);
  herdr.spawns[0].emit("x".repeat(OUTPUT_HIGH_BYTES));
  assert.equal(herdr.spawns[0].paused, true);
  const { stream_id: streamId, offset } = desk.messages.at(-1).flow;
  assert.equal(attachments.acknowledge(desk, "p", streamId, offset + 1), false, "credit for bytes never sent");
  assert.equal(attachments.acknowledge(desk, "p", streamId, offset), true);
  assert.equal(herdr.spawns[0].paused, false);

  desk.buffered = 2 * 1024 * 1024;
  herdr.spawns[0].emit("more");
  assert.equal(desk.closed, 4002);
  assert.equal(herdr.spawns[0].killed, true, "nobody left on the pane");
});

test("attaches that arrive together share one lookup and one pty", async () => {
  const { herdr, attachments } = setup();
  const one = client();
  const two = client();
  await Promise.all([attachments.attach(one, "p", { cols: 80, rows: 24 }), attachments.attach(two, "p", { cols: 80, rows: 24 })]);
  assert.equal(herdr.spawns.length, 1);
  await assert.rejects(attachments.attach(one, "r", { cols: 0, rows: 24 }), RangeError);
  attachments.close();
});

test("a client that never acknowledges is dropped even though the paused pty writes nothing more", async () => {
  const { herdr, attachments } = setup();
  const phone = client();
  const desk = client();
  await attachments.attach(phone, "p", { cols: 80, rows: 24 });
  await attachments.attach(desk, "p", { cols: 80, rows: 24 });
  herdr.spawns[0].emit("ready");
  await sleep(20);
  herdr.spawns[0].emit("x".repeat(OUTPUT_HIGH_BYTES));
  const { stream_id: streamId, offset } = desk.messages.at(-1).flow;
  attachments.acknowledge(desk, "p", streamId, offset);
  assert.equal(herdr.spawns[0].paused, true, "the phone is behind");
  await sleep(OUTPUT_STALL_MS + 100);
  assert.equal(phone.closed, 4002);
  assert.equal(herdr.spawns[0].paused, false, "the desk gets output again");
  attachments.close();
});
