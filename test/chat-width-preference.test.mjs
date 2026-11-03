import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_WIDTHS,
  CHAT_WIDTH_STORAGE_KEY,
  chatWidthName,
  readChatWidth,
  writeChatWidth,
} from "../public/chat-width-preference.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test("offers four chat widths in order, each with its name", () => {
  assert.deepEqual(CHAT_WIDTHS, ["narrow", "default", "wide", "full"]);
  assert.deepEqual(CHAT_WIDTHS.map(chatWidthName), ["Narrow", "Default", "Wide", "Full"]);
  assert.equal(chatWidthName("bogus"), "Default");
});

test("keeps the chat width in this browser, Default until one is chosen", () => {
  const storage = memoryStorage();
  assert.equal(readChatWidth(storage), "default");
  assert.equal(writeChatWidth(storage, "wide"), true);
  assert.equal(storage.values.get(CHAT_WIDTH_STORAGE_KEY), "wide");
  assert.equal(readChatWidth(storage), "wide");
  assert.equal(writeChatWidth(storage, "huge"), false);
  assert.equal(readChatWidth(storage), "wide");
});

test("storage that fails or holds nonsense reads as Default", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); } };
  assert.equal(readChatWidth(broken), "default");
  assert.equal(writeChatWidth(broken, "full"), false);
  assert.equal(readChatWidth(null), "default");
  assert.equal(writeChatWidth(null, "full"), false);
  assert.equal(readChatWidth(memoryStorage({ [CHAT_WIDTH_STORAGE_KEY]: "huge" })), "default");
});
