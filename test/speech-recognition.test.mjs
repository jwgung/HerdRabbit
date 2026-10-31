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
  // `results` is the whole list so far; the event's new ones start at `resultIndex`
  sayFrom(resultIndex, ...results) {
    const list = results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult({ resultIndex, results: list });
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

// Android Chrome, from a phone's log of its recognizer events (2026-10-31): no interim results;
// each better hearing of the same words comes as one more final result, the
// words so far and then some. Only the last is what was said.
const ANDROID_FINALS = ["", "안녕하세요", "안녕하세요", "안녕하세요", "안녕하세요", "안녕하세요", "안녕하세요 공정원입니다"];

function sayLikeAndroid(recognition, finals) {
  finals.forEach((_text, index) => recognition.sayFrom(index, ...finals.slice(0, index + 1).map((text) => [text, true])));
}

test("Android's finals, each the same words heard again, land once as the last of them", () => {
  const { textarea, recognition } = setup();
  sayLikeAndroid(recognition, ANDROID_FINALS);
  assert.equal(textarea.value, "안녕하세요 공정원입니다");
});

test("after Android's restart the next words follow, and text typed before stays", () => {
  const { textarea, recognition } = setup("deploy");
  sayLikeAndroid(recognition, ANDROID_FINALS);
  recognition.onend();
  const next = FakeRecognition.last;
  // the same words said again after the restart are said twice
  sayLikeAndroid(next, ["", "안녕하세요"]);
  assert.equal(textarea.value, "deploy 안녕하세요 공정원입니다 안녕하세요");
});

test("on the desktop a final after an interim is new words, even when it starts as the last did", () => {
  const { textarea, recognition } = setup();
  recognition.say(["네", true]);
  recognition.sayFrom(1, ["네", true], ["네트워크", false]);
  recognition.sayFrom(1, ["네", true], ["네트워크 확인", true]);
  assert.equal(textarea.value, "네 네트워크 확인");
});

test("a final right after a final that does not go on from it is new words", () => {
  const { textarea, recognition } = setup();
  recognition.sayFrom(0, ["네", true]);
  recognition.sayFrom(1, ["네", true], ["알겠습니다", true]);
  assert.equal(textarea.value, "네 알겠습니다");
});

test("a final is not taken back once the box was changed by hand after it", () => {
  const { textarea, recognition } = setup();
  recognition.sayFrom(0, ["안녕하세요", true]);
  textarea.value += "!";
  recognition.sayFrom(1, ["안녕하세요", true], ["안녕하세요 반가워요", true]);
  assert.equal(textarea.value, "안녕하세요! 안녕하세요 반가워요");
});
