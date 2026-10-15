import test from "node:test";
import assert from "node:assert/strict";
import { countLegacyMachines } from "../src/legacy-machines.mjs";

test("counts the Herdr SSH machines `herdr machine list` still names, without changing them", async () => {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    return { stdout: JSON.stringify([{ id: "a", target: "me@lab" }, { id: "b", target: "me@desk" }]) };
  };
  assert.equal(await countLegacyMachines({ binary: "/opt/herdr", run }), 2);
  assert.deepEqual(calls, [["/opt/herdr", "machine", "list", "--json"]], "only listed, never added or removed");
});

test("a listing that fails or says nothing usable counts as none, so no notice is shown", async () => {
  assert.equal(await countLegacyMachines({ run: async () => { throw new Error("unknown command: machine"); } }), 0);
  assert.equal(await countLegacyMachines({ run: async () => ({ stdout: "not json" }) }), 0);
  assert.equal(await countLegacyMachines({ run: async () => ({ stdout: "{}" }) }), 0);
  assert.equal(await countLegacyMachines({ run: async () => ({ stdout: "[]" }) }), 0);
});
