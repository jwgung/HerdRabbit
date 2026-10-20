// What both installers -- the plugin installer (install-plugin.mjs) and the
// older systemd service installer (install-service.mjs) -- ask of the
// machine: Tailscale, whether an address answers as HerdRabbit, and a
// command run on the terminal.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function tailscaleDetails() {
  try {
    const { stdout: statusSource } = await execFileAsync(
      "tailscale",
      ["status", "--json"],
    );
    const status = JSON.parse(statusSource);
    let serve = {};
    try {
      const { stdout: serveSource } = await execFileAsync(
        "tailscale",
        ["serve", "status", "--json"],
      );
      serve = JSON.parse(serveSource);
    } catch {}
    const hostname = String(status.Self?.DNSName || "").replace(/\.$/, "");
    const address = (Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [])
      .find((item) => !String(item).includes(":")) || "";
    const usedHttpsPorts = new Set(
      Object.entries(serve.TCP || {})
        .filter(([, value]) => value?.HTTPS === true)
        .map(([port]) => Number(port))
        .filter(Number.isInteger),
    );
    return {
      available: status.BackendState === "Running" && hostname !== "",
      hostname,
      address,
      usedHttpsPorts,
    };
  } catch {
    return { available: false, hostname: "", address: "", usedHttpsPorts: new Set() };
  }
}

// true when HerdRabbit answered, false when something else did, null when the
// address could not be reached at all.
export async function reachesHerdRabbit(address) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(address, { redirect: "manual" });
      // Every HerdRabbit response carries the launch-token header name in its
      // allowed set; the login page is served even before authentication.
      const body = response.status < 400 ? await response.text() : "";
      return body.includes("HerdRabbit") ? true : false;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

export function runInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}
