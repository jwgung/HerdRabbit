import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const userFacingSources = [
  "../public/index.html",
  "../public/app.js",
  "../public/ui-model.js",
  "../public/push-notifications.js",
  "../public/sw.js",
  "../src/agent-notifications.mjs",
  "../src/passkey-auth.mjs",
  "../src/http-server.mjs",
  "../src/file-browser.mjs",
  "../src/ai-accounts.mjs",
  "../src/ai-account-adapters.mjs",
];

test("uses English only for application UI and user-facing messages", async () => {
  for (const relativePath of userFacingSources) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /[가-힣]/u, `${relativePath} contains Korean UI copy`);
  }
});

test("uses concise, natural status copy", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const notifications = await readFile(
    new URL("../src/agent-notifications.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(app, /earlier history/iu);
  assert.match(app, /Loading history…/u);
  assert.match(app, /Could not load history:/u);
  assert.match(app, /Beginning of history\./u);
  assert.match(app, /Creating project…/u);
  assert.match(app, /Signing in…/u);
  assert.match(notifications, /Waiting for your input\./u);
});
