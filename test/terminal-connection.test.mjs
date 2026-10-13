import test from "node:test";
import assert from "node:assert/strict";
import { terminalConnection } from "../public/terminal-connection.js";

test("reconnection restores the screen subscription but never replays unacknowledged input", async () => {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose({ code: 1006 }); }
  }
  const frames = [];
  const connection = terminalConnection({ WebSocketImpl: Socket, url: "ws://localhost/api/terminal",
    credentials: () => ({ csrf: "write", launchToken: "launch" }), onOutput: frame => frames.push(frame),
    onDisconnect() {}, onAuthenticationRequired() {} });
  connection.select("w1:p1", 200);
  sockets[0].open();
  sockets[0].receive({ type: "ready" });
  sockets[0].receive({ type: "output", paneId: "w1:p1", requestedLines: 200, update: "replace", output: "old", revision: "1" });
  const sent = connection.send({ paneId: "w1:p1", text: "command" });
  const rejected = assert.rejects(sent, /not resent/);
  sockets[0].close();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ type: "ready" });
  assert.deepEqual(sockets[1].sent.map(message => message.type), ["auth", "watch", "watch-statuses"]);
  sockets[1].receive({ type: "output", paneId: "w1:p1", requestedLines: 200, update: "replace", output: "current", revision: "2" });
  assert.equal(frames.at(-1).output, "current");
  connection.pause();
});

test("an attached pane is attached again after a reconnect, and its traffic goes to the attach listeners", async () => {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose({ code: 1006 }); }
  }
  const connection = terminalConnection({ WebSocketImpl: Socket, url: "ws://localhost/api/terminal",
    credentials: () => ({ csrf: "write", launchToken: "launch" }), onOutput() {}, onDisconnect() {}, onAuthenticationRequired() {} });
  const received = [];
  let reconnects = 0;
  connection.onAttach(message => received.push(message.type));
  connection.onReconnect(() => { reconnects += 1; connection.attach("w1:p1", { cols: 80, rows: 24 }); });
  connection.attach("w1:p1", { cols: 80, rows: 24 });
  connection.ptyInput("w1:p1", "dropped before the socket is ready");
  sockets[0].open();
  sockets[0].receive({ type: "ready" });
  assert.equal(reconnects, 1);
  connection.ptyInput("w1:p1", "ls\r");
  connection.acknowledge("w1:p1", "stream", 10);
  sockets[0].receive({ type: "pty-data", pane_id: "w1:p1", data: "x" });
  sockets[0].receive({ type: "attach-held", pane_id: "w1:p1" });
  assert.deepEqual(received, ["pty-data", "attach-held"]);
  assert.deepEqual(sockets[0].sent.map(message => message.type), ["auth", "watch-statuses", "attach", "pty-input", "pty-ack"]);
  assert.equal(sockets[0].sent.find(message => message.type === "pty-input").data, "ls\r", "nothing typed before the socket was ready is sent late");

  sockets[0].close();
  await new Promise(resolve => setTimeout(resolve, 280));
  sockets[1].open();
  sockets[1].receive({ type: "ready" });
  assert.equal(reconnects, 2);
  assert.deepEqual(sockets[1].sent.map(message => message.type), ["auth", "watch-statuses", "attach"]);
  connection.detach("w1:p1");
  assert.equal(sockets[1].sent.at(-1).type, "detach");
  connection.pause();
});

test("a page back from the background connects again for the pane it still shows", async () => {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose({ code: 1000 }); }
  }
  const connection = terminalConnection({ WebSocketImpl: Socket, url: "ws://localhost/api/terminal",
    credentials: () => ({ csrf: "write", launchToken: "launch" }), onOutput() {}, onDisconnect() {}, onAuthenticationRequired() {} });
  connection.onReconnect(() => connection.attach("w1:p1", { cols: 80, rows: 24 }));
  connection.attach("w1:p1", { cols: 80, rows: 24 });
  sockets[0].open();
  sockets[0].receive({ type: "ready" });
  connection.pause();
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(sockets.length, 1, "a paused page stays disconnected");
  connection.resume();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ type: "ready" });
  assert.equal(sockets[1].sent.at(-1).type, "attach");
  connection.pause();
});

test("a watched conversation is asked for on every socket, and only its changes are heard", async () => {
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose({ code: 1006 }); }
  }
  const connection = terminalConnection({ WebSocketImpl: Socket, url: "ws://localhost/api/terminal",
    credentials: () => ({ csrf: "write", launchToken: "launch" }), onOutput() {}, onDisconnect() {}, onAuthenticationRequired() {} });
  const heard = [];
  connection.onConversation(message => heard.push(message));
  // A chat alone opens the socket: no terminal needs to be attached.
  connection.watchConversation("w1:p1");
  connection.watchConversation("w1:p1");
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].receive({ type: "ready" });
  assert.deepEqual(sockets[0].sent.filter(message => message.type === "watch-conversation"), [{ type: "watch-conversation", paneId: "w1:p1" }]);
  sockets[0].receive({ type: "conversation-changed", pane_id: "w1:p1", signature: "a" });
  sockets[0].receive({ type: "conversation-changed", pane_id: "w9:p9", signature: "b" });
  assert.deepEqual(heard.map(message => message.signature), ["a"]);

  sockets[0].close();
  await new Promise(resolve => setTimeout(resolve, 280));
  sockets[1].open();
  sockets[1].receive({ type: "ready" });
  assert.deepEqual(sockets[1].sent.map(message => message.type), ["auth", "watch-statuses", "watch-conversation"]);
  connection.unwatchConversation("w1:p1");
  assert.deepEqual(sockets[1].sent.at(-1), { type: "unwatch-conversation", paneId: "w1:p1" });
  sockets[1].receive({ type: "conversation-changed", pane_id: "w1:p1", signature: "c" });
  assert.equal(heard.length, 1, "nothing is heard once unwatched");
  connection.unwatchConversation("w1:p1");
  assert.equal(sockets[1].sent.filter(message => message.type === "unwatch-conversation").length, 1);
  connection.pause();
});
