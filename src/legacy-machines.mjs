import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Herdr's own SSH machines (`herdr machine add`) used to be listed beside this
// PC; remote PCs now run HerdRabbit and are added with Connect PC. Herdr's
// list is the owner's and is left as it is -- it is only counted, so the page
// can say once how to bring those PCs back. A Herdr without `machine`, or one
// that does not answer, counts as none: no notice rather than a wrong one.
export async function countLegacyMachines({ binary = "herdr", run = execFileAsync } = {}) {
  try {
    const { stdout } = await run(binary, ["machine", "list", "--json"], { encoding: "utf8", timeout: 10_000 });
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}
