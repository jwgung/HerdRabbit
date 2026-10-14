import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { callHerdrSocket } from "../src/herdr-rpc.mjs";

const wrapError = ({ code, message }) => new HerdrCommandError(message, { code });

// A unix socket server; `onRequest(socket, request)` answers the one JSON line.
// Its sockets and the directory are cleaned up when the test ends.
async function fakeSocket(context, onRequest) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-rpc-"));
  const socketPath = join(directory, "herdr.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(buffer.slice(0, boundary));
      buffer = "";
      onRequest(socket, request);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

const call = (socketPath, options = {}) =>
  callHerdrSocket({ socketPath, method: "tab.move", params: { tab_id: "w1:t1" }, wrapError, timeoutMs: 2_000, ...options });

const failsWith = (code, message) => (error) =>
  error instanceof HerdrCommandError && error.code === code && (message === undefined || error.message === message);

test("a reply with the same id resolves to its result", async (context) => {
  const socketPath = await fakeSocket(context, (socket, request) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "tab_list" } })}\n`);
  });
  assert.deepEqual(await call(socketPath), { type: "tab_list" });
});

test("replies for other ids are ignored and the matching one is taken, even in the same chunk", async (context) => {
  const socketPath = await fakeSocket(context, (socket, request) => {
    socket.write([
      JSON.stringify({ id: "someone-else", error: { code: "x", message: "not ours" } }),
      JSON.stringify({ id: "other", result: { type: "wrong" } }),
      "",
      JSON.stringify({ id: request.id, result: { type: "right" } }),
    ].join("\n") + "\n");
  });
  assert.deepEqual(await call(socketPath), { type: "right" });
});

test("Herdr's own error keeps its code and short words; a long or non-text message is replaced", async (context) => {
  const answers = [
    { error: { code: "tab_move_failed", message: "insert_index 9 is out of bounds" } },
    { error: { code: 42, message: "m".repeat(301) } },
  ];
  const socketPath = await fakeSocket(context, (socket, request) => {
    socket.write(`${JSON.stringify({ id: request.id, ...answers.shift() })}\n`);
  });
  await assert.rejects(call(socketPath), failsWith("tab_move_failed", "insert_index 9 is out of bounds"));
  await assert.rejects(call(socketPath), failsWith("herdr_command_failed", "Herdr command failed"));
});

test("a socket that is not there is server_unavailable", async () => {
  const missing = join(tmpdir(), `herdrabbit-no-such-${process.pid}`, "herdr.sock");
  await assert.rejects(call(missing), failsWith("server_unavailable", "Herdr socket is unavailable"));
});

test("an injected opener that fails is server_unavailable too", async () => {
  await assert.rejects(
    call("/unused", { openSocket: async () => { throw new Error("no forward"); } }),
    failsWith("server_unavailable"),
  );
});

test("closing before any reply is herdr_command_failed", async (context) => {
  const socketPath = await fakeSocket(context, (socket) => socket.end());
  await assert.rejects(call(socketPath), failsWith("herdr_command_failed", "Herdr command failed"));
});

test("a line that is not JSON is invalid_herdr_response", async (context) => {
  const socketPath = await fakeSocket(context, (socket) => socket.write("this is not json\n"));
  await assert.rejects(call(socketPath), failsWith("invalid_herdr_response", "Herdr returned invalid JSON"));
});

test("a reply over 2 MiB without ending is invalid_herdr_response", async (context) => {
  const socketPath = await fakeSocket(context, (socket) => socket.write("a".repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(call(socketPath), failsWith("invalid_herdr_response", "Herdr returned too much"));
});

test("no reply in time is herdr_timeout, and the socket is let go", async (context) => {
  let served = null;
  const socketPath = await fakeSocket(context, (socket) => { served = socket; });
  await assert.rejects(call(socketPath, { timeoutMs: 40 }), failsWith("herdr_timeout", "Herdr command timed out"));
  if (served && !served.destroyed) await once(served, "close");
  assert.equal(served.destroyed, true);
});

test("a timeout that fires while the socket is still opening ends the call and closes it afterwards", async () => {
  let opened = null;
  const openSocket = () => new Promise((resolve) => setTimeout(() => {
    opened = { destroyed: false, destroy() { this.destroyed = true; } };
    resolve(opened);
  }, 80));
  await assert.rejects(call("/unused", { openSocket, timeoutMs: 20 }), failsWith("herdr_timeout"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(opened.destroyed, true);
});
