import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_CELL_MIN_HEIGHT,
  CHAT_CELL_MIN_WIDTH,
  CHAT_CELL_TOO_SMALL,
  cellLens,
  chatCellRoomy,
} from "../public/lens-preference.js";
import { chatsToDrop, watchChanges } from "../public/chat/chat-view.js";
import { sharedPromptWatch } from "../public/chat/prompt-card.js";

test("a cell under 320 by 220 px has no room for a chat", () => {
  assert.equal(CHAT_CELL_MIN_WIDTH, 320);
  assert.equal(CHAT_CELL_MIN_HEIGHT, 220);
  assert.equal(chatCellRoomy({ width: 320, height: 220 }), true);
  assert.equal(chatCellRoomy({ width: 319, height: 600 }), false);
  assert.equal(chatCellRoomy({ width: 900, height: 219 }), false);
  assert.equal(chatCellRoomy({}), false);
  assert.equal(CHAT_CELL_TOO_SMALL, "Too small for the chat. Open alone");
});

test("a cell shows the chat its pane wants only when the pane has one and the cell has room", () => {
  assert.deepEqual(cellLens({ wanted: "chat", chatAvailable: true, roomy: true }), { lens: "chat", chatEnabled: true, tooSmall: false });
  assert.deepEqual(cellLens({ wanted: "terminal", chatAvailable: true, roomy: true }), { lens: "terminal", chatEnabled: true, tooSmall: false });
  // too small: the terminal shows, the Chat button dims, and the cell says why
  assert.deepEqual(cellLens({ wanted: "chat", chatAvailable: true, roomy: false }), { lens: "terminal", chatEnabled: false, tooSmall: true });
  assert.deepEqual(cellLens({ wanted: "terminal", chatAvailable: true, roomy: false }), { lens: "terminal", chatEnabled: false, tooSmall: false });
  // no chat at all (a shell, an agent the chat cannot read): no size note either
  assert.deepEqual(cellLens({ wanted: "chat", chatAvailable: false, roomy: false }), { lens: "terminal", chatEnabled: false, tooSmall: false });
  assert.deepEqual(cellLens({ wanted: "chat", chatAvailable: false, roomy: true }), { lens: "terminal", chatEnabled: false, tooSmall: false });
  assert.equal(cellLens().lens, "terminal");
});

test("the conversations watched follow the chats on screen, one message per change", () => {
  assert.deepEqual(watchChanges(new Set(), ["a", "b"]), { add: ["a", "b"], remove: [] });
  assert.deepEqual(watchChanges(new Set(["a", "b"]), ["b", "c"]), { add: ["c"], remove: ["a"] });
  assert.deepEqual(watchChanges(new Set(["a"]), ["a", "a"]), { add: [], remove: [] });
  assert.deepEqual(watchChanges(new Set(["a", "b"]), []), { add: [], remove: ["a", "b"] });
});

test("kept chats beyond the limit go oldest first, but never one a cell or the pane alone shows", () => {
  // oldest first, as a Map keeps them
  assert.deepEqual(chatsToDrop(["a", "b", "c", "d", "e"], { keep: 4, kept: new Set() }), ["a"]);
  assert.deepEqual(chatsToDrop(["a", "b", "c", "d", "e", "f"], { keep: 4, kept: new Set(["a", "b"]) }), ["c", "d"]);
  // six cells on screen: all six stay though the limit is four
  assert.deepEqual(chatsToDrop(["a", "b", "c", "d", "e", "f"], { keep: 4, kept: new Set(["a", "b", "c", "d", "e", "f"]) }), []);
  assert.deepEqual(chatsToDrop(["a", "b"], { keep: 4, kept: new Set() }), []);
});

test("a card that joins a pane already watched hears the card last pushed for it", async () => {
  const listeners = new Set();
  const connection = { watchPrompt() {}, unwatchPrompt() {}, onPrompt: (listener) => { listeners.add(listener); } };
  const shared = sharedPromptWatch(connection);
  const heard = [];
  shared.onPrompt((message) => heard.push(message.card?.id ?? null));
  shared.watchPrompt("p1");
  for (const listener of listeners) listener({ type: "prompt", pane_id: "p1", card: { id: "a" } });
  shared.watchPrompt("p1");
  await Promise.resolve();
  assert.deepEqual(heard, ["a", "a"]);
  // let go by all: a later first watch waits for the server's own push
  shared.unwatchPrompt("p1");
  shared.unwatchPrompt("p1");
  shared.watchPrompt("p1");
  await Promise.resolve();
  assert.deepEqual(heard, ["a", "a"]);
});

test("a prompt watched by several cards is asked for once and let go when the last lets go", () => {
  const sent = [];
  const listeners = new Set();
  const connection = {
    watchPrompt: (id) => sent.push(["watch", id]),
    unwatchPrompt: (id) => sent.push(["unwatch", id]),
    onPrompt: (listener) => { listeners.add(listener); },
  };
  const shared = sharedPromptWatch(connection);
  const heard = [];
  const stop = shared.onPrompt((message) => heard.push(message.pane_id));
  shared.watchPrompt("p1");
  shared.watchPrompt("p1");
  assert.deepEqual(sent, [["watch", "p1"]]);
  shared.unwatchPrompt("p1");
  assert.deepEqual(sent, [["watch", "p1"]], "one card still watches it");
  shared.unwatchPrompt("p1");
  assert.deepEqual(sent, [["watch", "p1"], ["unwatch", "p1"]]);
  shared.unwatchPrompt("p1");
  assert.equal(sent.length, 2, "an unwatch with no watcher sends nothing");
  // the server could not watch it: every card hears so, and the next watch asks again
  shared.watchPrompt("p2");
  shared.watchPrompt("p2");
  for (const listener of listeners) listener({ type: "prompt-unavailable", pane_id: "p2", code: "busy" });
  assert.deepEqual(sent.slice(2), [["watch", "p2"], ["unwatch", "p2"]]);
  assert.deepEqual(heard, ["p2"]);
  shared.unwatchPrompt("p2");
  assert.equal(sent.length, 4, "the cards letting go after that send nothing more");
  shared.watchPrompt("p2");
  assert.deepEqual(sent.at(-1), ["watch", "p2"]);
  // a card that is gone hears nothing more
  stop();
  for (const listener of listeners) listener({ type: "prompt", pane_id: "p2", card: null });
  assert.deepEqual(heard, ["p2"]);
});
