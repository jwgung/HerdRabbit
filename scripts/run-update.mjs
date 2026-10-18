// Runs update.sh for the page's Update button. HerdRabbit starts this with
// systemd-run in a transient unit of its own (src/app-update.mjs), so the
// service restart update.sh ends with does not stop it. The one argument is
// HerdRabbit's update state folder, where the log and the outcome go.
import { runUpdateScript } from "../src/app-update.mjs";

const [stateDir] = process.argv.slice(2);
if (!stateDir || process.argv.length !== 3) {
  console.error("Usage: node scripts/run-update.mjs <update state folder>");
  process.exit(2);
}
process.exitCode = await runUpdateScript({ stateDir }) === 0 ? 0 : 1;
