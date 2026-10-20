import test from "node:test";
import assert from "node:assert/strict";
import {
  chatFindCountText,
  clearMarks,
  createChatFind,
  findInText,
  markMatches,
  stepMatch,
  textRuns,
} from "../public/chat/chat-find.js";

// A small DOM, as far as chat-find.js touches it: text nodes that split,
// elements with classes, attributes and events, and normalize().
class FakeNode extends EventTarget {
  parentNode = null;
  childNodes = [];
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(at >= 0, "insertBefore a child");
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    assert.ok(at >= 0, "removeChild of a child");
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(node, old) {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }
  normalize() {
    const kept = [];
    for (const child of this.childNodes) {
      if (child.nodeType === 3) {
        if (!child.data) { child.parentNode = null; continue; }
        const last = kept.at(-1);
        if (last?.nodeType === 3) { last.data += child.data; child.parentNode = null; continue; }
      } else {
        child.normalize();
      }
      kept.push(child);
    }
    this.childNodes = kept;
  }
}

class FakeText extends FakeNode {
  nodeType = 3;
  constructor(data) { super(); this.data = data; }
  get textContent() { return this.data; }
  splitText(offset) {
    const rest = new FakeText(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    this.parentNode.insertBefore(rest, this.nextSibling);
    return rest;
  }
  normalize() {}
}

class FakeElement extends FakeNode {
  nodeType = 1;
  hidden = false;
  disabled = false;
  value = "";
  focused = false;
  open = false;
  className = "";
  attributes = new Map();
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); }
  get classList() {
    const names = () => this.className.split(/\s+/u).filter(Boolean);
    return {
      contains: (name) => names().includes(name),
      add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(" "); },
      remove: (name) => { this.className = names().filter((other) => other !== name).join(" "); },
    };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(text) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (text) this.appendChild(new FakeText(text));
  }
  focus() { this.focused = true; }
  select() {}
  scrollIntoView(options) { this.scrolledTo = options; }
}

const document = { createElement: (tag) => new FakeElement(tag) };

// h("p", { class: "x" }, "text", h("b", {}, "bold"))
function h(tag, attrs = {}, ...children) {
  const node = new FakeElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.appendChild(typeof child === "string" ? new FakeText(child) : child);
  return node;
}

// The tree as markup, to compare before and after.
function html(node) {
  if (node.nodeType === 3) return node.data;
  const tag = node.tagName.toLowerCase();
  const cls = node.className ? ` class="${node.className}"` : "";
  return `<${tag}${cls}>${node.childNodes.map(html).join("")}</${tag}>`;
}

function textNodes(node) {
  return node.nodeType === 3 ? [node] : node.childNodes.flatMap(textNodes);
}

// Two turns of a conversation as the Chat lens draws them.
function conversation() {
  return h("div", { class: "chat-turns" },
    h("article", { class: "chat-turn chat-turn-user" },
      h("div", { class: "chat-bubble" }, h("div", { class: "markdown" }, h("p", {}, "Find the needle in ", h("code", {}, "src/needle.js"), " please"))),
      h("div", { class: "chat-turn-meta" }, h("button", { class: "chat-copy", "aria-label": "Copy message" }, h("svg", {}, "needle")))),
    h("article", { class: "chat-turn chat-turn-agent" },
      h("div", { class: "markdown" },
        h("p", {}, "The ", h("strong", {}, "Needle"), " is here."),
        h("div", { class: "md-code is-folded" },
          h("div", { class: "md-code-head" }, h("span", {}, "needle")),
          h("pre", {}, h("code", {}, "const needle = 1;\nneedle();")),
          h("button", { class: "md-code-more", "data-action": "unfold-code" }, "Show all 40 lines")),
        h("span", { class: "sr-only" }, "needle"))));
}

test("smart case: a query without capitals matches any case, one with a capital only itself", () => {
  assert.deepEqual(findInText("Needle needle NEEDLE", "needle"), [[0, 6], [7, 13], [14, 20]]);
  assert.deepEqual(findInText("Needle needle NEEDLE", "Needle"), [[0, 6]]);
  assert.deepEqual(findInText("aaaa", "aa"), [[0, 2], [2, 4]], "matches do not overlap");
  assert.deepEqual(findInText("anything", ""), []);
  // a letter whose lower case is longer keeps every index after it in place
  assert.deepEqual(findInText("İx needle", "needle"), [[3, 9]]);
});

test("text is read by block, leaving out buttons' icons, a code block's language and screen-reader words", () => {
  const root = conversation();
  const runs = textRuns(root).map((run) => run.map((node) => node.data).join(""));
  assert.deepEqual(runs, [
    "Find the needle in src/needle.js please",
    "The Needle is here.",
    "const needle = 1;\nneedle();",
  ]);
  assert.deepEqual(textRuns(h("div", {}, h("p", {}, "abc"), h("p", {}, "def"))).length, 2);
  assert.equal(markMatches(h("div", {}, h("p", {}, "abc"), h("p", {}, "def")), "cd", { document }).matches.length, 0,
    "a match does not run from one paragraph into the next");
  // a delivered file's name and folder are lines of their own
  const file = h("li", {}, h("button", { class: "chat-file" }, h("span", { class: "chat-file-name" }, "app.apk"), h("span", { class: "chat-file-folder" }, "/home/me/out/")));
  assert.deepEqual(textRuns(file).map((run) => run.map((node) => node.data).join("")), ["app.apk", "/home/me/out/"]);
  assert.equal(markMatches(file, "apk/home", { document }).matches.length, 0);
});

test("matches are marked in place, across inline code and bold, and clearing puts the page back as it was", () => {
  const root = conversation();
  const before = html(root);
  const originals = textNodes(root);
  const { matches, capped } = markMatches(root, "needle", { document });
  assert.equal(capped, false);
  assert.equal(matches.length, 5, "two in the question, one in the answer, two in the code; none in buttons or sr-only");
  for (const marks of matches) {
    assert.ok(marks.every((mark) => mark.tagName === "MARK" && mark.className === "chat-find-mark"));
    assert.equal(marks.map((mark) => mark.textContent).join("").toLowerCase(), "needle");
  }
  assert.equal(root.textContent, conversation().textContent, "the text reads the same with the marks in");
  // the inline code keeps its element; the mark goes inside it
  assert.equal(matches[1][0].parentNode.tagName, "CODE");
  assert.equal(html(matches[1][0].parentNode), "<code>src/<mark class=\"chat-find-mark\">needle</mark>.js</code>");

  // one match across a bold word's edge has one mark per piece
  const spanning = h("p", {}, "The ", h("strong", {}, "Needle"), " is here.");
  const across = markMatches(spanning, "e needle i", { document });
  assert.deepEqual(across.matches.map((marks) => marks.map((mark) => mark.textContent)), [["e ", "Needle", " i"]]);
  clearMarks(across.matches);
  assert.equal(html(spanning), "<p>The <strong>Needle</strong> is here.</p>");

  clearMarks(matches);
  assert.equal(html(root), before);
  const after = textNodes(root);
  assert.equal(after.length, originals.length, "split text is joined again");
  assert.ok(after.every((node, index) => node === originals[index]), "the same text nodes, not copies");
});

test("past the limit the rest are neither marked nor counted", () => {
  const root = h("div", {}, h("p", {}, "x x x"), h("p", {}, "x x"));
  const { matches, capped } = markMatches(root, "x", { document, limit: 4 });
  assert.equal(matches.length, 4);
  assert.equal(capped, true);
  assert.equal(chatFindCountText({ query: "x", total: 4, index: 3, capped }), "4/4+");
  clearMarks(matches);
  assert.equal(html(root), "<div><p>x x x</p><p>x x</p></div>");
});

test("the count and the steps: up is older, down is newer, and the ends wrap", () => {
  assert.equal(chatFindCountText({ query: "" }), "");
  assert.equal(chatFindCountText({ query: "x", total: 0 }), "No matches");
  assert.equal(chatFindCountText({ query: "x", total: 17, index: 2 }), "3/17");
  assert.equal(stepMatch(2, 5, "older"), 1);
  assert.equal(stepMatch(0, 5, "older"), 4);
  assert.equal(stepMatch(4, 5, "newer"), 0);
  assert.equal(stepMatch(-1, 5, "older"), 4);
  assert.equal(stepMatch(-1, 5, "newer"), 0);
  assert.equal(stepMatch(0, 0, "newer"), -1);
});

function keydown(target, key, options = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, shiftKey: false, isComposing: false, keyCode: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

function findBar() {
  const elements = {
    form: h("form"), input: h("input"), count: h("span"),
    olderButton: h("button"), newerButton: h("button"), closeButton: h("button"),
    more: h("p"), moreButton: h("button"),
  };
  const timers = [];
  let older = { more: false, state: "idle" };
  let loads = 0;
  const root = conversation();
  const chat = {
    paneId: "w1:p1",
    findRoot: root,
    scroller: null,
    older: () => older,
    loadOlder: async () => { loads += 1; },
  };
  let closed = 0;
  const find = createChatFind({
    document, ...elements,
    onClose: () => { closed += 1; },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  const type = (text) => {
    elements.input.value = text;
    elements.input.dispatchEvent(new Event("input"));
  };
  const current = () => [...textNodes(root)].filter((node) => node.parentNode.classList.contains("is-current"));
  return {
    elements, find, chat, root, timers, type, current,
    setOlder: (next) => { older = next; },
    loads: () => loads,
    closed: () => closed,
  };
}

test("the bar marks once typing pauses, steps up on Enter and down on Shift+Enter, and Esc puts the page back", () => {
  const bar = findBar();
  const before = html(bar.root);
  assert.equal(bar.elements.form.hidden, true);
  bar.find.show(bar.chat);
  assert.equal(bar.elements.form.hidden, false);
  assert.equal(bar.elements.input.focused, true);
  assert.equal(bar.find.paneId, "w1:p1");

  bar.type("needle");
  assert.equal(html(bar.root), before, "waits for the pause");
  bar.timers.at(-1)();
  assert.equal(bar.elements.count.textContent, "5/5", "starts from the bottom");
  assert.equal(bar.current().map((node) => node.data).join(""), "needle");
  const last = bar.current()[0].parentNode;
  assert.deepEqual(last.scrolledTo, { block: "center", inline: "nearest" }, "the current match is scrolled to the middle");

  keydown(bar.elements.input, "Enter");
  assert.equal(bar.elements.count.textContent, "4/5");
  assert.equal(last.classList.contains("is-current"), false, "only one match is current");
  assert.equal(bar.root.childNodes[1].textContent.includes("const needle"), true);
  bar.elements.olderButton.dispatchEvent(new Event("click"));
  bar.elements.olderButton.dispatchEvent(new Event("click"));
  assert.equal(bar.elements.count.textContent, "2/5");
  keydown(bar.elements.input, "Enter", { shiftKey: true });
  assert.equal(bar.elements.count.textContent, "3/5");
  // in the answer: the Needle in bold; then the code block's first line, folded away, is unfolded
  let unfolded = 0;
  bar.root.childNodes[1].childNodes[0].childNodes[1].childNodes[2].click = () => { unfolded += 1; };
  bar.elements.newerButton.dispatchEvent(new Event("click"));
  assert.equal(bar.elements.count.textContent, "4/5");
  assert.equal(unfolded, 1, "a match in a folded code block unfolds it");
  bar.elements.newerButton.dispatchEvent(new Event("click"));
  bar.elements.newerButton.dispatchEvent(new Event("click"));
  assert.equal(bar.elements.count.textContent, "1/5", "the end wraps to the top");

  // Enter mid-composition belongs to the IME
  keydown(bar.elements.input, "Enter", { isComposing: true });
  assert.equal(bar.elements.count.textContent, "1/5");

  keydown(bar.elements.input, "Escape");
  assert.equal(bar.elements.form.hidden, true);
  assert.equal(bar.closed(), 1);
  assert.equal(html(bar.root), before, "no marks are left");
});

test("smart case in the bar, and a query cleared takes the marks away at once", () => {
  const bar = findBar();
  const before = html(bar.root);
  bar.find.show(bar.chat);
  bar.type("Needle");
  bar.timers.at(-1)();
  assert.equal(bar.elements.count.textContent, "1/1");
  bar.type("haystack");
  // Enter while the pause is still running searches now
  keydown(bar.elements.input, "Enter");
  assert.equal(bar.elements.count.textContent, "No matches");
  bar.type("");
  assert.equal(bar.elements.count.textContent, "");
  assert.equal(html(bar.root), before);
});

test("a redraw marks again and keeps the current match; earlier pages are offered and loaded", () => {
  const bar = findBar();
  bar.find.show(bar.chat);
  bar.type("needle");
  bar.timers.at(-1)();
  keydown(bar.elements.input, "Enter");
  keydown(bar.elements.input, "Enter");
  assert.equal(bar.elements.count.textContent, "3/5");
  assert.equal(bar.current()[0].data, "Needle");

  // a new turn arrives at the end, and an earlier one is loaded above
  bar.root.appendChild(h("article", { class: "chat-turn" }, h("p", {}, "one more needle")));
  bar.root.insertBefore(h("article", { class: "chat-turn" }, h("p", {}, "an older needle")), bar.root.firstChild);
  bar.find.redrawn(bar.chat, { turns: true });
  assert.equal(bar.elements.count.textContent, "4/7", "the same match, counted afresh");
  assert.equal(bar.current()[0].data, "Needle");
  assert.equal(bar.root.childNodes[1].textContent.includes("Find the needle"), true);

  // the turn holding the current match is drawn anew (a live turn): the same place in it
  const fresh = conversation().childNodes[1];
  bar.root.replaceChild(fresh, bar.root.childNodes[2]);
  bar.find.redrawn(bar.chat, { turns: true });
  assert.equal(bar.elements.count.textContent, "4/7");
  assert.equal(bar.current()[0].data, "Needle");
  assert.equal(bar.current()[0].parentNode.parentNode.parentNode, fresh.childNodes[0].childNodes[0]);

  // another chat's redraw is none of this bar's business
  bar.find.redrawn({ ...bar.chat }, { turns: true });
  assert.equal(bar.elements.count.textContent, "4/7");

  assert.equal(bar.elements.more.hidden, true);
  bar.setOlder({ more: true, state: "idle" });
  bar.find.redrawn(bar.chat, { turns: false });
  assert.equal(bar.elements.more.hidden, false);
  assert.equal(bar.elements.moreButton.textContent, "Load earlier");
  bar.elements.moreButton.dispatchEvent(new Event("click"));
  assert.equal(bar.loads(), 1);
  bar.setOlder({ more: true, state: "loading" });
  bar.find.redrawn(bar.chat, { turns: false });
  assert.equal(bar.elements.moreButton.disabled, true);
  bar.setOlder({ more: true, state: "failed" });
  bar.find.redrawn(bar.chat, { turns: false });
  assert.equal(bar.elements.moreButton.textContent, "Try again");

  bar.find.close();
  assert.equal(textNodes(bar.root).some((node) => node.parentNode.tagName === "MARK"), false);
  assert.equal(bar.find.paneId, null);
});
