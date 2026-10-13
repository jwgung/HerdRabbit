import test from "node:test";
import assert from "node:assert/strict";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import {
  MAX_PENDING_TEXT, PASTE_END, PASTE_START, PendingInputs, bracketedPaste, validatePendingText,
} from "../src/pending-input.mjs";

// A herdr whose panes' agent statuses the test sets, and which notes every
// text and key that reached a pane.
function fakeHerdr(statuses = { "w1:p1": "working" }) {
  const herdr = {
    statuses: { ...statuses },
    screens: {},
    sent: [],
    snapshots: 0,
    failSend: null,
    async snapshot() {
      herdr.snapshots += 1;
      return {
        panes: Object.entries(herdr.statuses).map(([pane_id, agent_status]) => ({ pane_id, agent: "claude", agent_status })),
        agents: [],
      };
    },
    async readPane(paneId) {
      if (herdr.screens[paneId] instanceof Error) throw herdr.screens[paneId];
      return herdr.screens[paneId] ?? "> ";
    },
    async sendText(paneId, text) {
      if (herdr.failSend) throw herdr.failSend;
      herdr.sent.push({ paneId, text });
    },
    async sendKeys(paneId, keys) { herdr.sent.push({ paneId, keys: [...keys] }); },
  };
  return herdr;
}

// The service's own timer is faked (it never fires unless ticked), so each
// look is the test's own `tick()`.
function service(context, herdr, options = {}) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1_000;
  let ids = 0;
  const delivered = [];
  const pending = new PendingInputs({
    herdr, pollMs: 60_000, enterDelayMs: 0, now: () => clock, newId: () => `m${++ids}`,
    onDelivered: (paneId, text) => delivered.push({ paneId, text }), ...options,
  });
  return { pending, delivered, advance: (ms) => { clock += ms; } };
}

const pasted = (paneId, text) => [{ paneId, text: bracketedPaste(text) }, { paneId, keys: ["enter"] }];

test("a message goes as one bracketed paste, then Enter", () => {
  assert.equal(bracketedPaste("line one\nline two"), "\x1b[200~line one\nline two\x1b[201~");
  assert.equal(PASTE_START, "\x1b[200~");
  assert.equal(PASTE_END, "\x1b[201~");
  // the marks count toward herdr's 8000 characters
  assert.equal(MAX_PENDING_TEXT + PASTE_START.length + PASTE_END.length, 8000);
});

test("queued text: newlines and tabs stay, other control characters and empty or long text are refused", () => {
  assert.equal(validatePendingText("a\r\nb\tc"), "a\nb\tc");
  for (const bad of ["", "   \n", "x\x1b[201~y", "bell\x07", "nul\0", "csi\x9b", 42, null, "x".repeat(MAX_PENDING_TEXT + 1)]) {
    assert.throws(() => validatePendingText(bad), (error) => error.code === "invalid_text", JSON.stringify(bad));
  }
  assert.equal(validatePendingText("x".repeat(MAX_PENDING_TEXT)).length, MAX_PENDING_TEXT);
});

test("messages wait while the agent works and go one per turn, in order, once it is ready", async (context) => {
  const herdr = fakeHerdr();
  const { pending, delivered } = service(context, herdr);
  const heard = [];
  pending.watch("w1:p1", (message) => heard.push(message));
  await pending.enqueue("w1:p1", "first");
  await pending.enqueue("w1:p1", "second");
  assert.deepEqual(pending.list("w1:p1").map((item) => [item.text, item.state]), [["first", "queued"], ["second", "queued"]]);
  await pending.tick();
  assert.deepEqual(herdr.sent, [], "nothing goes while the agent works");

  herdr.statuses["w1:p1"] = "idle";
  await pending.tick();
  assert.deepEqual(herdr.sent, pasted("w1:p1", "first"));
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["second"]);
  assert.deepEqual(delivered, [{ paneId: "w1:p1", text: "first" }]);
  assert.deepEqual(heard.at(-1).removed, [{ id: "m1", outcome: "sent", text: "first" }]);
  assert.ok(heard.some((message) => message.items[0]?.state === "sending"), "the head shows as sending while it goes");

  // still idle (the agent has not taken it yet): the turn gate holds the next one
  await pending.tick();
  assert.equal(herdr.sent.length, 2);
  herdr.statuses["w1:p1"] = "working";
  await pending.tick();
  herdr.statuses["w1:p1"] = "done";
  await pending.tick();
  assert.deepEqual(herdr.sent, [...pasted("w1:p1", "first"), ...pasted("w1:p1", "second")]);
  assert.deepEqual(pending.list("w1:p1"), []);
});

test("the turn gate opens after its timeout when the agent never shows it worked", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "idle" });
  const { pending, advance } = service(context, herdr, { turnTimeoutMs: 10_000 });
  await pending.enqueue("w1:p1", "one");
  await pending.enqueue("w1:p1", "two");
  await pending.tick();
  assert.equal(herdr.sent.length, 2);
  advance(9_999);
  await pending.tick();
  assert.equal(herdr.sent.length, 2, "not before the timeout");
  advance(1);
  await pending.tick();
  assert.deepEqual(herdr.sent.slice(2), pasted("w1:p1", "two"));
});

test("a status from the stream counts at once: working closes the gate, ready delivers", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "idle" });
  const { pending } = service(context, herdr);
  await pending.enqueue("w1:p1", "one");
  await pending.enqueue("w1:p1", "two");
  await pending.tick();
  assert.equal(herdr.sent.length, 2);
  // a short turn the snapshot never saw: the stream did
  pending.status("w1:p1", "working");
  herdr.statuses["w1:p1"] = "idle";
  await pending.tick();
  assert.deepEqual(herdr.sent.slice(2), pasted("w1:p1", "two"));
  pending.status("w9:p9", "idle"); // a pane with no queue is not kept
  assert.equal(pending.panes.has("w9:p9"), false);
});

test("nothing is delivered while the pane is blocked on a card or shows a password prompt", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "blocked" });
  const { pending } = service(context, herdr);
  await pending.enqueue("w1:p1", "after the card");
  await pending.tick();
  assert.deepEqual(herdr.sent, []);
  herdr.statuses["w1:p1"] = "idle";
  herdr.screens["w1:p1"] = "Running sudo\n[sudo] password for me:";
  await pending.tick();
  assert.deepEqual(herdr.sent, [], "a password prompt is never answered with a queued message");
  herdr.screens["w1:p1"] = new Error("cannot read");
  await pending.tick();
  assert.deepEqual(herdr.sent, [], "a screen that cannot be read might be asking");
  herdr.screens["w1:p1"] = "> ";
  await pending.tick();
  assert.deepEqual(herdr.sent, pasted("w1:p1", "after the card"));
});

test("an answer to a password prompt is never queued", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "working" });
  herdr.screens["w1:p1"] = "Password:";
  const { pending } = service(context, herdr);
  await assert.rejects(pending.enqueue("w1:p1", "hunter2"), (error) => error.code === "secret_prompt" && error.status === 409);
  assert.deepEqual(pending.list("w1:p1"), []);
  await assert.rejects(pending.enqueue("w9:p9", "nobody"), (error) => error.code === "pane_not_found");
});

test("a message that fails to go is marked failed and holds the queue until retried or removed", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "idle" });
  const { pending } = service(context, herdr);
  await pending.enqueue("w1:p1", "one");
  await pending.enqueue("w1:p1", "two");
  herdr.failSend = new Error("herdr is gone");
  await pending.tick();
  assert.deepEqual(pending.list("w1:p1"), [
    { id: "m1", text: "one", state: "failed", error: "herdr is gone" },
    { id: "m2", text: "two", state: "queued" },
  ]);
  herdr.failSend = null;
  await pending.tick();
  assert.deepEqual(herdr.sent, [], "the failed one holds the others");
  assert.throws(() => pending.edit("w1:p1", "m1", "x"), (error) => error.code === "pending_not_queued");
  pending.retry("w1:p1", "m1");
  assert.equal(pending.list("w1:p1")[0].state, "queued");
  await pending.tick();
  assert.deepEqual(herdr.sent, pasted("w1:p1", "one"));

  herdr.failSend = new Error("again");
  pending.status("w1:p1", "working");
  pending.status("w1:p1", "idle");
  await pending.tick();
  assert.equal(pending.list("w1:p1")[0].state, "failed");
  pending.cancel("w1:p1", "m2");
  assert.deepEqual(pending.list("w1:p1"), []);
  assert.throws(() => pending.retry("w1:p1", "m2"), (error) => error.code === "pending_not_found");
});

test("a waiting message can be cancelled, edited and moved; nothing passes one on its way", async (context) => {
  const herdr = fakeHerdr();
  const { pending } = service(context, herdr);
  for (const text of ["a", "b", "c"]) await pending.enqueue("w1:p1", text);
  pending.move("w1:p1", "m3", -1);
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["a", "c", "b"]);
  pending.move("w1:p1", "m1", -1); // already first
  pending.move("w1:p1", "m1", 1);
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["c", "a", "b"]);
  pending.edit("w1:p1", "m1", "A\nmore");
  assert.throws(() => pending.edit("w1:p1", "m1", "\x1b"), (error) => error.code === "invalid_text");
  pending.cancel("w1:p1", "m2");
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["c", "A\nmore"]);
  assert.throws(() => pending.cancel("w1:p1", "nope"), (error) => error.status === 404);
  assert.throws(() => pending.cancel("w1:p2", "m1"), (error) => error.status === 404, "ids belong to their pane");

  // while the head goes, it can be neither cancelled nor passed
  let release;
  herdr.sendText = async (paneId, text) => { herdr.sent.push({ paneId, text }); await new Promise((resolve) => { release = resolve; }); };
  herdr.statuses["w1:p1"] = "idle";
  const ticking = pending.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.list("w1:p1")[0].state, "sending");
  assert.throws(() => pending.cancel("w1:p1", "m3"), (error) => error.code === "pending_sending");
  pending.move("w1:p1", "m1", -1);
  assert.deepEqual(pending.list("w1:p1").map((item) => item.id), ["m3", "m1"]);
  release();
  await ticking;
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["A\nmore"]);
});

test("at most 20 messages wait in one pane", async (context) => {
  const herdr = fakeHerdr();
  const { pending } = service(context, herdr);
  for (let index = 0; index < 20; index += 1) await pending.enqueue("w1:p1", `m${index}`);
  await assert.rejects(pending.enqueue("w1:p1", "one more"), (error) => error.code === "pending_limit");
  herdr.statuses["w1:p2"] = "working";
  await pending.enqueue("w1:p2", "another pane has its own");
});

test("each pane has its own queue and its own turn", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "working", "w1:p2": "idle" });
  const { pending } = service(context, herdr);
  const heard = { "w1:p1": [], "w1:p2": [] };
  pending.watch("w1:p1", (message) => heard["w1:p1"].push(message.items.length));
  pending.watch("w1:p2", (message) => heard["w1:p2"].push(message.items.length));
  await pending.enqueue("w1:p1", "for one");
  await pending.enqueue("w1:p2", "for two");
  await pending.tick();
  assert.deepEqual(herdr.sent, pasted("w1:p2", "for two"));
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["for one"]);
  assert.deepEqual(heard["w1:p1"], [0, 1]);
  assert.ok(heard["w1:p2"].at(-1) === 0);
  assert.equal(herdr.snapshots, 3, "one snapshot per look for every pane (and one per enqueue)");
});

test("send now goes at once, past the queue and the agent's work, but not into a card or a password", async (context) => {
  const herdr = fakeHerdr({ "w1:p1": "working" });
  const { pending, delivered } = service(context, herdr);
  await pending.enqueue("w1:p1", "first");
  await pending.enqueue("w1:p1", "urgent");
  await pending.sendNow("w1:p1", "m2");
  assert.deepEqual(herdr.sent, pasted("w1:p1", "urgent"));
  assert.deepEqual(pending.list("w1:p1").map((item) => item.text), ["first"]);
  assert.deepEqual(delivered, [{ paneId: "w1:p1", text: "urgent" }]);
  herdr.statuses["w1:p1"] = "blocked";
  await assert.rejects(pending.sendNow("w1:p1", "m1"), (error) => error.code === "pane_blocked");
  herdr.statuses["w1:p1"] = "idle";
  herdr.screens["w1:p1"] = "Enter passphrase for key '/home/me/.ssh/id':";
  await assert.rejects(pending.sendNow("w1:p1", "m1"), (error) => error.code === "secret_prompt");
  herdr.screens["w1:p1"] = "> ";
  herdr.failSend = new Error("lost");
  await assert.rejects(pending.sendNow("w1:p1", "m1"), (error) => error.code === "send_failed");
  assert.equal(pending.list("w1:p1")[0].state, "failed");
  herdr.failSend = null;
  await pending.sendNow("w1:p1", "m1");
  assert.deepEqual(pending.list("w1:p1"), []);
});

test("a watcher hears the list at once, and a pane with nothing left is let go", async (context) => {
  const herdr = fakeHerdr();
  const { pending } = service(context, herdr);
  await pending.enqueue("w1:p1", "kept");
  const heard = [];
  const stop = pending.watch("w1:p1", (message) => heard.push(message));
  assert.deepEqual(heard, [{ items: [{ id: "m1", text: "kept", state: "queued" }] }]);
  stop();
  pending.cancel("w1:p1", "m1");
  assert.equal(pending.panes.size, 0);
});

test("a herdr machine's pane is queued and delivered through the same client", async (context) => {
  const remote = fakeHerdr({ "w1:p1": "working" });
  const machines = {
    listed: true,
    profiles: () => [{ id: "machine-lab", name: "lab", transport: "machine", enabled: true }],
    client: () => remote,
  };
  const local = fakeHerdr({});
  const herdr = new MultiServerClient({ local, machines });
  await herdr.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { pending } = service(context, herdr);
  await pending.enqueue("machine-lab!w1:p1", "over ssh");
  remote.statuses["w1:p1"] = "idle";
  // the machine's snapshot is refreshed in the background
  await herdr.refresh(herdr.entries.get("machine-lab"));
  await pending.tick();
  assert.deepEqual(remote.sent, pasted("w1:p1", "over ssh"));
  assert.deepEqual(local.sent, []);
});

test("delivery runs on its own timer while messages wait, and stops with the service", async () => {
  const herdr = fakeHerdr({ "w1:p1": "idle" });
  const pending = new PendingInputs({ herdr, pollMs: 20, enterDelayMs: 0 });
  await pending.enqueue("w1:p1", "by itself");
  for (let index = 0; index < 50 && herdr.sent.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(herdr.sent, pasted("w1:p1", "by itself"));
  pending.stop();
  assert.equal(pending.timer, null);
});
