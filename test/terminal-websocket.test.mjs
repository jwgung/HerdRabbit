import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createHerdrHttpServer } from "../src/http-server.mjs";

async function fixture(context, overrides = {}) {
  let output = "prompt";
  let authenticated = true;
  const endedListeners = new Set();
  const writes = [];
  const requests = [];
  let inFlight = 0;
  let maximum = 0;
  const record = async item => {
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, 15));
    writes.push(item);
    output += item.text || item.keys.join();
    inFlight--;
  };
  const app = createHerdrHttpServer({
    csrfToken: "csrf",
    auth: { required: true, hasValidSession: cookie => authenticated && cookie === "session=valid",
      hasValidLaunchToken: token => authenticated && token === "launch",
      onSessionsEnded: listener => { endedListeners.add(listener); return () => endedListeners.delete(listener); } },
    herdr: { async readPane() { return output; }, async sendText(paneId, text, options) { await record({ paneId, text, ...options }); },
      async sendKeys(paneId, keys) { await record({ paneId, keys }); }, ...overrides },
    notificationMonitor: { recordRequest(...args) { requests.push(args); } },
    logger: { error() {} },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function connect(auth = { type: "auth", csrf: "csrf", launchToken: "launch" }) {
    const ws = new WebSocket(origin.replace("http", "ws") + "/api/terminal", { origin, headers: { Cookie: "session=valid" } });
    const messages = [];
    const waiting = [];
    ws.on("error", () => {});
    ws.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      messages.push(message);
      for (const waiter of [...waiting]) if (waiter.predicate(message)) {
        waiting.splice(waiting.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message);
      }
    });
    await once(ws, "open");
    const wait = predicate => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error("Missing socket message")), 2000) };
        waiting.push(waiter);
      });
    };
    ws.send(JSON.stringify(auth));
    return { ws, messages, wait, send: message => ws.send(JSON.stringify(message)) };
  }
  return { connect, writes, requests, origin, max: () => maximum, expire: () => { authenticated = false; },
    endSessions: () => { authenticated = false; for (const listener of endedListeners) listener(); } };
}

test("WebSocket streams a baseline and deltas, preserving input order without client ACK waits", async context => {
  const app = await fixture(context);
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  client.send({ type: "watch", paneId: "w1:p1", lines: 200 });
  const baseline = await client.wait(message => message.type === "output");
  assert.equal(baseline.update, "replace");
  client.send({ type: "input", id: 1, paneId: "w1:p1", text: "ㅎ" });
  client.send({ type: "input", id: 2, paneId: "w1:p1", text: "\x7f한" });
  client.send({ type: "input", id: 3, paneId: "w1:p1", keys: ["tab"] });
  client.send({ type: "input", id: 4, paneId: "w1:p1", text: "message", submit: true });
  await client.wait(message => message.type === "ack" && message.id === 4);
  assert.deepEqual(app.writes.map(item => item.text || item.keys), ["ㅎ", "\x7f한", ["tab"], "message"]);
  assert.equal(app.max(), 1);
  assert.deepEqual(app.requests, [["w1:p1", "message"]]);
  await client.wait(message => message.type === "output" && message.revision !== baseline.revision);
});

test("WebSocket refuses missing launch auth and rejects cross-origin upgrades", async context => {
  const app = await fixture(context);
  const client = await app.connect({ type: "auth", csrf: "csrf" });
  const [code] = await once(client.ws, "close");
  assert.equal(code, 4001);
  assert.equal(app.writes.length, 0);
  const ws = new WebSocket(app.origin.replace("http", "ws") + "/api/terminal", {
    origin: "https://untrusted.invalid", headers: { Cookie: "session=valid" },
  });
  ws.on("error", () => {});
  const [, response] = await once(ws, "unexpected-response");
  assert.equal(response.statusCode, 403);
  ws.terminate();
});

test("WebSocket revalidates login before accepting input", async context => {
  const app = await fixture(context);
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  app.expire();
  client.send({ type: "input", id: 1, paneId: "w1:p1", text: "must not write" });
  await once(client.ws, "close");
  assert.equal(app.writes.length, 0);
});

test("an ended sign-in closes its terminal socket at once, without waiting for a message", async context => {
  const app = await fixture(context);
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  const closed = once(client.ws, "close");
  app.endSessions();
  const [code] = await closed;
  assert.equal(code, 4001);
});

test("a failed terminal write discards the queued Enter and never replays it", async context => {
  const attempted = [];
  const app = await fixture(context, { async sendText(_paneId, text) { attempted.push(text); throw new Error("Disconnected"); },
    async sendKeys() { attempted.push("unexpected Enter"); } });
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  client.send({ type: "input", id: 1, paneId: "w1:p1", text: "command" });
  client.send({ type: "input", id: 2, paneId: "w1:p1", keys: ["enter"] });
  await once(client.ws, "close");
  assert.deepEqual(attempted, ["command"]);
});

test("a burst behind a slow PTY write drains without per-keystroke delay", async context => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const app = await fixture(context, {
    async sendText(paneId, text) {
      if (!delivered.length) { started(); await blocked; }
      await new Promise(resolve => setTimeout(resolve, 40));
      delivered.push(text);
    },
  });
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  client.send({ type: "input", id: 1, paneId: "w1:p1", text: "a" });
  await entered;
  for (let id = 2; id <= 31; id++) {
    client.send({ type: "input", id, paneId: "w1:p1", text: id % 2 ? "\x7f한" : "ㅎ" });
  }
  client.ws.ping();
  await once(client.ws, "pong"); // All preceding input frames have reached the server.
  const before = performance.now();
  release();
  await client.wait(message => message.type === "ack" && message.id === 31);
  const elapsed = performance.now() - before;
  assert.equal(delivered.join(""), "a" + "ㅎ\x7f한".repeat(15));
  assert(elapsed < 500, `queued input took ${Math.round(elapsed)}ms to drain`);
});

test("batched input preserves keys, submissions, pane boundaries and every acknowledgement", async context => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const app = await fixture(context, {
    async sendText(paneId, text, { submit }) {
      if (!delivered.length) { started(); await blocked; }
      delivered.push({ paneId, text, submit });
    },
    async sendKeys(paneId, keys) { delivered.push({ paneId, keys }); },
  });
  const client = await app.connect();
  await client.wait(message => message.type === "ready");
  client.send({ type: "input", id: 1, paneId: "w1:p1", text: "first" });
  await entered;
  const inputs = [
    { text: "a" }, { text: "b" }, { keys: ["tab"] },
    { text: "c" }, { text: "run", submit: true }, { text: "d" },
    { paneId: "w2:p1", text: "e" }, { text: "f".repeat(8000) }, { text: "g" },
  ];
  inputs.forEach((item, index) => client.send({ type: "input", paneId: "w1:p1", id: index + 2, ...item }));
  client.ws.ping(); await once(client.ws, "pong"); release();
  await client.wait(message => message.type === "ack" && message.id === 10);
  assert.deepEqual(delivered, [
    { paneId: "w1:p1", text: "first", submit: false },
    { paneId: "w1:p1", text: "ab", submit: false },
    { paneId: "w1:p1", keys: ["tab"] },
    { paneId: "w1:p1", text: "c", submit: false },
    { paneId: "w1:p1", text: "run", submit: true },
    { paneId: "w1:p1", text: "d", submit: false },
    { paneId: "w2:p1", text: "e", submit: false },
    { paneId: "w1:p1", text: "f".repeat(8000), submit: false },
    { paneId: "w1:p1", text: "g", submit: false },
  ]);
  assert.deepEqual(client.messages.filter(message => message.type === "ack").map(message => message.id),
    Array.from({ length: 10 }, (_, index) => index + 1));
  assert.deepEqual(app.requests, [["w1:p1", "run"]]);
});
