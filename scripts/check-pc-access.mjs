// Browser check of Settings → PCs → "Let other PCs connect": with sign-in on,
// the PCs page says whether this PC's Connect PC port is open and to whom.
// Choose PCs… offers All my PCs (chosen first on a closed port), Only these
// (the tailnet's devices, name over address, Offline marked) and No other PC.
// Save asks for the password, writes the plugin's .env (a temporary one here)
// and restarts, and the row says so until the server answers again. A wrong password
// writes nothing. With sign-in off the row is not shown. On a phone the
// choices are 44px rows and nothing is wider than the screen. Runs against an
// in-process fake herdr; Tailscale and the restart are stand-ins.
//
// PC_ACCESS_SHOTS=<folder> keeps pictures.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectPcAccess } from "../src/connect-pc-access.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { ENV_TEMPLATE, parseEnvFile } from "../src/plugin-runner.mjs";
import { ServerProfiles } from "../src/server-profiles.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "hs_local";
const TAILNET = {
  available: true,
  self: { name: "mini", fullName: "mini.t.ts.net", address: "100.96.0.2", login: "me@example.com" },
  peers: [
    { name: "laptop", fullName: "laptop.t.ts.net", address: "100.101.0.3", online: true },
    { name: "phone", fullName: "phone.t.ts.net", address: "100.110.0.4", online: false },
  ],
};

const directory = await mkdtemp(join(tmpdir(), "check-pc-access-"));
const envFile = join(directory, ".env");
const profiles = await ServerProfiles.load(join(directory, "servers.json"));
let restarts = 0;
let access;
// The restart: a new manager reads what was written, as the new server would.
async function reload() {
  const values = parseEnvFile(await readFile(envFile, "utf8"));
  access = new ConnectPcAccess({
    envFile,
    pagePort: 38787,
    current: {
      host: values.HERDR_WEB_PEER_HOST || null, port: 38788,
      addresses: values.HERDR_WEB_PEER_ADDRESSES ? values.HERDR_WEB_PEER_ADDRESSES.split(",") : [],
      logins: values.HERDR_WEB_PEER_LOGINS ? values.HERDR_WEB_PEER_LOGINS.split(",") : [],
    },
    readTailnet: async () => TAILNET,
    // the tailnet address is a stand-in, so the port is taken to open there
    canListen: async () => null,
    restart: async () => { restarts += 1; setTimeout(() => void reload(), 200); },
  });
}

const herdr = {
  async snapshot() {
    return {
      servers: [{ id: "local", name: "mini", machine: "mini", transport: "local", available: true, status: "Connected" }],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "mini" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" }],
      agents: [],
    };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
};

function startServer(required) {
  const { server } = createHerdrHttpServer({
    herdr,
    profiles,
    connectPcAccess: { state: (...args) => access.state(...args), save: (...args) => access.save(...args) },
    auth: {
      required, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {},
      verifyPassword: async (password) => password === "secret",
    },
    logger: { info() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  return server;
}

const signedIn = startServer(true);
const signedOut = startServer(false);
await Promise.all([once(signedIn, "listening"), once(signedOut, "listening")]);
const url = (server) => `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.PC_ACCESS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    await writeFile(envFile, `HERDR_WEB_PORT=38787\n${ENV_TEMPLATE}`, { mode: 0o600 });
    restarts = 0;
    await reload();
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const dialog = page.locator("#settings-dialog");
    const openPcs = async (server) => {
      await page.goto(`${url(server)}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
      if (mobile) {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400);
      }
      await page.locator("#settings-open").click();
      await dialog.waitFor({ state: "visible" });
      await dialog.locator(".settings-page-link", { hasText: "PCs" }).click();
      await dialog.locator('.settings-page[data-page="pcs"]').waitFor({ state: "visible" });
    };
    const hint = page.locator("#settings-pc-access-hint");

    // Sign-in off: no row.
    await openPcs(signedOut);
    assert.equal(await page.locator("#settings-pc-access").isVisible(), false, `${where}: shown with sign-in off`);

    // Closed; Choose PCs… starts on All my PCs.
    await openPcs(signedIn);
    await page.locator("#settings-pc-access").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#settings-pc-access-hint").textContent.startsWith("Closed"));
    const choose = page.locator("#pc-access-dialog");
    const pick = async (value) => {
      await page.locator("#settings-pc-access-change").click();
      await choose.waitFor({ state: "visible" });
      if (value) await choose.locator(`.pc-access-mode:has(input[value="${value}"])`).click();
    };
    const save = async (password = "secret") => {
      await page.locator("#pc-access-password").fill(password);
      await page.locator("#pc-access-save").click();
    };
    const env = async () => parseEnvFile(await readFile(envFile, "utf8"));
    await pick(null);
    assert.equal(await choose.locator('input[value="mine"]').isChecked(), true);
    assert.equal(await page.locator("#pc-access-mine-hint").textContent(), "Every device signed in to Tailscale as me@example.com, those added later too");
    assert.equal(await page.locator("#pc-access-choices").isVisible(), false, `${where}: the device list shows for All my PCs`);
    if (mobile) {
      for (const box of await choose.locator(".pc-access-mode").evaluateAll((items) => items.map((row) => row.getBoundingClientRect().height))) {
        assert.ok(box >= 44, `${where}: a choice is under 44px (${box})`);
      }
      const overflow = await choose.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: the dialog is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `mine-${where}.png`) });

    // A wrong password writes nothing.
    await save("nope");
    await page.locator("#pc-access-feedback", { hasText: "incorrect" }).waitFor();
    assert.equal((await env()).HERDR_WEB_PEER_HOST, undefined);
    assert.equal(restarts, 0);

    await save();
    await choose.waitFor({ state: "hidden" });
    assert.equal((await env()).HERDR_WEB_PEER_HOST, "100.96.0.2");
    assert.equal((await env()).HERDR_WEB_PEER_LOGINS, "me@example.com");
    assert.equal((await env()).HERDR_WEB_PEER_ADDRESSES, undefined);
    assert.equal((await env()).HERDR_WEB_PORT, "38787");
    assert.equal(restarts, 1);
    await page.waitForFunction(() => document.querySelector("#settings-pc-access-hint").textContent === "Open at http://100.96.0.2:38788 to all your PCs (me@example.com).");

    // Only these: the device list, the laptop ticked.
    await pick("some");
    const rows = choose.locator(".pc-access-choice");
    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => [
      row.querySelector("strong").textContent, row.querySelector("small").textContent,
      row.querySelector("input").checked, Boolean(row.querySelector(".ui-badge")),
    ])), [["laptop", "100.101.0.3", false, false], ["phone", "100.110.0.4", false, true]]);
    await save();
    await page.locator("#pc-access-feedback", { hasText: "Tick the devices" }).waitFor();
    await rows.first().click();
    if (shots) await page.screenshot({ path: join(shots, `some-${where}.png`) });
    await save();
    await choose.waitFor({ state: "hidden" });
    assert.equal((await env()).HERDR_WEB_PEER_ADDRESSES, "100.101.0.3");
    assert.equal((await env()).HERDR_WEB_PEER_LOGINS, undefined);
    await page.waitForFunction(() => document.querySelector("#settings-pc-access-hint").textContent === "Open at http://100.96.0.2:38788 to laptop.");

    // No other PC closes it.
    await pick("none");
    await save();
    await choose.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#settings-pc-access-hint").textContent.startsWith("Closed"));
    assert.equal((await env()).HERDR_WEB_PEER_HOST, undefined);
    assert.equal(await hint.getAttribute("data-error"), "false");

    assert.deepEqual(errors, [], `${where}: page errors`);
    await context.close();
  }
  console.log("PC access OK: all my PCs, only these, closed, wrong password, sign-in off, desktop and phone");
} finally {
  await browser.close();
  signedIn.close();
  signedOut.close();
  await rm(directory, { recursive: true, force: true });
}
