import test from "node:test";
import assert from "node:assert/strict";
import { PENDING_MS, STALE_PENDING_MS, pendingMessage, saysSent, settlePending } from "../public/chat/chat-activity.js";

let clock = 0;
const user = (text, ts = `2026-10-19T01:00:${String(clock++ % 60).padStart(2, "0")}Z`) => ({ role: "user", ts, parts: [{ kind: "text", text }] });
const reply = (text) => ({ role: "assistant", ts: null, parts: [{ kind: "text", text }] });

test("a message Claude got after the one a Stop put back resolves its pending bubble", () => {
  // the user sent "ㄱㄱㄱㄲ", stopped, then sent the next message: Claude's
  // input box still held the first, so the transcript has the two as one
  const before = [user("1번부터 시작할까요?"), reply("네")];
  const now = 10_000;
  const sent = pendingMessage("잠깐, 먼저 메인에 어디까지 올라감 지금?", before, now);
  const after = [...before, user("ㄱㄱㄱㄲ잠깐, 먼저 메인에 어디까지 올라감 지금?")];
  assert.deepEqual(settlePending([sent], before, now + 100), [sent]);
  assert.deepEqual(settlePending([sent], after, now + 100), [], "the run-together message is the one sent");
});

test("matching ignores how whitespace was laid out", () => {
  assert.equal(saysSent("first part\nrun the tests", "run   the\ntests "), true);
  assert.equal(saysSent("run the tests", "run the tests"), true);
  assert.equal(saysSent("run the tests later", "run the tests"), false);
  assert.equal(saysSent("anything", "   "), false);
  const now = 1_000;
  const sent = pendingMessage("  run\n the tests ", [], now);
  assert.deepEqual(settlePending([sent], [user("stop. run the   tests")], now + 10), []);
});

test("an earlier message that says the same, or ends the same, does not resolve a new one", () => {
  const earlier = [user("please run the tests"), reply("done"), user("run the tests"), reply("done again")];
  const now = 50_000;
  const sent = pendingMessage("run the tests", earlier, now);
  assert.equal(sent.baseline, 2);
  assert.deepEqual(settlePending([sent], earlier, now + 1_000), [sent]);
  // a newer read of the same transcript (an older page joined above) still waits
  assert.deepEqual(settlePending([sent], [user("older page"), ...earlier], now + 1_000), [sent]);
  assert.deepEqual(settlePending([sent], [...earlier, user("run the tests")], now + 1_000), []);
});

test("a pending bubble goes once a newer user turn that is not it has stood for a while", () => {
  const earlier = [user("first"), reply("ok")];
  const now = 100_000;
  const sent = pendingMessage("second", earlier, now);
  // Claude got something else where this message should have been
  const other = [...earlier, user("something typed in the terminal")];
  assert.deepEqual(settlePending([sent], other, now + 1_000), [sent], "not at once: the turn may still come");
  assert.deepEqual(settlePending([sent], other, now + STALE_PENDING_MS), []);
  // no newer turn at all: it waits, up to PENDING_MS
  assert.deepEqual(settlePending([sent], earlier, now + STALE_PENDING_MS + 1), [sent]);
  assert.deepEqual(settlePending([sent], earlier, now + PENDING_MS + 1), []);
});

test("a message sent behind another still waits for its own turn", () => {
  const earlier = [user("start"), reply("ok")];
  const now = 200_000;
  const first = pendingMessage("one", earlier, now, 0);
  const second = pendingMessage("two", earlier, now + 10, 1);
  // the first one's turn came: the second is behind it, not stale
  const withFirst = [...earlier, user("one")];
  assert.deepEqual(settlePending([first, second], withFirst, now + STALE_PENDING_MS + 100), [second]);
  assert.deepEqual(settlePending([second], [...withFirst, reply("…"), user("two")], now + STALE_PENDING_MS + 100), []);
});

test("a transcript read that no longer has the turn it was sent after falls back to counting", () => {
  const earlier = [user("start"), reply("ok"), user("go")];
  const now = 300_000;
  const sent = pendingMessage("go", earlier, now);
  const fresh = [user("a new session")];
  assert.deepEqual(settlePending([sent], fresh, now + STALE_PENDING_MS + 1), [sent]);
  assert.deepEqual(settlePending([sent], [...fresh, user("x go"), user("go")], now + 10), []);
});
