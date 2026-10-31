import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechLog, speechLogLine } from "../public/speech-log.js";

test("a result line shows resultIndex, every result marked final or interim, and the box", () => {
  const line = speechLogLine({
    type: "result",
    resultIndex: 1,
    results: [{ final: true, text: "네" }, { final: false, text: "네트워크 \"확인\"" }],
    box: "네 네트워크",
  }, 1.234);
  assert.equal(line, '+1.23s result i=1 n=2 | 0F "네" | 1i "네트워크 \\"확인\\"" => box "네 네트워크"');
  assert.equal(speechLogLine({ type: "error", error: "network", box: "" }, 0), '+0.00s error network => box ""');
  assert.equal(speechLogLine({ type: "end", box: "a" }, 2), '+2.00s end => box "a"');
});

test("the log times entries from its first, keeps the last few, and clears", () => {
  let clock = 1_000;
  const log = createSpeechLog({ limit: 2, now: () => clock });
  log.add({ type: "start", box: "" });
  clock = 1_500;
  log.add({ type: "end", box: "" });
  clock = 3_000;
  log.add({ type: "start", box: "x" });
  assert.equal(log.size, 2);
  assert.equal(log.text(), '+0.50s end => box ""\n+2.00s start => box "x"');
  log.clear();
  assert.equal(log.size, 0);
  assert.equal(log.text(), "");
  clock = 9_000;
  log.add({ type: "start", box: "" });
  assert.equal(log.text(), '+0.00s start => box ""');
});
