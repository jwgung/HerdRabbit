import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExistingUnit, serviceUnit } from "../scripts/install-service.mjs";

async function unitFile(context, contents) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-unit-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "herdrabbit.service");
  if (contents !== null) await writeFile(file, contents);
  return file;
}

const hubUnit = `[Service]
Environment="HERDR_WEB_PORT=38787"
Environment="HERDR_WEB_HOST=127.0.0.1"
`;
const leafUnit = `[Service]
Environment="HERDR_WEB_PORT=38787"
Environment="HERDR_WEB_HOST=100.101.171.95"
Environment="HERDR_WEB_ROLE=leaf"
Environment="HERDR_WEB_PEER_ADDRESSES=100.64.0.9"
`;

test("reads what a machine already is, and whether it was a leaf", async (context) => {
  assert.deepEqual(await readExistingUnit(await unitFile(context, hubUnit)), { port: 38787, wasLeaf: false });
  assert.deepEqual(await readExistingUnit(await unitFile(context, leafUnit)), { port: 38787, wasLeaf: true });
  // A machine with no unit yet is a fresh install.
  assert.deepEqual(await readExistingUnit(await unitFile(context, null)), { port: null, wasLeaf: false });
});

test("the installer writes only a normal unit: loopback, no leaf settings", () => {
  const common = { nodeBin: "/usr/bin/node", herdrBin: "herdr", authFile: "/tmp/auth.json", port: 38787, hostname: "box.ts.net" };
  // Leaf options an old caller might still pass change nothing.
  for (const unit of [serviceUnit(common), serviceUnit({ ...common, leaf: { addresses: ["100.64.0.9"] }, bindHost: "100.101.171.95" })]) {
    assert.ok(!unit.includes("HERDR_WEB_ROLE"));
    assert.ok(!unit.includes("HERDR_WEB_PEER_ADDRESSES"));
    assert.ok(!unit.includes("HERDR_WEB_HUB"));
    assert.match(unit, /HERDR_WEB_HOST=127\.0\.0\.1/u);
    assert.match(unit, /HERDR_WEB_ALLOWED_HOSTS=box\.ts\.net/u);
  }
});
