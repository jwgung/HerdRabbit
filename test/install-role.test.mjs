import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeerChoice, peerPortBeside, readExistingUnit, serviceUnit } from "../scripts/install-service.mjs";

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

test("reads what a PC already is, including a Connect PC port a former leaf had", async (context) => {
  assert.deepEqual(await readExistingUnit(await unitFile(context, hubUnit)), { port: 38787, wasLeaf: false, peer: null });
  assert.deepEqual(await readExistingUnit(await unitFile(context, leafUnit)), {
    port: 38787, wasLeaf: true,
    peer: { host: "100.101.171.95", port: 38787, addresses: ["100.64.0.9"], logins: [], hub: null },
  });
  const open = `${hubUnit}Environment="HERDR_WEB_PEER_HOST=100.101.171.95"
Environment="HERDR_WEB_PEER_PORT=38790"
Environment="HERDR_WEB_PEER_ADDRESSES=100.64.0.9,100.64.0.10"
`;
  assert.deepEqual((await readExistingUnit(await unitFile(context, open))).peer,
    { host: "100.101.171.95", port: 38790, addresses: ["100.64.0.9", "100.64.0.10"], logins: [], hub: null });
  // A machine with no unit yet is a fresh install.
  assert.deepEqual(await readExistingUnit(await unitFile(context, null)), { port: null, wasLeaf: false, peer: null });
});

test("the page stays on loopback; a Connect PC port is added beside it, never a leaf role", () => {
  const common = { nodeBin: "/usr/bin/node", herdrBin: "herdr", authFile: "/tmp/auth.json", port: 38787, hostname: "box.ts.net" };
  const closed = serviceUnit(common);
  assert.ok(!closed.includes("HERDR_WEB_PEER"));
  const open = serviceUnit({ ...common, peer: { host: "100.101.171.95", port: 38788, addresses: ["100.64.0.9"], logins: [], hub: null } });
  for (const unit of [closed, open]) {
    assert.ok(!unit.includes("HERDR_WEB_ROLE"));
    assert.match(unit, /HERDR_WEB_HOST=127\.0\.0\.1/u);
    assert.match(unit, /HERDR_WEB_ALLOWED_HOSTS=box\.ts\.net/u);
  }
  assert.match(open, /HERDR_WEB_PEER_HOST=100\.101\.171\.95/u);
  assert.match(open, /HERDR_WEB_PEER_PORT=38788/u);
  assert.match(open, /HERDR_WEB_PEER_ADDRESSES=100\.64\.0\.9/u);
  // An empty allowed list writes no list, which keeps the port shut.
  const shut = serviceUnit({ ...common, peer: { host: "100.101.171.95", port: 38788, addresses: [], logins: [] } });
  assert.ok(!shut.includes("HERDR_WEB_PEER_ADDRESSES"));
});

test("picks allowed PCs by number, and keeps the Connect PC port off ports Serve holds", () => {
  const peers = [{ address: "100.64.0.2" }, { address: "100.64.0.3" }];
  assert.deepEqual(parsePeerChoice("2, 1, 2", peers), ["100.64.0.3", "100.64.0.2"]);
  assert.throws(() => parsePeerChoice("3", peers), /목록에 없는 번호/u);
  assert.throws(() => parsePeerChoice("x", peers), /목록에 없는 번호/u);
  assert.equal(peerPortBeside(38788, 38787), 38788);
  // A former leaf listened on the page's port, which Serve now holds.
  assert.equal(peerPortBeside(38787, 38787), 38788);
  assert.equal(peerPortBeside(38787, 38787, new Set([38788])), 38789);
});
