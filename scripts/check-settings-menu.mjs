// Browser check of the ⚙ settings menu at the foot of the sidebar. The footer
// holds the uploads button and the settings button only; the menu opens upward
// inside the viewport and lists Notifications (only where push works; its
// state shown as its colour), the theme switch, Edit keys (whose dialog holds
// the Enter choice on touch devices), Fit panes
// to this window (wide screens only, on until switched off, kept in this
// browser) and -- with sign-in on -- Passkeys and Signed-in devices. Escape closes the menu alone. Each item does what its old button
// did. Runs on a desktop and a phone against an in-process fake herdr.
//
// SETTINGS_SHOTS=<folder> keeps pictures of the footer and the open menu in
// both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const herdr = {
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha" }],
      agents: [],
    };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
};
const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const PUSH_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

try {
  for (const mobile of [false, true]) {
    for (const scenario of ["full", "plain"]) {
      const full = scenario === "full";
      const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
        viewport: { width: mobile ? 390 : 1280, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (full) {
        // Sign-in on and push configured: every item shows.
        await page.route("**/api/auth/status", (route) => route.fulfill({ json: { required: true, authenticated: true, passkeyAvailable: false } }));
        await page.route("**/api/bootstrap", async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), pushPublicKey: PUSH_KEY } });
        });
      }
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
      if (mobile) await page.locator("#mobile-sidebar-open").click();
      const button = page.locator(".settings-button");
      const menu = page.locator(".settings-menu .sidebar-action-popover");
      await button.waitFor({ state: "visible" });
      await page.waitForTimeout(400); // the phone sidebar slides in

      // The footer is the uploads button and the settings button, nothing else.
      assert.deepEqual(
        await page.locator(".navigator-footer").evaluate((node) => [...node.children].map((child) => child.id || child.className.split(" ")[0])),
        ["file-uploads", "sidebar-action-menu"],
      );
      for (const gone of ["#notification-toggle", "#theme-toggle", "#key-bar-settings"]) {
        assert.equal(await page.locator(gone).count(), 0, `${gone} is gone`);
      }
      assert.equal(await button.getAttribute("aria-label"), "Settings");

      const onScreen = () => button.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
      });
      const shoot = async (name) => {
        if (!process.env.SETTINGS_SHOTS) return;
        const startTheme = await page.evaluate(() => window.herdrTheme.current());
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => window.herdrTheme.set(value), theme);
          await page.waitForTimeout(300); // let the theme's colour transitions finish
          await page.screenshot({ path: join(process.env.SETTINGS_SHOTS, `${name}-${scenario}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
        }
        await page.evaluate((value) => window.herdrTheme.set(value), startTheme);
        await page.waitForTimeout(300);
      };
      await shoot("footer");

      await button.click();
      await menu.waitFor({ state: "visible" });
      const labels = await menu.locator("button:visible").allTextContents();
      // Headless Chromium has no notification permission, so the state reads blocked:
      // the label is the word alone, the state its colour and accessible name.
      if (full) {
        assert.equal(labels[0], "Notifications");
        const notify = menu.locator('[data-action="notifications"]');
        assert.match(await notify.getAttribute("data-notify"), /^(off|blocked)$/);
        assert.match(await notify.getAttribute("aria-label"), /notifications/i);
        const [colour, expected] = await notify.evaluate((node) => {
          const probe = document.createElement("span");
          probe.style.color = node.dataset.notify === "blocked" ? "var(--danger)" : "var(--muted)";
          node.append(probe);
          const value = [getComputedStyle(node).color, getComputedStyle(probe).color];
          probe.remove();
          return value;
        });
        assert.equal(colour, expected, "the item takes its state's colour");
      }
      const keys = ["Edit keys"];
      // Fitting a grid's panes to the window is for a wide screen's grid.
      const windowItems = mobile ? [] : ["Fit panes to this window: On"];
      assert.deepEqual(
        labels.slice(full ? 1 : 0),
        full ? [labels[1], ...keys, ...windowItems, "Passkeys", "Signed-in devices"] : [labels[0], ...keys, ...windowItems],
      );
      assert.equal(await menu.locator('[data-action="new-window"], [data-action="enter-key"]').count(), 0, "New window and Enter are not menu items");
      assert.match(labels[full ? 1 : 0], /^Switch to (light|dark) mode$/);
      // It opens upward and stays inside the viewport.
      const box = await menu.boundingBox();
      const anchor = await button.boundingBox();
      assert.ok(box.y + box.height <= anchor.y, `the menu opens above the button ${JSON.stringify({ box, anchor })}`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= (mobile ? 390 : 1280), "the menu is not cut off");
      await shoot("menu");

      // Theme: the label names the next switch.
      const before = await page.evaluate(() => window.herdrTheme.current());
      await menu.getByRole("menuitem", { name: /Switch to/ }).click();
      assert.notEqual(await page.evaluate(() => window.herdrTheme.current()), before);
      await menu.waitFor({ state: "hidden" });
      await button.click();
      await menu.waitFor({ state: "visible" });
      assert.match(await menu.getByRole("menuitem", { name: /Switch to/ }).textContent(), before === "dark" ? /dark mode/ : /light mode/);

      if (!mobile) {
        // Fit panes to this window: off and on again, kept in this browser.
        for (const [label, stored, checked] of [["Fit panes to this window: Off", "off", "false"], ["Fit panes to this window: On", "on", "true"]]) {
          await menu.locator('[data-action="grid-fit"]').click();
          await menu.waitFor({ state: "hidden" });
          assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-grid-fit")), stored);
          await button.click();
          await menu.waitFor({ state: "visible" });
          assert.equal(await menu.locator('[data-action="grid-fit"] span').textContent(), label);
          assert.equal(await menu.locator('[data-action="grid-fit"]').getAttribute("aria-checked"), checked);
        }
      }

      // Escape closes the menu alone and gives the focus back to the button.
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await button.evaluate((node) => node === document.activeElement || node.contains(document.activeElement)), true);
      assert.equal(await onScreen(), true, "the sidebar stays open under the closed menu");

      // On a phone the editor takes the screen and the sidebar steps aside; bring it back.
      const reachButton = async () => {
        await page.waitForTimeout(400);
        if (!(await onScreen())) await page.locator("#mobile-sidebar-open").click();
        await page.waitForFunction(() => {
          const rect = document.querySelector(".settings-button").getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
        });
        await page.waitForTimeout(400);
      };

      // Edit keys opens its dialog. On a touch device it holds the Enter choice:
      // three buttons, one pressed, kept in this browser; elsewhere no choice.
      await button.click();
      await page.locator('.settings-menu [data-action="keys"]').click();
      await page.locator("#key-bar-dialog").waitFor({ state: "visible" });
      const enterChoice = page.locator("#key-bar-enter");
      assert.equal(await enterChoice.isVisible(), mobile, "the Enter choice shows on a touch device only");
      if (mobile) {
        const pressed = () => enterChoice.locator('[aria-pressed="true"]').allTextContents();
        assert.deepEqual(await enterChoice.locator("button").allTextContents(), ["Auto", "New line", "Send"]);
        assert.deepEqual(await pressed(), ["Auto"]);
        for (const [label, stored] of [["New line", "newline"], ["Send", "send"], ["Auto", "auto"]]) {
          await enterChoice.getByRole("button", { name: label, exact: true }).click();
          assert.deepEqual(await pressed(), [label]);
          assert.equal(await page.evaluate(() => localStorage.getItem("herdrBridge.enterKey.v1")), stored);
          assert.ok((await page.locator("#key-bar-enter-hint").textContent()).length > 0, "the choice says what it does");
        }
      }
      await page.keyboard.press("Escape");
      await page.locator("#key-bar-dialog").waitFor({ state: "hidden" });

      if (full) {
        for (const [action, dialog] of [["passkeys", "#passkeys-dialog"], ["sessions", "#sessions-dialog"]]) {
          await reachButton();
          await button.click();
          await page.locator(`.settings-menu [data-action="${action}"]`).click();
          await page.locator(dialog).waitFor({ state: "visible" });
          await page.waitForTimeout(500); // Escape is held back while the list loads
          await page.keyboard.press("Escape");
          await page.locator(dialog).waitFor({ state: "hidden" });
        }
      }
      if (full && !mobile) {
        // Signing this device out ends here even when the server cannot be told:
        // from the button the list offers when it fails to load, and from the
        // row marked as this device.
        await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
        const signedOutHere = async () => {
          await page.locator("#login-screen").waitFor({ state: "visible" });
          await page.locator("#sessions-dialog").waitFor({ state: "hidden" });
        };
        const reopen = async () => {
          await page.evaluate(() => {
            document.querySelector("#login-screen").hidden = true;
            document.body.classList.remove("auth-required");
            document.querySelector(".app-shell, #app-shell, main")?.removeAttribute("inert");
            document.querySelectorAll("[inert]").forEach((node) => { node.inert = false; });
          });
          await button.click();
          await page.locator('.settings-menu [data-action="sessions"]').click();
          await page.locator("#sessions-dialog").waitFor({ state: "visible" });
        };
        await page.route("**/api/auth/sessions", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
        await reopen();
        await page.locator("#sessions-end-this").waitFor({ state: "visible" });
        await page.locator("#sessions-end-this").click();
        await signedOutHere();

        await page.unroute("**/api/auth/sessions");
        await page.route("**/api/auth/sessions", (route) => route.fulfill({ json: { sessions: [
          { id: "s1", agent: "Chrome on Linux", current: true, createdAt: 1_700_000_000, lastUsedAt: 1_700_000_000 },
        ] } }));
        await reopen();
        await page.locator("#sessions-list .passkey-row").first().waitFor({ state: "visible" });
        assert.equal(await page.locator("#sessions-end-this").isHidden(), true, "the row covers this device");
        await page.locator("#sessions-list .passkey-row button").first().click();
        await signedOutHere();
      }
      assert.deepEqual(errors, [], "no script errors");
      await context.close();
      console.log(`ok: ${mobile ? "phone" : "desktop"} ${scenario}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(0);
