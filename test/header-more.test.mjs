import assert from "node:assert/strict";
import test from "node:test";
import { headerMoreActions } from "../public/app/header-more.js";

function control({ hidden = false, attrs = {} } = {}) {
  return { hidden, getAttribute: (name) => attrs[name] ?? null };
}

const keys = (controls) => headerMoreActions(controls).map((action) => action.key);

test("the menu offers the controls a desktop header would show, in header order", () => {
  assert.deepEqual(keys({
    gridBack: control({ hidden: true }),
    viewBack: control({ hidden: true }),
    viewApply: control(),
    viewClose: control(),
    lensSwitch: control(),
    lensChat: control({ attrs: { "aria-pressed": "false", "aria-disabled": "false" } }),
    lensTerminal: control({ attrs: { "aria-pressed": "true" } }),
    findButton: control({ attrs: { "aria-label": "Find in terminal" } }),
  }), ["view-apply", "view-close", "lens-chat", "find"]);
});

test("only the lens that is not on screen is offered, and never a disabled Chat", () => {
  const lens = (chat, terminal, chatDisabled = "false") => keys({
    lensSwitch: control(),
    lensChat: control({ attrs: { "aria-pressed": chat, "aria-disabled": chatDisabled } }),
    lensTerminal: control({ attrs: { "aria-pressed": terminal } }),
  });
  assert.deepEqual(lens("true", "false"), ["lens-terminal"]);
  assert.deepEqual(lens("false", "true"), ["lens-chat"]);
  assert.deepEqual(lens("false", "true", "true"), []);
});

test("a hidden lens switch or a hidden or disabled Find adds nothing", () => {
  assert.deepEqual(keys({
    lensSwitch: control({ hidden: true }),
    lensChat: control({ attrs: { "aria-pressed": "false" } }),
    lensTerminal: control({ attrs: { "aria-pressed": "true" } }),
    findButton: control({ attrs: { "aria-disabled": "true" } }),
  }), []);
  assert.deepEqual(keys({ findButton: control({ hidden: true }) }), []);
});

test("Find is named as its button is: terminal or conversation", () => {
  const [find] = headerMoreActions({ findButton: control({ attrs: { "aria-label": "Find in conversation" } }) });
  assert.equal(find.label, "Find in conversation");
});
