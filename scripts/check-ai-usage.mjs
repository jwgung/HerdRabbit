// Browser check of usage in AI accounts: under the account in use, a meter per
// limit its CLI reports -- amber from 80% used, red from 95% -- with how long
// until each resets and which CLI said so. The CLI is asked only for the tab
// being looked at, once, and again on Refresh; a failure says why and offers
// Retry. A CLI with nobody signed in asks nothing. Runs on a desktop and a phone,
// light and dark, against an in-process fake herdr and a fake account source.
//
// AI_USAGE_SHOTS=<folder> keeps pictures of the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { AiUsageError } from "../src/ai-usage.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "hs_local";
const herdr = {
  async snapshot() {
    return {
      servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" }],
      agents: [],
    };
  },
  async sendText() {}, async sendKeys() {}, async readPane() { return "$ "; },
};

const HOUR = 3_600_000;
const account = (id, email, active = false) => ({ id, email, active, plan: null, refreshExpiresAt: null });
const signedIn = (id, label, rows) => ({ id, label, supported: true, reason: null, current: rows.find((row) => row.active) ?? null, accounts: rows, logins: [] });
let asked = [];
let kiroFails = true;
const accounts = {
  async list() {
    return { clis: [
      signedIn("claude", "Claude Code", [account("c1", "hy@example.com"), account("c2", "jw@example.com", true)]),
      signedIn("codex", "Codex", [account("x1", "jw@example.com", true)]),
      signedIn("agy", "Antigravity CLI", []),
      signedIn("kiro", "Kiro CLI", [account("k1", "jw@company.com", true)]),
    ] };
  },
  async saveCurrent(cli) { return { cli, account: null }; },
  async readUsage(cli, { refresh }) {
    asked.push([cli, refresh]);
    const meter = (label, usedPercent, extra = {}) => ({ label, usedPercent, resetsAt: null, resetsText: null, detail: null, ...extra });
    if (cli === "claude") {
      return { cli, method: "cli", checkedAt: Date.now() - 2 * 60_000, notes: [], meters: [
        meter("Session", 14, { resetsAt: Date.now() + 72 * 60_000 }),
        meter("Week · all models", 98, { resetsText: "Nov 12, 8am (Asia/Seoul)" }),
        meter("Week · Fable", 84, { resetsText: "Nov 12, 8am (Asia/Seoul)" }),
      ] };
    }
    if (cli === "codex") {
      return { cli, method: "cli", checkedAt: Date.now(), notes: ["48,192 credits left"], meters: [meter("Week", 93, { resetsAt: Date.now() + 99 * HOUR })] };
    }
    if (cli === "kiro" && kiroFails) throw new AiUsageError("Kiro did not show its usage in time");
    return { cli, method: "cli", checkedAt: Date.now(), notes: [], meters: [meter("Credits", 54.8, { resetsText: "2026-12-01", detail: "5,483 of 10,000 · KIRO POWER" })] };
  },
};

const { server } = createHerdrHttpServer({
  herdr, aiAccounts: accounts, installedAgents: { async list() { return ["claude", "codex", "agy", "kiro"]; } }, logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.AI_USAGE_SHOTS;

try {
  for (const theme of ["light", "dark"]) {
    for (const mobile of [false, true]) {
      const where = `${mobile ? "phone" : "desktop"}-${theme}`;
      asked = [];
      kiroFails = true;
      const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile, colorScheme: theme,
        viewport: { width: mobile ? 360 : 1280, height: 800 } });
      await context.addInitScript((value) => {
        try {
          localStorage.setItem("herdrbridge-theme", value);
          localStorage.removeItem("herdrbridge-ai-accounts-tab");
        } catch {}
      }, theme);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
      if (mobile) {
        await page.waitForTimeout(400);
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400); // the phone sidebar slides in
      }
      await page.locator('summary[aria-label="More actions for workstation"]').click();
      await page.locator(".sidebar-action-item:visible", { hasText: "AI accounts" }).click();
      const dialog = page.locator("#ai-accounts-dialog");
      const panel = () => dialog.locator('[role="tabpanel"]:visible');
      const usage = () => panel().locator(".ai-usage");

      // Claude's tab opens first; its usage sits right under the account in use.
      await usage().locator(".ai-usage-meter").first().waitFor({ state: "visible" });
      const order = await panel().locator(".ai-account-rows > li").evaluateAll((items) => items.map((item) => item.className));
      assert.deepEqual(order.map((name) => name.split(" ")[0]), ["ai-account-row", "ai-account-row", "ai-usage", "ai-account-add-row"],
        `${where}: usage is not right under the account in use`);
      assert.match(order[1], /is-active/u);
      const meters = await usage().locator(".ai-usage-meter").evaluateAll((items) => items.map((item) => ({
        name: item.querySelector(".ai-usage-name").textContent,
        used: item.querySelector(".ai-usage-percent").textContent,
        level: item.dataset.level,
        value: item.querySelector('[role="meter"]').getAttribute("aria-valuenow"),
        below: item.querySelector("small")?.textContent,
      })));
      assert.deepEqual(meters, [
        { name: "Session", used: "14% used", level: "normal", value: "14", below: "Resets in 1h 12m" },
        { name: "Week · all models", used: "98% used", level: "full", value: "98", below: "Resets Nov 12, 8am (Asia/Seoul)" },
        { name: "Week · Fable", used: "84% used", level: "high", value: "84", below: "Resets Nov 12, 8am (Asia/Seoul)" },
      ], `${where}: Claude's meters`);
      assert.equal(await usage().locator(".ai-usage-checked").textContent(), "Checked 2m ago");
      assert.equal(await usage().locator(".ai-usage-source").textContent(), "Read by running claude /usage");
      const fill = await usage().locator(".ai-usage-meter").nth(1).locator(".ai-usage-fill").evaluate((node) => getComputedStyle(node).backgroundColor);
      const danger = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      assert.equal(fill, danger, `${where}: a nearly spent limit is not red`);
      const fit = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(fit <= 1, `${where}: usage widens the dialog (${fit}px)`);
      if (mobile) {
        const tall = await usage().locator(".ai-usage-refresh").evaluate((node) => node.getBoundingClientRect().height);
        assert.ok(tall >= 44, `${where}: Refresh is under 44px tall (${tall})`);
      }
      if (shots) await page.screenshot({ path: join(shots, `claude-${where}.png`) });
      assert.deepEqual(asked, [["claude", false]], `${where}: only the open tab's CLI is asked`);

      // Refresh asks the CLI again.
      await usage().locator(".ai-usage-refresh").click();
      await page.waitForFunction(() => document.querySelector(".ai-usage:not([aria-busy])"));
      assert.deepEqual(asked.at(-1), ["claude", true]);

      // A CLI with nobody signed in has no usage and asks nothing.
      await dialog.locator("#ai-accounts-tab-agy").click();
      assert.equal(await usage().count(), 0, `${where}: Antigravity has nobody signed in, yet shows usage`);
      assert.equal(asked.some(([cli]) => cli === "agy"), false);

      // Codex: notes under its meter.
      await dialog.locator("#ai-accounts-tab-codex").click();
      await usage().locator(".ai-usage-meter").waitFor({ state: "visible" });
      assert.equal(await usage().locator(".ai-usage-note").textContent(), "48,192 credits left");
      assert.match(await usage().locator(".ai-usage-meter small").textContent(), /^Resets in 4d 3h$/u);

      // Kiro fails first: why, and Retry.
      await dialog.locator("#ai-accounts-tab-kiro").click();
      await usage().locator('.dialog-feedback[data-error="true"]').waitFor({ state: "visible" });
      assert.equal(await usage().locator(".dialog-feedback").textContent(), "Kiro did not show its usage in time");
      if (shots) await page.screenshot({ path: join(shots, `kiro-error-${where}.png`) });
      kiroFails = false;
      await usage().locator(".ai-usage-refresh", { hasText: "Retry" }).click();
      await usage().locator(".ai-usage-meter").waitFor({ state: "visible" });
      assert.equal(await usage().locator(".ai-usage-meter small").textContent(), "Resets 2026-12-01 · 5,483 of 10,000 · KIRO POWER");
      if (shots) await page.screenshot({ path: join(shots, `kiro-${where}.png`) });

      // Back on Claude: what was read is shown again without asking.
      const before = asked.length;
      await dialog.locator("#ai-accounts-tab-claude").click();
      await usage().locator(".ai-usage-meter").first().waitFor({ state: "visible" });
      assert.equal(asked.length, before, `${where}: going back to a tab asked its CLI again`);

      assert.deepEqual(errors, [], `${where}: page errors`);
      await context.close();
    }
  }
  console.log("AI usage under the account in use, per tab, refresh and retry: ok");
} finally {
  await browser.close();
  server.close();
}
