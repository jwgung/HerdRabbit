// The worker thread that reads OpenCode's database for localOpencodeStore, so
// a large page never holds the server's event loop. It answers only the named
// OPERATIONS, each running only STATEMENTS by name (opencode.mjs's reader, the
// same code the store runs in its own thread when no worker starts).
import { parentPort, workerData } from "node:worker_threads";
import { answerRequest, opencodeReader } from "./opencode.mjs";

const { path, maxMessages, trace } = workerData;
const sqlite = await import("node:sqlite").catch(() => null);
// the statements one request prepared, sent back with its answer when the store asks to see them
let prepared = [];
const read = sqlite?.DatabaseSync
  ? opencodeReader({ DatabaseSync: sqlite.DatabaseSync, path, maxMessages, onPrepare: trace ? (sql) => prepared.push(sql) : null })
  : null;

parentPort.on("message", (request) => {
  prepared = [];
  const answer = answerRequest(read, request);
  parentPort.postMessage(trace ? { ...answer, prepared } : answer);
});
parentPort.postMessage({ ready: true });
