import test from "node:test";
import assert from "node:assert/strict";
import { nodePtySpawner } from "../src/pane-attachments.mjs";

// node-pty's interface, as the spawner uses it.
function fakePty({ exitOnKill = true } = {}) {
  const made = [];
  const pty = {
    spawn(command, args, options) {
      const term = {
        command, args, options, written: [], sizes: [], kills: [], paused: 0, resumed: 0,
        onData(listener) { this.data = listener; },
        onExit(listener) { this.exit = listener; },
        write(data) { this.written.push(data); },
        resize(cols, rows) { this.sizes.push([cols, rows]); },
        pause() { this.paused += 1; },
        resume() { this.resumed += 1; },
        kill(signal = "SIGHUP") { this.kills.push(signal); if (exitOnKill || signal === "SIGKILL") this.exit({ exitCode: 0 }); },
      };
      made.push(term);
      return term;
    },
  };
  return { pty, made };
}

test("the spawner runs the attach on a pty and passes its output, size, flow and exit through", async () => {
  const { pty, made } = fakePty();
  const output = [];
  const exits = [];
  const session = nodePtySpawner(pty)({
    command: "herdr", args: ["terminal", "attach", "term_1"], env: { HERDR_SOCKET_PATH: "/sock" }, cols: 100, rows: 30,
    onData: (data) => output.push(data), onExit: (code) => exits.push(code),
  });
  const term = made[0];
  assert.deepEqual([term.command, term.args], ["herdr", ["terminal", "attach", "term_1"]]);
  assert.equal(term.options.env.HERDR_SOCKET_PATH, "/sock");
  assert.equal(term.options.env.TERM, "xterm-256color");
  assert.deepEqual([term.options.cols, term.options.rows], [100, 30]);
  term.data("screen");
  assert.deepEqual(output, ["screen"]);
  session.write("ls\r");
  session.resize(90, 25);
  session.pause();
  session.pause();
  session.resume();
  assert.deepEqual(term.written, ["ls\r"]);
  assert.deepEqual(term.sizes, [[90, 25]]);
  assert.deepEqual([term.paused, term.resumed], [1, 1], "pausing twice pauses once");
  session.kill();
  await session.exited;
  assert.deepEqual(exits, [0]);
  session.write("after");
  session.resize(10, 10);
  session.kill();
  assert.deepEqual(term.written, ["ls\r"], "nothing reaches a pty that has exited");
  assert.deepEqual(term.kills, ["SIGHUP"]);
});

test("an attach that ignores the hangup is killed outright", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, made } = fakePty({ exitOnKill: false });
  const session = nodePtySpawner(pty)({ command: "herdr", args: [], env: {}, cols: 80, rows: 24, onData() {}, onExit() {} });
  session.kill();
  assert.deepEqual(made[0].kills, ["SIGHUP"]);
  context.mock.timers.tick(2000);
  assert.deepEqual(made[0].kills, ["SIGHUP", "SIGKILL"]);
  await session.exited;
});
