import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readAppSource } from "./app-source.mjs";

const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readAppSource();

test("several files go up at once, from the picker, a drop or a paste", () => {
  assert.match(page, /<input id="transfer-file" type="file" multiple class="visually-hidden" \/>/u);
  assert.doesNotMatch(app, /Drop one file at a time|files\?\.\[0\]/u, "no file is dropped on the floor");
  const accept = app.match(/function acceptDroppedFiles\(list, report, onUploaded\) \{[\s\S]*?\n {0,2}\}/u)?.[0];
  assert.ok(accept, "acceptDroppedFiles must exist");
  assert.match(accept, /uploadFiles\(files, \{ report \}\)/u);
  const upload = app.match(/async function uploadFiles\(files, \{ report = setFeedback \} = \{\}\) \{[\s\S]*?\n {0,2}\}/u)?.[0];
  assert.ok(upload, "uploadFiles must exist");
  // One at a time and in order, so the paths land in the order the files were given.
  assert.match(upload, /for \(const \[index, file\] of list\.entries\(\)\) \{[\s\S]*?await transferRequest\(/u);
  // A failure is set aside and the rest still upload.
  assert.match(upload, /catch \(error\) \{\s*failed\.push\(/u);
  assert.match(upload, /report\(uploadSummary\(/u);
  // The dialog stays open while anything failed, so the reason stays visible.
  assert.match(app, /const saved = await uploadFiles\(files, \{ report: setTransferFeedback \}\);[\s\S]*?if \(saved\.length === files\.length\) elements\.transferDialog\.close\(\);/u);
});
