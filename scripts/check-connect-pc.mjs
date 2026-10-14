// Browser check of Connect PC: the + menu opens the dialog, the tailnet's PCs
// are listed with why each can or cannot be connected, Test connection then
// Save puts the PC in the sidebar with its sessions, and its row menu renames,
// shows Details (app version and connection protocol beside this PC's) and
// disconnects. A PC on another protocol stays offline with both versions and
// offers Find new address. A connected PC's pane is mirrored (no find, no
// chat yet) and its sessions still drag. Everything runs in this process: a
// page, and a second HerdRabbit's Connect PC port on loopback, each with a
// fake herdr. CONNECT_PC_SCREENSHOTS=<folder> keeps pictures.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { ServerProfiles } from "../src/server-profiles.mjs";
// The release this PC reports, whatever package.json says.
const HUB_VERSION = "1.2.47";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "hs_ZGVmYXVsdA";
const id = (value) => `${SESSION}~${value}`;
const scoped = { herdr_session_id: SESSION };

// A machine's own Herdr, already scoped by session the way the bridge client
// reports it.
function machine(label, tabs) {
  const calls = [];
  const state = {
    herdr_sessions: [{ session_id: SESSION, name: "default", running: true, available: true, default: true }],
    workspaces: [{ workspace_id: id("w1"), label, ...scoped }],
    tabs: tabs.map((tab, index) => ({ tab_id: id(`w1:t${index + 1}`), workspace_id: id("w1"), label: tab.label, ...scoped })),
    panes: tabs.map((tab, index) => ({
      pane_id: id(`w1:p${index + 1}`), tab_id: id(`w1:t${index + 1}`), workspace_id: id("w1"), cwd: "/work/desk", ...scoped,
      ...(tab.agent ? { agent: tab.agent, agent_session: { agent: tab.agent, kind: "id", value: "0b7d5d2a-5c1e-4c55-9f0c-2b6f1f4a9c11" } } : {}),
    })),
    agents: [],
  };
  return {
    calls,
    async snapshot() { return structuredClone(state); },
    async readPane() { return `${label} mirrored screen\n$ `; },
    async sendText(...args) { calls.push(["sendText", ...args]); },
    async sendKeys(...args) { calls.push(["sendKeys", ...args]); },
    async moveTab(tabId, insertIndex) {
      calls.push(["moveTab", tabId, insertIndex]);
      const tab = state.tabs.find((item) => item.tab_id === tabId);
      const rest = state.tabs.filter((item) => item !== tab);
      rest.splice(insertIndex > rest.indexOf(tab) ? insertIndex - 1 : insertIndex, 0, tab);
      state.tabs = rest;
    },
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

// The PC being connected to, on the same app protocol but another release.
const desk = machine("Desk work", [{ label: "Agent", agent: "claude" }, { label: "Logs" }]);
const deskServer = createPeerServer({
  peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
  link: leafLinkRoutes({ client: desk, version: "9.9.9", serverName: "desk" }),
  logger: { error() {} },
});
const deskAddress = await listen(deskServer);
// A PC on another link protocol.
const olderRoutes = leafLinkRoutes({ client: machine("Old work", [{ label: "shell" }]), version: "0.9.0", serverName: "old" });
const olderServer = createPeerServer({
  peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
  link: async (request, response, url, method) => {
    const end = response.end.bind(response);
    response.end = (body, ...rest) => {
      if (typeof body === "string") {
        body = body.replace(/"link_protocol":\d+/u, '"link_protocol":99');
        response.setHeader("Content-Length", Buffer.byteLength(body));
      }
      return end(body, ...rest);
    };
    return olderRoutes(request, response, url, method);
  },
  logger: { error() {} },
});
const olderAddress = await listen(olderServer);

const directory = await mkdtemp(join(tmpdir(), "herdrabbit-connect-pc-check-"));
const profiles = await ServerProfiles.load(join(directory, "servers.json"));
const laptop = machine("Laptop work", [{ label: "shell" }]);
const herdr = new MultiServerClient({ local: laptop, profiles, hubVersion: HUB_VERSION, machineName: (profile) => profile.id === "local" ? "laptop" : null });
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId, timeoutMs) => {
    // The connected PC's client refuses (attach_unsupported); this one attaches.
    if (paneId.includes("!")) return herdr.terminalTarget(paneId, timeoutMs);
    return { command: "herdr", args: ["terminal", "attach", "term_1"], env: {}, terminalId: "term_1" };
  },
  spawnPty: (options) => {
    setTimeout(() => options.onData("\x1b[H\x1b[2Jlaptop attached\r\n$ "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, kill() {} };
  },
});
const discover = async (known) => ({
  available: true,
  self: { name: "laptop", address: "100.64.0.1" },
  candidates: [
    { name: "desk", address: deskAddress, state: known.includes(deskAddress) ? "added" : "ready", version: "9.9.9" },
    { name: "old", address: olderAddress, state: "incompatible", version: "0.9.0", reason: "old runs HerdRabbit 0.9.0 with connection protocol 99" },
    { name: "strict", address: "http://100.64.0.5:38788", state: "refused", reason: "does not allow this PC" },
    { name: "phone", address: "http://100.64.0.6:38788", state: "offline", reason: "offline" },
  ],
});
const { server } = createHerdrHttpServer({
  herdr, attachments, profiles, discover,
  connectPc: { address: "http://100.64.0.1:38788", allowed: 1 },
  logger: { info() {}, error() {} },
});
const url = await listen(server);
const shots = process.env.CONNECT_PC_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

const heading = (name) => `.server-heading:has(strong:text-is("${name}"))`;
async function details(page, name) {
  await page.locator(`${heading(name)} .server-action-menu summary`).click();
  await page.getByRole("menuitem", { name: "Details" }).click();
  const rows = await page.evaluate(() => {
    const list = document.querySelector("#server-details");
    return Object.fromEntries([...list.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling.textContent]));
  });
  await page.locator("#server-details-close").click();
  return rows;
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(url);
  await page.locator(heading("Local")).waitFor();

  // This PC's Details says where its own Connect PC port is.
  const here = await details(page, "Local");
  assert.equal(here.Kind, "This PC");
  assert.equal(here["Connection protocol"], "1");
  assert.equal(here["Connect PC port"], "http://100.64.0.1:38788 (1 allowed)");

  // + → Connect PC lists the tailnet, with a reason for what cannot be added.
  await page.locator("#add-menu summary").click();
  await page.locator("#manage-servers").click();
  await page.locator(".server-candidate.is-ready").waitFor();
  const rows = await page.evaluate(() => [...document.querySelectorAll(".server-candidate")].map((row) => ({
    name: row.querySelector("strong").textContent, state: row.querySelector(".server-candidate-state").textContent, disabled: row.disabled,
  })));
  assert.deepEqual(rows, [
    { name: "desk", state: "Ready", disabled: false },
    { name: "strict", state: "Does not allow this PC", disabled: true },
    { name: "old", state: "Other protocol", disabled: true },
  ]);
  assert.match(await page.locator("#server-rest").textContent(), /1 other PC/u);
  assert.equal(await page.locator('#server-form button[type="submit"]').isDisabled(), true, "Save waits for a test");
  await page.locator('.server-candidate:has(strong:text-is("desk"))').click();
  await page.locator("#server-test").click();
  await page.waitForFunction(() => /Connected to HerdRabbit 9\.9\.9/u.test(document.querySelector("#server-feedback").textContent));
  if (shots) await page.screenshot({ path: join(shots, "connect-pc-dialog.png") });
  await page.locator('#server-form button[type="submit"]').click();
  await page.waitForFunction(() => /Saved/u.test(document.querySelector("#server-feedback").textContent));

  // A typed address goes through the same test: the old PC answers on another protocol.
  await page.locator("#server-manual summary").click();
  await page.locator("#server-manual-address").fill(olderAddress);
  await page.locator("#server-name").fill("old");
  await page.locator("#server-test").click();
  await page.waitForFunction(() => document.querySelector("#server-feedback").dataset.error === "true");
  const refused = await page.locator("#server-feedback").textContent();
  assert.match(refused, /0\.9\.0 with connection protocol 99/u);
  assert.ok(refused.includes(`HerdRabbit ${HUB_VERSION}, protocol 1`), refused);
  await page.locator("#server-close").click();

  // desk's sessions sit under its own row, on a different release.
  await page.locator(heading("desk")).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".server-heading")].some((row) =>
    row.textContent.includes("desk") && row.classList.contains("is-online")));
  const deskInfo = await details(page, "desk");
  assert.equal(deskInfo.Kind, "Connect PC");
  assert.equal(deskInfo.HerdRabbit, `9.9.9 (this PC: ${HUB_VERSION})`);
  assert.equal(deskInfo["Connection protocol"], "1");
  assert.equal(deskInfo.Address, deskAddress);

  // Its pane is a mirror: no find, and chat says it is not there yet.
  const deskPane = `${(await profiles.list())[0].id}!${id("w1:p1")}`;
  await page.locator(`.pane-button[data-pane-id="${deskPane}"]`).click();
  await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("Desk work mirrored screen"));
  await page.waitForFunction(() => document.querySelector("#terminal-find-open")?.getAttribute("aria-disabled") === "true");
  await page.waitForFunction(() => document.querySelector("#lens-chat")?.getAttribute("aria-disabled") === "true" &&
    /Connect PC/u.test(document.querySelector("#lens-chat").title));
  if (shots) await page.screenshot({ path: join(shots, "connect-pc-mirror.png") });

  // Its sessions drag, and the move happens on desk.
  const second = await page.locator(`.tab-group:has(.pane-button[data-pane-id="${deskPane.replace("w1:p1", "w1:p2")}"])`).boundingBox();
  const first = await page.locator(`.tab-group:has(.pane-button[data-pane-id="${deskPane}"])`).boundingBox();
  await page.mouse.move(second.x + 40, second.y + second.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(second.x + 40, second.y + second.height / 2 + ((first.y + 3 - (second.y + second.height / 2)) * step) / 12);
  }
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForFunction(() => true);
  for (let attempt = 0; attempt < 30 && !desk.calls.some(([name]) => name === "moveTab"); attempt += 1) await page.waitForTimeout(100);
  assert.deepEqual(desk.calls.find(([name]) => name === "moveTab"), ["moveTab", id("w1:t2"), 0]);

  // Rename, then a PC on another protocol: offline, both versions, Find new address.
  await page.locator(`${heading("desk")} .server-action-menu summary`).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator(".server-heading input").fill("desk tower");
  await page.keyboard.press("Enter");
  await page.locator(heading("desk tower")).waitFor();
  assert.equal((await profiles.list())[0].name, "desk tower");

  await profiles.save({ name: "old", address: olderAddress });
  await page.locator(heading("old")).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".server-heading")].some((row) =>
    row.textContent.includes("old") && row.textContent.includes("Offline")));
  const oldInfo = await details(page, "old");
  assert.equal(oldInfo.HerdRabbit, `0.9.0 (this PC: ${HUB_VERSION})`);
  assert.equal(oldInfo["Connection protocol"], "99 (this PC: 1)");
  assert.match(oldInfo.Status, /protocol 99.*protocol 1/u);
  await page.locator(`${heading("old")} .server-action-menu summary`).click();
  assert.equal(await page.getByRole("menuitem", { name: "Find new address" }).count(), 1);
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await page.locator(heading("old")).waitFor({ state: "detached" });
  assert.deepEqual((await profiles.list()).map((profile) => profile.name), ["desk tower"]);
  if (shots) await page.screenshot({ path: join(shots, "connect-pc-sidebar.png") });

  assert.deepEqual(errors, []);
  console.log("Connect PC (dialog, test and save, typed address, Details, mirror, drag, rename, other protocol, disconnect): passed");
} finally {
  await browser.close();
  herdr.stopped = true;
  attachments.close();
  for (const each of [server, deskServer, olderServer]) {
    each.closeAllConnections();
    await new Promise((resolve) => each.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
