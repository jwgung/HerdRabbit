// Runs update.sh for the page's Update button. HerdRabbit starts this with
// systemd-run in a transient unit of its own (src/app-update.mjs), so the
// service restart update.sh ends with does not stop it. The one argument is
// HerdRabbit's update state folder, where the log and the outcome go.
//
// Under Herdr as a plugin it is started detached instead, with
// `--plugin <id> <herdr>`: Herdr updates that plugin and restarts it.
import { runPluginUpdate, runUpdateScript } from "../src/app-update.mjs";

const [stateDir, flag, id, binary] = process.argv.slice(2);
const plugin = flag === "--plugin" && process.argv.length === 6;
if (!stateDir || (process.argv.length !== 3 && !plugin)) {
  console.error("Usage: node scripts/run-update.mjs <update state folder> [--plugin <id> <herdr>]");
  process.exit(2);
}
const exitCode = plugin ? await runPluginUpdate({ stateDir, id, binary }) : await runUpdateScript({ stateDir });
process.exitCode = exitCode === 0 ? 0 : 1;
