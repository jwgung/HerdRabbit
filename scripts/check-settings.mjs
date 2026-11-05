// Browser check of the settings screen that ⚙ at the foot of the sidebar
// opens. The footer holds the uploads button and the settings button only.
// On a desktop the screen is a dialog with its pages listed on the left; on a
// phone a full-screen list where a page opens with a Back arrow. Its pages:
// Appearance (theme, a grid's text size), Chat (Open panes in, Chat width),
// Terminal & keys (Edit keys, whose dialog holds the Enter choice on touch
// devices; Fit panes to this window on wide screens), Notifications (only a
// switch where push works), Security (with sign-in on: Passkeys and
// Signed-in devices), PCs (where Connect PC is: the list and Connect PC),
// Plugins (with sign-in on, where this HerdRabbit manages them; HerdRabbit's
// own update is its row there), Herdr (the same: Herdr's update, channel,
// integrations and config.toml) and About (versions; this PC's updates only
// where Plugins and Herdr are not shown and it can update). There is no
// Updates page. A page's heading stays put while the page scrolls. Each control does what its old menu item did. Runs on a
// desktop and a phone against an in-process fake herdr.
//
// SETTINGS_SHOTS=<folder> keeps pictures of each page in both themes.
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
const ALL_PAGES = ["Appearance", "Chat", "Terminal & keys", "Notifications", "Security", "PCs", "Plugins", "Herdr", "About"];

try {
  for (const mobile of [false, true]) {
    for (const scenario of ["full", "plain"]) {
      const full = scenario === "full";
      const width = mobile ? 390 : 1280;
      const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
        viewport: { width, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (full) {
        // Sign-in on, push configured and Connect PC there: every page shows.
        await page.route("**/api/auth/status", (route) => route.fulfill({ json: { required: true, authenticated: true, passkeyAvailable: false } }));
        await page.route("**/api/bootstrap", async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), pushPublicKey: PUSH_KEY, servers: true, plugins: true, herdrSettings: true } });
        });
        await page.route("**/api/servers/discover", (route) => route.fulfill({ json: { available: false, candidates: [] } }));
        // This PC's versions, as a hub started by the service reports them.
        // A request the page dropped (a reload) is let go.
        await page.route("**/api/snapshot", (route) => withVersions(route).catch(() => {}));
        const withVersions = async (route) => {
          const response = await route.fetch();
          const payload = await response.json();
          const snapshot = payload.snapshot ?? {};
          snapshot.servers ??= [];
          if (!snapshot.servers.some((record) => record.id === "local")) {
            snapshot.servers.unshift({ id: "local", name: "This PC", transport: "local", available: true, status: "Connected" });
          }
          for (const record of snapshot.servers) {
            if (record.id === "local") Object.assign(record, { version: "9.8.7", herdr_version: "0.9.5", herdr_supported: true });
          }
          await route.fulfill({ response, json: payload });
        };
      }
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
      if (mobile) await page.locator("#mobile-sidebar-open").click();
      const button = page.locator("#settings-open");
      const dialog = page.locator("#settings-dialog");
      const nav = dialog.locator(".settings-nav");
      const body = dialog.locator(".settings-body");
      const link = (name) => dialog.locator(".settings-page-link", { hasText: name });
      const pageOf = (id) => dialog.locator(`.settings-page[data-page="${id}"]`);
      await button.waitFor({ state: "visible" });
      await page.waitForTimeout(400); // the phone sidebar slides in

      // The footer is the uploads button and the settings button, nothing else.
      assert.deepEqual(
        await page.locator(".navigator-footer").evaluate((node) => [...node.children].map((child) => child.id)),
        ["file-uploads", "settings-open"],
      );
      assert.equal(await page.locator(".settings-menu, #notification-toggle, #theme-toggle, #key-bar-settings").count(), 0, "no menu is left");
      assert.equal(await button.getAttribute("aria-label"), "Settings");
      assert.equal(await button.getAttribute("aria-haspopup"), "dialog");

      // ⚙ opens the screen directly.
      await button.click();
      await dialog.waitFor({ state: "visible" });
      const listed = await dialog.locator(".settings-page-link").allTextContents();
      assert.deepEqual(listed, full ? ALL_PAGES : ALL_PAGES.filter((name) => name !== "Security" && name !== "PCs" && name !== "Plugins" && name !== "Herdr"));
      const box = await dialog.boundingBox();
      if (mobile) {
        // A phone: the list fills the screen; no page beside it.
        assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844], "the list fills the screen");
        assert.equal(await nav.isVisible(), true);
        assert.equal(await body.isVisible(), false, "no page beside the list");
        for (const row of await dialog.locator(".settings-page-link").all()) {
          assert.ok((await row.boundingBox()).height >= 44, "a page row is a 44px target");
        }
      } else {
        // A desktop: a dialog with the list on the left of the page shown.
        assert.ok(box.width <= 760 && box.x > 0 && box.y > 0, `a dialog inside the window ${JSON.stringify(box)}`);
        const [navBox, bodyBox] = [await nav.boundingBox(), await body.boundingBox()];
        assert.ok(navBox.x + navBox.width <= bodyBox.x + 1, "the list is on the left");
        assert.equal(await link("Appearance").getAttribute("aria-current"), "page");
        assert.equal(await dialog.locator("#settings-back").isVisible(), false, "no Back beside the list");
      }

      // Opens a page: a phone moves to it and Back returns to the list.
      const open = async (name, id) => {
        if (mobile && !(await nav.isVisible())) await dialog.locator("#settings-back").click();
        await link(name).click();
        await pageOf(id).waitFor({ state: "visible" });
        assert.equal(await dialog.locator("#settings-page-title").textContent(), name);
        assert.equal(await link(name).getAttribute("aria-current"), "page");
        if (mobile) assert.equal(await nav.isVisible(), false, "the page takes the screen");
      };
      const shoot = async (name) => {
        if (!process.env.SETTINGS_SHOTS) return;
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          await page.waitForTimeout(300); // let the theme's colour transitions finish
          await page.screenshot({ path: join(process.env.SETTINGS_SHOTS, `${name}-${scenario}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
        }
      };
      const pressed = (locator) => locator.locator('[aria-pressed="true"]').allTextContents();
      await shoot("list");

      // Appearance: the theme as two choices, and a grid's text size.
      await open("Appearance", "appearance");
      const theme = () => page.evaluate(() => window.herdrTheme.current());
      const startTheme = await theme();
      const themeChoices = pageOf("appearance").locator(".settings-choices");
      assert.deepEqual(await pressed(themeChoices), [startTheme === "dark" ? "Dark" : "Light"]);
      const otherTheme = startTheme === "dark" ? "Light" : "Dark";
      await themeChoices.getByRole("button", { name: otherTheme, exact: true }).click();
      assert.equal(await theme(), otherTheme.toLowerCase());
      assert.deepEqual(await pressed(themeChoices), [otherTheme]);
      assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-theme")), otherTheme.toLowerCase());
      await themeChoices.getByRole("button", { name: startTheme === "dark" ? "Dark" : "Light", exact: true }).click();
      assert.equal(await page.locator("#settings-text-size-reset").isDisabled(), true, "nothing to reset yet");
      if (mobile) {
        for (const choice of await themeChoices.locator("button").all()) {
          assert.ok((await choice.boundingBox()).height >= 44, "a choice is a 44px target");
        }
      }
      await shoot("appearance");

      // Chat: Open panes in and Chat width, each kept in this browser.
      await open("Chat", "chat");
      const openIn = pageOf("chat").locator('[aria-labelledby="settings-open-in-label"]');
      assert.deepEqual(await openIn.locator("button").allTextContents(), ["Auto", "Chat", "Terminal"]);
      assert.deepEqual(await pressed(openIn), ["Auto"]);
      const openInHint = () => page.locator("#settings-open-in-hint").textContent();
      assert.match(await openInHint(), /^Chat on a touch screen, Terminal on a desktop/);
      for (const [label, stored] of [["Chat", "chat"], ["Terminal", "terminal"], ["Auto", "auto"]]) {
        await openIn.getByRole("button", { name: label, exact: true }).click();
        assert.deepEqual(await pressed(openIn), [label]);
        assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-open-panes-in")), stored);
        assert.match(await openInHint(), /A pane you switched keeps its choice/);
      }
      const widths = pageOf("chat").locator('[aria-labelledby="settings-chat-width-label"]');
      assert.deepEqual(await widths.locator("button").allTextContents(), ["Narrow", "Default", "Wide", "Full"]);
      assert.deepEqual(await pressed(widths), ["Default"]);
      // The column's width, read from a transcript drawn with the page's CSS.
      const column = () => page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "chat-transcript";
        document.body.append(probe);
        const value = getComputedStyle(probe).maxWidth;
        probe.remove();
        return value;
      });
      assert.equal(await column(), "860px");
      for (const [label, stored, max] of [["Narrow", "narrow", "680px"], ["Wide", "wide", "1120px"], ["Full", "full", "none"], ["Default", "default", "860px"]]) {
        await widths.getByRole("button", { name: label, exact: true }).click();
        assert.deepEqual(await pressed(widths), [label]);
        assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-chat-width")), stored);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.chatWidth), stored);
        assert.equal(await column(), max, `${label} sets the column to ${max}`);
      }
      await widths.getByRole("button", { name: "Wide", exact: true }).click();
      await shoot("chat");

      // Terminal & keys: Edit keys opens its dialog over the screen. On a
      // touch device it holds the Enter choice; elsewhere no choice.
      await open("Terminal & keys", "terminal");
      await page.locator("#settings-edit-keys").click();
      await page.locator("#key-bar-dialog").waitFor({ state: "visible" });
      const enterChoice = page.locator("#key-bar-enter");
      assert.equal(await enterChoice.isVisible(), mobile, "the Enter choice shows on a touch device only");
      if (mobile) {
        assert.deepEqual(await enterChoice.locator("button").allTextContents(), ["Auto", "New line", "Send"]);
        assert.deepEqual(await pressed(enterChoice), ["Auto"]);
        for (const [label, stored] of [["New line", "newline"], ["Send", "send"], ["Auto", "auto"]]) {
          await enterChoice.getByRole("button", { name: label, exact: true }).click();
          assert.deepEqual(await pressed(enterChoice), [label]);
          assert.equal(await page.evaluate(() => localStorage.getItem("herdrBridge.enterKey.v1")), stored);
          assert.ok((await page.locator("#key-bar-enter-hint").textContent()).length > 0, "the choice says what it does");
        }
      }
      await page.keyboard.press("Escape");
      await page.locator("#key-bar-dialog").waitFor({ state: "hidden" });
      assert.equal(await dialog.isVisible(), true, "Escape closes the editor alone");
      const fitRow = page.locator("#settings-grid-fit-row");
      // Fitting a grid's panes to the window is for a wide screen's grid.
      assert.equal(await fitRow.isVisible(), !mobile);
      if (!mobile) {
        const fit = fitRow.locator(".settings-choices");
        assert.deepEqual(await pressed(fit), ["On"], "on until switched off");
        for (const [label, stored] of [["Off", "off"], ["On", "on"]]) {
          await fit.getByRole("button", { name: label, exact: true }).click();
          assert.deepEqual(await pressed(fit), [label]);
          assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-grid-fit")), stored);
          assert.match(await page.locator("#settings-grid-fit-hint").textContent(), new RegExp(`^${label}:`));
        }
      }
      await shoot("terminal");

      // Notifications: a switch where push works, and its state in words.
      // Headless Chromium has no notification permission: off or blocked.
      await open("Notifications", "notifications");
      const notify = page.locator("#settings-notify-choices");
      const notifyState = await page.locator("#settings-notify-state").textContent();
      if (full) {
        assert.equal(await notify.isVisible(), true);
        assert.deepEqual(await pressed(notify), ["Off"]);
        assert.match(notifyState, /^(Off\.|Blocked: )/);
      } else {
        assert.equal(await notify.isVisible(), false, "no switch without push");
        assert.equal(notifyState, "Notifications aren't supported in this browser.");
      }
      await shoot("notifications");

      if (full) {
        // Security: each opens its dialog over the screen.
        await open("Security", "security");
        for (const [control, target] of [["#settings-passkeys", "#passkeys-dialog"], ["#settings-sessions", "#sessions-dialog"]]) {
          await page.locator(control).click();
          await page.locator(target).waitFor({ state: "visible" });
          await page.waitForTimeout(500); // Escape is held back while the list loads
          await page.keyboard.press("Escape");
          await page.locator(target).waitFor({ state: "hidden" });
          assert.equal(await dialog.isVisible(), true, "the screen stays under it");
        }
        await shoot("security");

        // PCs: the list and Connect PC, which opens its dialog.
        await open("PCs", "pcs");
        assert.equal(await page.locator("#settings-pc-list").textContent(), "No PCs connected yet.");
        await page.locator("#settings-connect-pc").click();
        await page.locator("#servers-dialog").waitFor({ state: "visible" });
        await page.locator("#server-close").click();
        await page.locator("#servers-dialog").waitFor({ state: "hidden" });
        assert.equal(await dialog.isVisible(), true);
        await shoot("pcs");

        // Plugins: its list and Install plugin… (scripts/check-plugins.mjs drives them).
        await open("Plugins", "plugins");
        assert.equal(await page.locator("#plugins-install").isVisible(), true);
        await shoot("plugins");

        // Herdr: the channel, integrations and config.toml (scripts/check-herdr-settings.mjs drives them).
        await open("Herdr", "herdr");
        assert.equal(await page.locator("#herdr-config-save").isVisible(), true);
        await shoot("herdr");
      }

      // No Updates page: its updates are in Plugins and Herdr
      // (scripts/check-in-app-update.mjs and check-plugins.mjs drive them).
      assert.equal(await page.locator('.settings-page[data-page="updates"]').count(), 0, "the Updates page is still there");

      // About: this machine's versions, and nothing to press where this PC
      // cannot update itself (as here).
      await open("About", "about");
      assert.equal(await pageOf("about").locator("button:visible").count(), 0, "About has controls");
      assert.equal(await page.locator("#settings-about-updates").isHidden(), true);
      assert.equal(await page.locator("#settings-version-app").textContent(), full ? "9.8.7" : "Unknown");
      assert.equal(await page.locator("#settings-version-herdr").textContent(), full ? "0.9.5" : "Unknown");
      await shoot("about");

      // A header button is an icon alone, its drawing in the middle of the box.
      const centred = (button) => button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const icon = element.querySelector("svg").getBoundingClientRect();
        return { text: element.textContent.trim(), x: Math.abs(box.left + box.width / 2 - (icon.left + icon.width / 2)),
          y: Math.abs(box.top + box.height / 2 - (icon.top + icon.height / 2)) };
      });
      // A page's heading: × on a desktop, the Back arrow on a phone (whose × is on the list).
      const look = await centred(dialog.locator(mobile ? "#settings-back" : ".settings-page-heading .settings-close"));
      assert.equal(look.text, "", `a settings header button has words: ${look.text}`);
      assert.ok(look.x <= 0.5 && look.y <= 0.5, `a settings header icon is off centre: ${JSON.stringify(look)}`);

      if (mobile) {
        // Back returns to the list, on the page it came from.
        await dialog.locator("#settings-back").click();
        await nav.waitFor({ state: "visible" });
        const close = await centred(dialog.locator(".settings-nav .settings-close"));
        assert.ok(close.x <= 0.5 && close.y <= 0.5, `the list's close icon is off centre: ${JSON.stringify(close)}`);
        assert.equal(await body.isVisible(), false);
        assert.equal(await link("About").evaluate((node) => node === document.activeElement), true, "focus is back on the page's row");
      }

      // Escape closes the screen and gives the focus back to ⚙.
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await button.evaluate((node) => node === document.activeElement), true);
      // Escape in a window over the sidebar left the sidebar as it was.
      assert.equal(await page.evaluate(() => document.querySelector("#navigator").inert), false, "the sidebar stays open");
      // What was chosen stays after a reload.
      await page.reload();
      await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.chatWidth), "wide");

      if (full && !mobile) {
        // Signing this device out ends here even when the server cannot be told:
        // from the button the list offers when it fails to load, and from the
        // row marked as this device. The settings screen goes with the app.
        await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
        const signedOutHere = async () => {
          await page.locator("#login-screen").waitFor({ state: "visible" });
          await page.locator("#sessions-dialog").waitFor({ state: "hidden" });
          await dialog.waitFor({ state: "hidden" });
        };
        const reopen = async () => {
          await page.evaluate(() => {
            document.querySelector("#login-screen").hidden = true;
            document.body.classList.remove("auth-required");
            document.querySelectorAll("[inert]").forEach((node) => { node.inert = false; });
          });
          await button.click();
          await link("Security").click();
          await page.locator("#settings-sessions").click();
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
