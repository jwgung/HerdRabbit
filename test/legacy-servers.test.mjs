import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countLegacyServers } from "../src/legacy-servers.mjs";

async function folder(context) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-legacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("no saved links file means nothing to tell", async (context) => {
  assert.equal(await countLegacyServers(join(await folder(context), "servers.json")), 0);
});

test("counts the leaf links an older version saved, and leaves the file alone", async (context) => {
  const file = join(await folder(context), "servers.json");
  const source = JSON.stringify([
    { id: "link_11111111-1111-1111-1111-111111111111", name: "Dev", address: "http://100.64.0.9:38787", transport: "link" },
    { id: "link_22222222-2222-2222-2222-222222222222", name: "Lab", address: "http://100.64.0.10:38787", transport: "link" },
  ]);
  await writeFile(file, source);
  assert.equal(await countLegacyServers(file), 2);
  assert.equal(await readFile(file, "utf8"), source, "the owner's file is not changed or removed");
});

test("an empty list or an unreadable file is handled without crashing", async (context) => {
  const directory = await folder(context);
  await writeFile(join(directory, "empty.json"), "[]");
  assert.equal(await countLegacyServers(join(directory, "empty.json")), 0);
  await writeFile(join(directory, "broken.json"), "{not json");
  assert.equal(await countLegacyServers(join(directory, "broken.json")), 1, "something was saved, so say so");
  await writeFile(join(directory, "blank.json"), "  \n");
  assert.equal(await countLegacyServers(join(directory, "blank.json")), 0);
});
