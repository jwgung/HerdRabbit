import test from "node:test";
import assert from "node:assert/strict";
import { discover, NOT_BROWSER } from "../scripts/run-browser-checks.mjs";

test("every scripts/check-*.mjs is either run as a browser check or named as not one", async () => {
  const { found, unknown } = await discover();
  assert.deepEqual(unknown, [], "a check that loads no Playwright must be listed in NOT_BROWSER");
  assert.ok(found.length >= 18, `browser checks found: ${found.length}`);
  for (const name of NOT_BROWSER) assert.ok(!found.includes(name));
});
