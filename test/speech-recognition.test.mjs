import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechButton } from "../public/speech-recognition.js";

// A recognizer that says what the test tells it to, as the browser's would.
class FakeRecognition {
  static last = null;
  constructor() { FakeRecognition.last = this; }
  start() {}
  stop() {}
  say(...results) {
    const list = results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult({ resultIndex: 0, results: list });
  }
}

function setup(initial = "") {
  const textarea = { value: initial, dispatchEvent() {} };
  const button = { classList: { toggle() {} }, setAttribute() {}, addEventListener(type, handler) { this.click = handler; } };
  createSpeechButton({ button, textarea, Recognition: FakeRecognition });
  button.click();
  return { textarea, recognition: FakeRecognition.last };
}

test("a growing interim result replaces the previous one instead of piling up", () => {
  const { textarea, recognition } = setup();
  for (const words of ["나는", "나는 한", "나는 한 번", "나는 한 번 말하는데"]) recognition.say([words, false]);
  assert.equal(textarea.value, "나는 한 번 말하는데");
});

test("the final result replaces its interim and the next phrase follows it", () => {
  const { textarea, recognition } = setup();
  recognition.say(["나는 한", false]);
  recognition.say(["나는 한 번", true]);
  assert.equal(textarea.value, "나는 한 번");
  recognition.say(["왜 이렇게", false]);
  recognition.say(["왜 이렇게 여러 개가", false]);
  assert.equal(textarea.value, "나는 한 번 왜 이렇게 여러 개가");
  recognition.say(["왜 이렇게 여러 개가 들어가지", true]);
  assert.equal(textarea.value, "나는 한 번 왜 이렇게 여러 개가 들어가지");
});

test("text already in the box stays, and a final plus a new interim in one event both land once", () => {
  const { textarea, recognition } = setup("deploy ");
  recognition.say(["고쳐줘", false]);
  assert.equal(textarea.value, "deploy 고쳐줘");
  recognition.say(["고쳐줘", true], ["그리고", false]);
  assert.equal(textarea.value, "deploy 고쳐줘 그리고");
  recognition.say(["그리고 테스트", false]);
  assert.equal(textarea.value, "deploy 고쳐줘 그리고 테스트");
});

test("an empty interim leaves the text as it is", () => {
  const { textarea, recognition } = setup();
  recognition.say(["안녕", true]);
  recognition.say(["", false]);
  assert.equal(textarea.value, "안녕");
});

// Settings → Speech log: each result event as the browser gave it (every
// result, from 0, with resultIndex) and what the box held after it.
test("each recognizer event is told to onLog with every result and the box after it", () => {
  const entries = [];
  const textarea = { value: "", dispatchEvent() {} };
  const button = { classList: { toggle() {} }, setAttribute() {}, addEventListener(type, handler) { this.click = handler; } };
  createSpeechButton({ button, textarea, Recognition: FakeRecognition, onLog: (entry) => entries.push(entry) });
  button.click();
  const recognition = FakeRecognition.last;
  recognition.say(["네", true], ["네트워크", false]);
  recognition.onerror({ error: "no-speech" });
  recognition.onend();
  assert.deepEqual(entries.map((entry) => entry.type), ["start", "result", "error", "end"]);
  assert.deepEqual(entries[1], {
    type: "result",
    resultIndex: 0,
    results: [{ final: true, text: "네" }, { final: false, text: "네트워크" }],
    box: "네 네트워크",
  });
  assert.equal(entries[2].error, "no-speech");
});
