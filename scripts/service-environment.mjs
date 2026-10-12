import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// `systemctl show --property=Environment --value` joins the assignments with
// spaces and quotes one that holds a space, escaping \, ", $ and ` inside.
// Splitting on spaces would cut "HERDR_BIN=/opt/Herdr Tools/herdr" apart.
export function parseSystemdEnvironment(text) {
  const assignments = [];
  let current = null;
  let quoted = false;
  const source = String(text ?? "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      current = (current ?? "") + source[index + 1];
      index += 1;
    } else if (character === "\"") {
      quoted = !quoted;
      current ??= "";
    } else if (/\s/u.test(character) && !quoted) {
      if (current !== null) assignments.push(current);
      current = null;
    } else {
      current = (current ?? "") + character;
    }
  }
  if (current !== null) assignments.push(current);
  const environment = new Map();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator > 0) environment.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return environment;
}

// Prints one variable from that output on stdin, or nothing when it is unset.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const name = process.argv[2];
  const value = parseSystemdEnvironment(readFileSync(0, "utf8")).get(name);
  if (value !== undefined) process.stdout.write(`${value}\n`);
}
