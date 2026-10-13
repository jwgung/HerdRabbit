import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversationHistory,
  ConversationLoader,
  readNewest,
  readOlder,
} from "../public/chat/conversation-refresh.js";

// A transcript as the server pages it: cursors name a turn's place, a page
// holds `pageSize` turns, `since` reads from a held place while it is still
// inside the newest page, and a cursor of another transcript is a 409.
function fakeServer({ count = 10, pageSize = 4, id = "h1" } = {}) {
  const server = {
    id,
    turns: Array.from({ length: count }, (_, n) => ({ role: n % 2 ? "assistant" : "user", ts: `t${n}`, parts: [{ kind: "text", text: `turn ${n}` }] })),
    pageSize,
    requests: [],
    answers: new Map(),
    append(n = 1) {
      for (let i = 0; i < n; i += 1) {
        const index = this.turns.length;
        this.turns.push({ role: "user", ts: `t${index}`, parts: [{ kind: "text", text: `turn ${index}` }] });
      }
    },
    replace(newId, count2 = 3) {
      this.id = newId;
      this.turns = this.turns.slice(0, count2);
    },
    offset(cursor) {
      const [cursorId, place] = String(cursor).split(":");
      const at = Number(place);
      if (cursorId !== this.id || !Number.isInteger(at) || at > this.turns.length) throw Object.assign(new Error("changed"), { status: 409, code: "history_changed" });
      return at;
    },
    async fetchPage(query) {
      server.requests.push({ ...query });
      const newestStart = Math.max(0, server.turns.length - server.pageSize);
      let start;
      let end = server.turns.length;
      if (query.before !== undefined) {
        end = server.offset(query.before);
        const floor = query.since === undefined ? 0 : server.offset(query.since);
        start = Math.max(floor, end - server.pageSize);
      } else {
        const held = query.since === undefined ? null : server.offset(query.since);
        start = held !== null && held >= newestStart ? held : newestStart;
      }
      const answer = { history_id: server.id, turns: server.turns.slice(start, end), cursor: start === 0 ? null : `${server.id}:${start}`, metadata: null };
      // an unchanged page answers the very object it answered before (a 304)
      const key = JSON.stringify(query);
      const known = server.answers.get(key);
      if (known && JSON.stringify(known) === JSON.stringify(answer)) return known;
      server.answers.set(key, answer);
      return answer;
    },
  };
  server.fetchPage = server.fetchPage.bind(server);
  return server;
}

const texts = (history) => history.turns.map((turn) => turn.parts[0].text.replace("turn ", ""));

test("the newest page first, then older pages above it, back to the beginning", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  assert.equal(await readNewest(history, server.fetchPage), true);
  assert.deepEqual(texts(history), ["6", "7", "8", "9"]);
  assert.equal(history.olderCursor, "h1:6");
  assert.deepEqual(server.requests.at(-1), {}, "no `since` while nothing older is shown");
  assert.equal(await readOlder(history, server.fetchPage), true);
  assert.deepEqual(texts(history), ["2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(history.held, "h1:6", "the newest page is held where it began");
  assert.equal(await readOlder(history, server.fetchPage), true);
  assert.deepEqual(texts(history), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.equal(history.olderCursor, null, "the beginning");
  assert.equal(await readOlder(history, server.fetchPage), false, "nothing above the beginning");
});

test("held, the newest page is read with `since` and new turns append", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  await readNewest(history, server.fetchPage);
  await readOlder(history, server.fetchPage);
  // a page that holds more than it is cut to: the held start stays inside it
  server.pageSize = 8;
  server.append(2);
  const asked = server.requests.length;
  await readNewest(history, server.fetchPage);
  assert.deepEqual(server.requests.slice(asked), [{ since: "h1:6" }]);
  assert.deepEqual(texts(history), ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  // unchanged: the same answer, nothing to lay out again
  const revision = history.revision;
  assert.equal(await readNewest(history, server.fetchPage), false);
  assert.equal(history.revision, revision);
});

test("unheld, a newest page that slid replaces the one shown", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  await readNewest(history, server.fetchPage);
  server.append(6);
  await readNewest(history, server.fetchPage);
  assert.deepEqual(texts(history), ["12", "13", "14", "15"]);
  assert.equal(history.olderCursor, "h1:12");
});

test("a newest page that moved past the held start reads the turns in between, each once", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  await readNewest(history, server.fetchPage);
  await readOlder(history, server.fetchPage);
  server.append(9);
  await readNewest(history, server.fetchPage);
  assert.deepEqual(texts(history), Array.from({ length: 17 }, (_, n) => String(n + 2)), "no gap and no turn twice");
  assert.equal(history.held, "h1:15");
  assert.ok(server.requests.some((request) => request.before && request.since === "h1:6"), "the gap is read down to the held start");
});

test("a 409 or another history starts over from the newest page", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  await readNewest(history, server.fetchPage);
  await readOlder(history, server.fetchPage);
  server.replace("h2", 3);
  await readNewest(history, server.fetchPage);
  assert.equal(history.historyId, "h2");
  assert.deepEqual(texts(history), ["0", "1", "2"]);
  assert.equal(history.held, null);
  assert.deepEqual(server.requests.slice(-2), [{ since: "h1:6" }, {}]);
  // an older page asked of the old history is dropped, and says so
  const stale = new ConversationHistory();
  const old = fakeServer({ count: 10, pageSize: 4 });
  await readNewest(stale, old.fetchPage);
  old.replace("h3", 9);
  assert.equal(await readOlder(stale, old.fetchPage), false);
  assert.equal(stale.loaded, false, "emptied: the caller reads the newest page again");
  // a new history id with no held start replaces what was shown
  const fresh = fakeServer({ count: 6, pageSize: 4 });
  const replaced = new ConversationHistory();
  await readNewest(replaced, fresh.fetchPage);
  fresh.id = "h9";
  fresh.answers.clear();
  await readNewest(replaced, fresh.fetchPage);
  assert.equal(replaced.historyId, "h9");
});

test("an older page that no longer fits is not added twice", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  const history = new ConversationHistory();
  await readNewest(history, server.fetchPage);
  const page = await server.fetchPage({ before: history.olderCursor });
  assert.equal(history.acceptOlder("h1:6", page), true);
  assert.equal(history.acceptOlder("h1:6", page), false, "the same page again");
  assert.deepEqual(texts(history), ["2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("the loader reads one at a time, a burst once, and an older page between reads", async () => {
  const server = fakeServer({ count: 10, pageSize: 4 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inFlight = 0;
  let most = 0;
  const loader = new ConversationLoader({
    minIntervalMs: 0,
    fetchPage: async (query) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (server.requests.length === 0) await gate;
      try { return await server.fetchPage(query); } finally { inFlight -= 1; }
    },
  });
  loader.refresh();
  loader.refresh();
  loader.refresh();
  const older = loader.loadOlder();
  release();
  assert.equal(await older, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(most, 1, "never two reads at once");
  assert.equal(server.requests.filter((request) => request.before === undefined).length, 2, "the burst read once more after the first");
  assert.deepEqual(texts(loader.history).slice(0, 2), ["2", "3"]);
  loader.stop();
});

test("the loader keeps to its interval and reports failures without losing what it holds", async () => {
  const server = fakeServer({ count: 5, pageSize: 4 });
  let now = 0;
  const timers = [];
  const errors = [];
  let fail = false;
  const loader = new ConversationLoader({
    minIntervalMs: 500,
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    fetchPage: async (query) => { if (fail) throw Object.assign(new Error("offline"), { status: 502 }); return server.fetchPage(query); },
    onError: (error) => errors.push(error.message),
  });
  loader.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.requests.length, 1);
  loader.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.requests.length, 1, "too soon: waits for the interval");
  assert.equal(timers.at(-1).ms, 500);
  now = 600;
  fail = true;
  timers.at(-1).fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ["offline"]);
  assert.equal(loader.history.turns.length, 4, "a failed read keeps the turns shown");
  loader.stop();
  loader.refresh();
  assert.equal(server.requests.length, 1);
});
