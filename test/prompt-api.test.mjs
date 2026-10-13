import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { parseClaudePrompt } from "../src/prompt/claude.mjs";
import { approvalScreen, fakePromptHerdr } from "./fixtures/claude-prompt.mjs";

const CARD_ID = parseClaudePrompt(approvalScreen()).id;

function panes() {
  return {
    panes: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" },
      { pane_id: "w1:p2", agent: "claude", agent_status: "idle" },
      { pane_id: "w1:p3", agent: "codex", agent_status: "blocked" },
      { pane_id: "w1:p4", agent: "claude", agent_status: "blocked" },
    ],
    menus: { "w1:p1": { cursor: 0 } },
    outputs: { "w1:p3": "Overwrite the build?\nContinue? (y/n)", "w1:p4": "Running sudo\n[sudo] password for me:" },
  };
}

async function fixture(context, { herdr = fakePromptHerdr(panes()), prompts } = {}) {
  let authenticated = true;
  const app = createHerdrHttpServer({
    herdr,
    csrfToken: "csrf",
    logger: { error() {} },
    prompts: prompts ?? new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300, pollMs: 40 }),
    auth: {
      required: true,
      hasValidSession: (cookie) => authenticated && cookie === "session=valid",
      hasValidLaunchToken: (token) => authenticated && token === "launch",
      onSessionsEnded: () => () => {},
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = async (paneId) => {
    const response = await fetch(`${origin}/api/panes/${encodeURIComponent(paneId)}/prompt`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const answer = async (paneId, body, extra = { "X-Herdr-CSRF": "csrf" }) => {
    const response = await fetch(`${origin}/api/panes/${encodeURIComponent(paneId)}/prompt/answer`, {
      method: "POST", headers: { ...headers, ...extra, "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, origin, herdr, get, answer, logout: () => { authenticated = false; } };
}

test("the prompt routes sit behind the sign-in and the write token", async (context) => {
  const { origin, answer, logout, herdr } = await fixture(context);
  assert.equal((await answer("w1:p1", { cardId: CARD_ID, option: 0 }, {})).body.error.code, "csrf_rejected");
  logout();
  const read = await fetch(`${origin}/api/panes/w1%3Ap1/prompt`);
  assert.equal(read.status, 401);
  assert.equal((await answer("w1:p1", { cardId: CARD_ID, option: 0 })).status, 401);
  assert.deepEqual(herdr.sent, []);
});

test("a blocked Claude pane shows its approval card; an idle one none", async (context) => {
  const { get, herdr } = await fixture(context);
  const { status, body } = await get("w1:p1");
  assert.equal(status, 200);
  assert.equal(body.card.id, CARD_ID);
  assert.equal(body.card.kind, "approval");
  assert.deepEqual(body.card.options.map((option) => option.label), ["Yes", "Yes, and don't ask again for: npm test", "No"]);
  assert.equal(herdr.reads.at(-1).source, "detection");
  assert.deepEqual(await get("w1:p2"), { status: 200, body: { card: null } });
  assert.equal((await get("w9:p9")).body.error.code, "pane_not_found");
});

for (const [option, keys, label] of [
  [0, [["enter"]], "Yes"],
  [1, [["down"], ["enter"]], "Yes, and don't ask again for: npm test"],
  [2, [["down"], ["down"], ["enter"]], "No"],
]) {
  test(`option ${option} sends ${keys.flat().join(", ")} and answers "${label}"`, async (context) => {
    const { answer, herdr, get } = await fixture(context);
    assert.deepEqual(await answer("w1:p1", { cardId: CARD_ID, option }), { status: 200, body: { ok: true } });
    assert.deepEqual(herdr.sent.map((item) => item.keys), keys);
    assert.deepEqual(herdr.answered, [{ paneId: "w1:p1", answer: label }]);
    assert.equal((await get("w1:p1")).body.card, null);
  });
}

test("an answer to a card that changed is a 409 prompt_changed, and nothing is sent", async (context) => {
  const { answer, herdr } = await fixture(context);
  const stale = await answer("w1:p1", { cardId: "000000000000", option: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "prompt_changed");
  herdr.menus["w1:p1"].command = "rm -rf build";
  assert.equal((await answer("w1:p1", { cardId: CARD_ID, option: 0 })).body.error.code, "prompt_changed");
  assert.deepEqual(herdr.sent, []);
  assert.equal((await answer("w1:p1", { cardId: CARD_ID })).status, 409);
});

test("a malformed answer is refused before any key", async (context) => {
  const { answer, herdr } = await fixture(context);
  assert.equal((await answer("w1:p1", { cardId: CARD_ID, option: 7 })).body.error.code, "invalid_answer");
  assert.equal((await answer("w1:p1", { cardId: CARD_ID, option: 0, text: "x" })).body.error.code, "invalid_answer");
  assert.equal((await answer("w1:p1", { option: 0 })).body.error.code, "invalid_answer");
  assert.deepEqual(herdr.sent, []);
});

test("the Enter goes only once the screen shows the cursor on the row the moves were for", async (context) => {
  const herdr = fakePromptHerdr(panes());
  // a pane whose menu does not follow the arrows (another menu took the keys)
  const sendKeys = herdr.sendKeys;
  herdr.sendKeys = async (paneId, keys) => keys.includes("down") ? herdr.sent.push({ paneId, keys }) : sendKeys(paneId, keys);
  const { answer } = await fixture(context, { herdr });
  const result = await answer("w1:p1", { cardId: CARD_ID, option: 2 });
  assert.equal(result.body.error.code, "prompt_changed");
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["down"], ["down"]]);
  assert.deepEqual(herdr.answered, []);
});

test("a blocked pane no reader knows gets the fallback card, answered with its keys", async (context) => {
  const { get, answer, herdr } = await fixture(context);
  const { card } = (await get("w1:p3")).body;
  assert.equal(card.fallback, true);
  assert.deepEqual(card.options.map((option) => option.label), ["Yes (y)", "No (n)", "Enter", "Esc"]);
  assert.equal((await answer("w1:p3", { cardId: card.id, option: 0 })).status, 200);
  assert.equal((await answer("w1:p3", { cardId: card.id, option: 3 })).status, 200);
  assert.deepEqual(herdr.sent, [{ paneId: "w1:p3", text: "y" }, { paneId: "w1:p3", keys: ["esc"] }]);
});

test("a password prompt is no card, not even a fallback one", async (context) => {
  const { get, answer, herdr } = await fixture(context);
  assert.equal((await get("w1:p4")).body.card, null);
  assert.equal((await answer("w1:p4", { cardId: "000000000000", option: 0 })).status, 409);
  assert.deepEqual(herdr.sent, []);
});

test("a herdr machine's pane is read and answered through the same client", async (context) => {
  const remote = fakePromptHerdr(panes());
  const machines = {
    listed: true,
    profiles: () => [{ id: "machine-lab", name: "lab", transport: "machine", enabled: true }],
    client: () => remote,
  };
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, machines });
  await herdr.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { get, answer } = await fixture(context, { herdr, prompts: new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 }) });
  const { card } = (await get("machine-lab!w1:p1")).body;
  assert.equal(card.id, CARD_ID);
  assert.equal((await answer("machine-lab!w1:p1", { cardId: card.id, option: 1 })).status, 200);
  assert.deepEqual(remote.sent, [{ paneId: "w1:p1", keys: ["down"] }, { paneId: "w1:p1", keys: ["enter"] }]);
  assert.deepEqual(remote.answered, [{ paneId: "w1:p1", answer: "Yes, and don't ask again for: npm test" }]);
});

test("a watched pane's card is pushed over the terminal socket when it appears and when it goes", async (context) => {
  const { origin, answer } = await fixture(context);
  const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal`, { origin, headers: { Cookie: "session=valid" } });
  context.after(() => ws.terminate());
  const messages = [];
  const next = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Missing socket message")), 3000);
    const check = () => {
      const found = messages.find(predicate);
      if (found) { clearTimeout(timer); resolve(found); } else setTimeout(check, 10);
    };
    check();
  });
  ws.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", csrf: "csrf", launchToken: "launch" }));
  await next((message) => message.type === "ready");
  ws.send(JSON.stringify({ type: "watch-prompt", paneId: "w1:p1" }));
  const shown = await next((message) => message.type === "prompt");
  assert.equal(shown.pane_id, "w1:p1");
  assert.equal(shown.card.id, CARD_ID);
  await answer("w1:p1", { cardId: CARD_ID, option: 0 });
  const gone = await next((message) => message.type === "prompt" && message.card === null);
  assert.equal(gone.pane_id, "w1:p1");
});
