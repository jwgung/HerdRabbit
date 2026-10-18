// Runs `herdr update --handoff` for the page's Update Herdr button.
// HerdRabbit starts this with systemd-run in a transient unit of its own
// (src/herdr-update.mjs), outside its service and outside any Herdr pane.
// The arguments are HerdRabbit's update state folder, where the log and the
// outcome go, and the absolute path of the Herdr to update.
import { runHerdrUpdateScript } from "../src/herdr-update.mjs";

const [stateDir, binary] = process.argv.slice(2);
if (!stateDir || !binary?.startsWith("/") || process.argv.length !== 4) {
  console.error("Usage: node scripts/run-herdr-update.mjs <update state folder> <absolute path to herdr>");
  process.exit(2);
}
process.exitCode = await runHerdrUpdateScript({ stateDir, binary }) === 0 ? 0 : 1;
