// Browser check of Settings → Herdr: with sign-in on the page sits between
// Plugins and Updates and shows, per machine, Herdr's update channel
// (Stable / Preview), its agent integrations with their state and one action
// each (Install…, Uninstall…, Update…, Repair…, confirmed first), and its
// config.toml as text. Check shows Herdr's diagnostics; Save… asks first,
// refuses a config Herdr rejects (the file stays as it was, the diagnostics
// show) and saves one it accepts, keeping a backup and reloading Herdr.
// Herdr's defaults show read-only. Open Updates opens Settings → Updates. A
// machine picker shows with more than one machine, and a PC on an older
// HerdRabbit says to update it there. With sign-in off there is no Herdr
// page. On a phone the controls are 44px targets and nothing is wider than
// the screen. Runs on a desktop and a phone against an in-process fake herdr
// and fake `herdr channel|integration|config` commands, with config.toml in
// a temporary folder.
//
// HERDR_SETTINGS_SHOTS=<folder> keeps pictures of the page.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { HerdrSettings } from "../src/herdr-settings.mjs";
import { fakeHerdrSettings } from "../test/fixtures/fake-herdr-settings.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const OLD = "link_22222222-2222-2222-2222-222222222222";
const SESSION = "hs_local";
const INITIAL = "onboarding = false\n\n[update]\nchannel = \"stable\"\n";

const home = await mkdtemp(join(tmpdir(), "check-herdr-settings-"));
const folder = join(home, ".config", "herdr");
const configPath = join(folder, "config.toml");
await mkdir(folder, { recursive: true });
let fake;
let settings;

const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", machine: "workstation", transport: "local", available: true, status: "Connected" },
        { id: OLD, name: "Old box", transport: "link", available: true, status: "Connected" },
      ],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" }],
      agents: [],
    };
  },
  herdrSettingsClient(id) {
    if (id !== OLD) return null;
    const tooOld = async () => {
      throw new HerdrCommandError("HerdRabbit at http://old-box:38788 is too old for changing Herdr's settings from here; update it there.", { code: "link_unsupported" });
    };
    return { state: tooOld, readConfig: tooOld, defaultConfig: tooOld, setChannel: tooOld, integration: tooOld, checkConfig: tooOld, saveConfig: tooOld };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
};

function startServer(required) {
  const { server } = createHerdrHttpServer({
    herdr,
    // Read through on each call: each run starts a fresh fake.
    herdrSettings: new Proxy({}, { get: (_, name) => (...args) => settings[name](...args) }),
    auth: { required, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {} },
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
const shots = process.env.HERDR_SETTINGS_SHOTS;
const changes = () => fake.state.calls.map((call) => call.args.join(" "))
  .filter((args) => !["--help", "channel show", "integration status", "config check", "--default-config"].includes(args));

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    for (const name of await readdir(folder)) await rm(join(folder, name), { force: true });
    await writeFile(configPath, INITIAL);
    fake = fakeHerdrSettings({ configPath });
    settings = new HerdrSettings({ run: fake.run, home });
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const confirms = [];
    let answer = true;
    page.on("dialog", (prompt) => { confirms.push(prompt.message()); void (answer ? prompt.accept() : prompt.dismiss()); });

    const dialog = page.locator("#settings-dialog");
    const openSettings = async () => {
      if (mobile && await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400); // the phone sidebar slides in
      }
      await page.locator("#settings-open").click();
      await dialog.waitFor({ state: "visible" });
    };
    const ready = (server) => page.goto(`${url(server)}/?pane=${encodeURIComponent("w1:p1")}`)
      .then(() => page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" }));

    // Sign-in off: no Herdr page.
    await ready(signedOut);
    await openSettings();
    assert.ok(!(await dialog.locator(".settings-page-link").allTextContents()).includes("Herdr"), `${where}: Herdr shows with sign-in off`);

    // Sign-in on: between Plugins and Updates (Plugins is not offered here).
    await ready(signedIn);
    await openSettings();
    const links = await dialog.locator(".settings-page-link").allTextContents();
    assert.equal(links[links.indexOf("Herdr") + 1], "Updates", `${where}: Herdr is not before Updates (${links})`);
    await dialog.locator(".settings-page-link", { hasText: "Herdr" }).click();
    const herdrPage = dialog.locator('.settings-page[data-page="herdr"]');
    await herdrPage.waitFor({ state: "visible" });
    const rows = herdrPage.locator(".herdr-integration");
    await rows.first().waitFor({ state: "visible" });
    const feedback = page.locator("#herdr-feedback");
    const editor = page.locator("#herdr-config-text");
    const idle = () => page.waitForFunction(() => !document.querySelector("[data-herdr-channel]").disabled);

    // The channel, the integrations and config.toml as Herdr has them.
    assert.equal(await page.locator('[data-herdr-channel="stable"]').getAttribute("aria-pressed"), "true");
    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => [
      row.dataset.integration, row.querySelector(".plugin-source").textContent, row.querySelector("button").textContent,
      Boolean(row.querySelector(".ui-badge")),
    ])), [
      ["pi", "Not installed", "Install…", false],
      ["claude", "Installed (v11)", "Uninstall…", false],
      ["codex", "Installed (v10)", "Uninstall…", false],
      ["opencode", "Needs repair (v13)", "Repair…", false],
      ["antigravity-cli", "Outdated (v2 < v4)", "Update…", false],
      ["letta", "Not installed", "Install…", true],
    ], `${where}: the integrations are wrong`);
    assert.equal(await editor.inputValue(), INITIAL);
    assert.equal(await page.locator("#herdr-config-path").textContent(), "~/.config/herdr/config.toml");
    assert.equal(await page.locator("#herdr-config-save").isDisabled(), true, `${where}: Save without edits`);
    assert.equal(await herdrPage.locator(".primary-button").count(), 1, `${where}: more than one primary button`);
    assert.deepEqual(await page.locator("#herdr-machine option").allTextContents(), ["This PC (workstation)", "Old box"]);

    if (mobile) {
      for (const target of ['[data-herdr-channel="preview"]', "#herdr-machine", "#herdr-open-updates", "#herdr-config-save",
        "#herdr-config-check", '.herdr-integration[data-integration="pi"] button']) {
        const box = await page.locator(target).boundingBox();
        assert.ok(box.height >= 44, `${where}: ${target} is under 44px tall (${box.height})`);
      }
      const overflow = await page.locator(".settings-body").evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: the page is wider than the screen (${overflow}px)`);
      assert.ok(await editor.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)) >= 16, `${where}: the editor zooms on focus`);
      // A touch rule for 44px inputs must not shrink the editor below its 280px.
      assert.ok((await editor.boundingBox()).height >= 280, `${where}: config.toml is under 280px tall (${(await editor.boundingBox()).height})`);
    }
    if (shots) await page.screenshot({ path: join(shots, `herdr-${where}.png`), fullPage: true });

    // Preview: Herdr's channel changes, and config.toml (unedited) is read again.
    await page.locator('[data-herdr-channel="preview"]').click();
    await page.waitForFunction(() => document.querySelector("#herdr-feedback").textContent.includes("follows Preview now"));
    await idle();
    assert.equal(await page.locator('[data-herdr-channel="preview"]').getAttribute("aria-pressed"), "true");

    // An integration asks first; declined, nothing runs.
    answer = false;
    await rows.filter({ hasText: "pi" }).first().locator("button").click();
    assert.match(confirms.at(-1), /^Install Herdr's pi integration on This PC \(workstation\)\?/u);
    answer = true;
    await rows.filter({ hasText: "claude" }).locator("button").click();
    assert.match(confirms.at(-1), /^Uninstall Herdr's claude integration on This PC \(workstation\)\?/u);
    await page.waitForFunction(() => document.querySelector("#herdr-feedback").textContent === "claude: Not installed.");
    await idle();
    assert.equal(await rows.filter({ hasText: "claude" }).locator("button").textContent(), "Install…");
    assert.deepEqual(changes(), ["channel set preview", "integration uninstall claude"]);

    // Check: Herdr's diagnostics under the editor.
    await editor.fill("onboarding = false\n\n[ui\n");
    await page.locator("#herdr-config-check").click();
    await page.locator("#herdr-config-diagnostics").waitFor({ state: "visible" });
    assert.match(await page.locator("#herdr-config-diagnostics").textContent(), /invalid table header/u);
    assert.equal(await feedback.getAttribute("data-error"), "true");

    // Save… asks first; a config Herdr refuses leaves the file as it was.
    const before = await readFile(configPath, "utf8");
    await page.locator("#herdr-config-save").click();
    assert.match(confirms.at(-1), /^Save config\.toml on This PC \(workstation\)\? Herdr checks it first/u);
    await page.waitForFunction(() => document.querySelector("#herdr-feedback").textContent.startsWith("Herdr found problems in this config. Nothing was saved."));
    assert.equal(await readFile(configPath, "utf8"), before, `${where}: a refused config was written`);

    // A config Herdr accepts is saved, with a backup, and Herdr reloads it.
    await editor.fill("onboarding = true\n");
    await page.locator("#herdr-config-check").click();
    await page.waitForFunction(() => document.querySelector("#herdr-feedback").textContent === "Herdr accepts this config.");
    assert.equal(await page.locator("#herdr-config-diagnostics").isVisible(), false);
    await page.locator("#herdr-config-save").click();
    await page.waitForFunction(() => document.querySelector("#herdr-feedback").textContent.startsWith("Saved and reloaded on This PC (workstation). The old one is config.toml.bak-"));
    assert.equal(await readFile(configPath, "utf8"), "onboarding = true\n");
    assert.equal((await readdir(folder)).filter((name) => name.startsWith("config.toml.bak-")).length, 1);
    assert.equal(await page.locator("#herdr-config-save").isDisabled(), true, `${where}: Save after saving`);
    assert.deepEqual(changes().slice(-1), ["server reload-config"]);

    // Herdr's defaults, to read.
    await herdrPage.locator('[data-herdr-config-view="default"]').click();
    const defaults = page.locator("#herdr-config-default");
    await defaults.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#herdr-config-default").value.startsWith("# herdr configuration"));
    assert.equal(await defaults.getAttribute("readonly"), "");
    if (mobile) assert.ok((await defaults.boundingBox()).height >= 280, `${where}: Herdr's defaults are under 280px tall`);
    assert.equal(await editor.isVisible(), false);
    await herdrPage.locator('[data-herdr-config-view="edit"]').click();
    await editor.waitFor({ state: "visible" });

    // A PC on an older HerdRabbit says to update it there.
    await page.locator("#herdr-machine").selectOption(OLD);
    await page.waitForFunction(() => /too old for changing Herdr's settings from here; update it there/u.test(document.querySelector("#herdr-feedback").textContent));
    await page.locator("#herdr-machine").selectOption("local");
    await rows.first().waitFor({ state: "visible" });

    // Open Updates goes to Settings → Updates.
    await page.locator("#herdr-open-updates").click();
    await dialog.locator('.settings-page[data-page="updates"]').waitFor({ state: "visible" });

    assert.deepEqual(errors, [], `${where}: page errors`);
    await context.close();
    console.log(`ok: ${where}`);
  }
} finally {
  await browser.close();
  signedIn.close();
  signedOut.close();
  await rm(home, { recursive: true, force: true });
}
