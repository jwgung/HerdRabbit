// Browser check of Git worktrees from a workspace's ⋯ menu. A repository's own
// workspace offers New worktree… and Open worktree…; a worktree workspace
// offers Remove worktree… instead, above Close workspace. A workspace Herdr
// knows a checkout of shows its branch beside its name. New worktree… makes
// the branch from the base given, opens the new workspace and selects its
// pane; on a folder outside Git it says so and does not create. Open
// worktree… lists the repository's checkouts (branch over folder, Open and
// Main marked) and opens the one chosen. Remove worktree… asks first, and
// asks again before forcing past uncommitted changes.
// Runs on a desktop and a phone against an in-process fake herdr.
//
// WORKTREE_SHOTS=<folder> keeps pictures of the menu and the dialogs.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const REPO = { repo_key: "/work/shop/.git", repo_name: "shop", repo_root: "/work/shop" };
let state;
const fresh = () => ({
  calls: [],
  workspaces: [
    { workspace_id: "w1", label: "shop", worktree: { ...REPO, checkout_path: "/work/shop", is_linked_worktree: false, branch: "main" } },
    { workspace_id: "w2", label: "cart", worktree: { ...REPO, checkout_path: "/work/wt/shop/feat-cart", is_linked_worktree: true, branch: "feat/cart-and-a-rather-long-branch-name" } },
    { workspace_id: "w3", label: "notes" },
  ],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "shell" }, { tab_id: "w2:t1", workspace_id: "w2", label: "shell" }, { tab_id: "w3:t1", workspace_id: "w3", label: "shell" }],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/shop" },
    { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", cwd: "/work/wt/shop/feat-cart" },
    { pane_id: "w3:p1", tab_id: "w3:t1", workspace_id: "w3", cwd: "/work/notes" },
  ],
  // The first remove is refused for changes, as Git refuses a dirty checkout.
  dirty: true,
});

function addWorkspace(label, path, branch) {
  const n = state.workspaces.length + 1;
  const id = `w${n}`;
  state.workspaces.push({ workspace_id: id, label, worktree: { ...REPO, checkout_path: path, is_linked_worktree: true, branch } });
  state.tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label: "shell" });
  state.panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, cwd: path });
  return { workspace_id: id, tab_id: `${id}:t1`, pane_id: `${id}:p1`, path, branch, already_open: false };
}

const herdr = {
  async snapshot() {
    return {
      servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
      workspaces: structuredClone(state.workspaces), tabs: [...state.tabs], panes: [...state.panes], agents: [],
    };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
  async listWorktrees(id) {
    state.calls.push(["list", id]);
    if (id === "w3") throw new HerdrCommandError("Herdr worktree actions require a workspace inside a Git work tree", { code: "not_git_worktree" });
    return {
      source: { repo_name: "shop", repo_root: "/work/shop" },
      worktrees: [
        { path: "/work/shop", branch: "main", is_linked_worktree: false, open_workspace_id: "w1" },
        { path: "/work/wt/shop/feat-cart", branch: "feat/cart-and-a-rather-long-branch-name", is_linked_worktree: true, open_workspace_id: "w2" },
        { path: "/work/wt/shop/fix-login", branch: "fix/login", is_linked_worktree: true, open_workspace_id: null },
        { path: "/work/wt/shop/gone", branch: "old", is_linked_worktree: true, is_prunable: true, open_workspace_id: null },
      ],
    };
  },
  async createWorktree(id, options) {
    state.calls.push(["create", id, options]);
    return addWorkspace(options.label ?? "shop", `/work/wt/shop/${options.branch.replace("/", "-")}`, options.branch);
  },
  async openWorktree(id, options) {
    state.calls.push(["open", id, options]);
    return addWorkspace("shop", options.path, "fix/login");
  },
  async removeWorktree(id, options) {
    state.calls.push(["remove", id, options]);
    if (state.dirty && !options.force) throw new HerdrCommandError("worktree has changes", { code: "dirty_worktree_requires_force" });
    state.workspaces = state.workspaces.filter((item) => item.workspace_id !== id);
    state.tabs = state.tabs.filter((item) => item.workspace_id !== id);
    state.panes = state.panes.filter((item) => item.workspace_id !== id);
    return { workspace_id: id, path: "/work/wt/shop/feat-cart", forced: options.force === true };
  },
};

const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.WORKTREE_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });

try {
  for (const mobile of [false, true]) {
    state = fresh();
    const where = mobile ? "phone" : "desktop";
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const confirms = [];
    let answer = () => true;
    page.on("dialog", (dialog) => {
      confirms.push(dialog.message());
      void (answer(dialog.message()) ? dialog.accept() : dialog.dismiss());
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    const openSidebar = async () => {
      if (!mobile) return;
      await page.waitForTimeout(400);
      if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400);
      }
    };
    await openSidebar();
    const heading = (label) => page.locator(".workspace-heading", { has: page.locator("h3", { hasText: new RegExp(`^${label}$`, "u") }) });
    const menu = async (label) => {
      await openSidebar();
      await heading(label).locator(".sidebar-action-menu > summary").click();
      await heading(label).locator(".sidebar-action-item").first().waitFor({ state: "visible" });
      return (await heading(label).locator(".sidebar-action-item").allTextContents()).map((text) => text.trim());
    };
    const choose = async (label, item) => {
      await menu(label);
      await heading(label).locator(".sidebar-action-item", { hasText: item }).click();
    };

    // The branch beside the workspace's name: quieter, cut short before the name is.
    await heading("cart").locator(".workspace-branch").waitFor({ state: "visible" });
    assert.equal(await heading("shop").locator(".workspace-branch").textContent(), "main");
    assert.equal(await heading("cart").locator(".workspace-branch").getAttribute("aria-label"), "Branch feat/cart-and-a-rather-long-branch-name");
    assert.equal(await heading("notes").locator(".workspace-branch").count(), 0, "a workspace outside Git shows a branch");
    const cartLook = await heading("cart").evaluate((row) => {
      const name = row.querySelector("h3").getBoundingClientRect();
      const tag = row.querySelector(".workspace-branch").getBoundingClientRect();
      const more = row.querySelector(".sidebar-action-menu").getBoundingClientRect();
      return { nameWidth: name.width, tagRight: tag.right, moreLeft: more.left, tagWidth: tag.width, rowWidth: row.getBoundingClientRect().width };
    });
    assert.ok(cartLook.tagRight <= cartLook.moreLeft + 1, `the branch runs into the ⋯ button: ${JSON.stringify(cartLook)}`);
    assert.ok(cartLook.nameWidth >= 24 && cartLook.tagWidth <= cartLook.rowWidth * 0.56, `the branch crowds out the name: ${JSON.stringify(cartLook)}`);

    // The repository's workspace makes and opens; a worktree removes itself.
    const shopItems = await menu("shop");
    assert.deepEqual(shopItems, ["Rename", "New tab…", "New worktree…", "Open worktree…", "Close workspace"], `${where}: shop's menu`);
    if (shots) await page.screenshot({ path: join(shots, `menu-${where}.png`) });
    await page.keyboard.press("Escape");
    const cartItems = await menu("cart");
    assert.deepEqual(cartItems, ["Rename", "New tab…", "Remove worktree…", "Close workspace"], `${where}: cart's menu`);
    assert.equal(await heading("cart").locator(".sidebar-action-item", { hasText: "Remove worktree…" }).evaluate((item) => item.classList.contains("is-danger")), true);
    if (mobile) {
      for (const height of await heading("cart").locator(".sidebar-action-item").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) {
        assert.ok(height >= 44, `a menu item is under 44px on a phone (${height})`);
      }
    }
    await page.keyboard.press("Escape");

    // New worktree on a folder outside Git: said, and nothing to create.
    await choose("notes", "New worktree…");
    const create = page.locator("#worktree-dialog");
    await create.waitFor({ state: "visible" });
    await page.locator("#worktree-dialog-feedback", { hasText: "not in a Git repository" }).waitFor();
    assert.equal(await create.locator('button[type="submit"]').isDisabled(), true, "Create is offered outside Git");
    await page.locator("#worktree-dialog-cancel").click();
    await create.waitFor({ state: "hidden" });

    // New worktree: a branch from a base, opened and selected.
    await choose("shop", "New worktree…");
    await create.waitFor({ state: "visible" });
    // Create waits on Herdr naming the repository.
    await page.locator("#worktree-dialog-context", { hasText: "A branch of shop, checked out" }).waitFor();
    assert.equal(await create.locator('button[type="submit"]').isDisabled(), false);
    // An empty branch is caught here.
    await create.locator('button[type="submit"]').click();
    assert.equal(await create.isVisible(), true);
    assert.deepEqual(state.calls.filter((call) => call[0] === "create"), []);
    if (mobile) {
      for (const size of await create.locator("input").evaluateAll((inputs) => inputs.map((input) => [input.getBoundingClientRect().height, parseFloat(getComputedStyle(input).fontSize)]))) {
        assert.ok(size[0] >= 44 && size[1] >= 16, `a New worktree box is too small on a phone: ${size}`);
      }
    }
    await page.locator("#worktree-branch").fill("feat/search");
    await page.locator("#worktree-base").fill("main");
    if (shots) await create.screenshot({ path: join(shots, `new-${where}.png`) });
    await create.locator('button[type="submit"]').click();
    await create.waitFor({ state: "hidden" });
    assert.deepEqual(state.calls.filter((call) => call[0] === "create"), [["create", "w1", { branch: "feat/search", base: "main", label: undefined }]]);
    await page.waitForFunction(() => document.querySelector(".pane-button[aria-pressed='true']")?.dataset.paneId === "w4:p1");
    await openSidebar();
    assert.equal(await heading("shop").count(), 2, "the new worktree's workspace is not listed");
    assert.equal(await page.locator(".workspace-branch", { hasText: "feat/search" }).count(), 1);

    // Open worktree: the checkouts Herdr can open, the closed one chosen first.
    await choose("notes", "Open worktree…");
    const pick = page.locator("#worktree-open-dialog");
    await pick.waitFor({ state: "visible" });
    await page.locator("#worktree-open-feedback", { hasText: "not in a Git repository" }).waitFor();
    assert.equal(await pick.locator('button[type="submit"]').isDisabled(), true);
    await page.locator("#worktree-open-cancel").click();
    await pick.waitFor({ state: "hidden" });

    await openSidebar();
    await heading("shop").first().locator(".sidebar-action-menu > summary").click();
    await heading("shop").first().locator(".sidebar-action-item", { hasText: "Open worktree…" }).click();
    await pick.waitFor({ state: "visible" });
    await pick.locator(".worktree-choice").first().waitFor();
    const rows = await pick.locator(".worktree-choice").evaluateAll((items) => items.map((item) => ({
      branch: item.querySelector(".worktree-choice-branch").textContent,
      path: item.querySelector(".worktree-choice-path").textContent,
      badges: [...item.querySelectorAll(".ui-badge")].map((badge) => badge.textContent),
      checked: item.querySelector("input").checked,
      height: item.getBoundingClientRect().height,
    })));
    assert.deepEqual(rows.map((row) => [row.branch, row.badges, row.checked]), [
      ["main", ["Open", "Main"], false],
      ["feat/cart-and-a-rather-long-branch-name", ["Open"], false],
      ["fix/login", [], true],
    ], `${where}: the checkouts offered`);
    assert.ok(rows.every((row) => row.height >= 44), "a checkout row is under 44px");
    if (shots) await pick.screenshot({ path: join(shots, `open-${where}.png`) });
    await pick.locator('button[type="submit"]').click();
    await pick.waitFor({ state: "hidden" });
    assert.deepEqual(state.calls.filter((call) => call[0] === "open"), [["open", "w1", { path: "/work/wt/shop/fix-login", label: undefined }]]);
    await page.waitForFunction(() => document.querySelector(".pane-button[aria-pressed='true']")?.dataset.paneId === "w5:p1");

    // Remove worktree: asked, refused for changes, asked again, forced.
    confirms.length = 0;
    await choose("cart", "Remove worktree…");
    await heading("cart").waitFor({ state: "detached" });
    assert.equal(confirms.length, 2, `${where}: ${JSON.stringify(confirms)}`);
    assert.match(confirms[0], /^Remove worktree “cart \(feat\/cart-and-a-rather-long-branch-name\)”\? Its folder is deleted .* The branch is kept\.$/u);
    assert.match(confirms[1], /has changes Git has not committed\. Remove it anyway\? Those changes are lost\.$/u);
    assert.deepEqual(state.calls.filter((call) => call[0] === "remove"), [["remove", "w2", { force: undefined }], ["remove", "w2", { force: true }]]);

    // Declining the second ask leaves the worktree, and nothing is forced.
    state.dirty = true;
    const before = state.calls.length;
    confirms.length = 0;
    answer = (message) => !message.includes("changes Git has not committed");
    await openSidebar();
    const searchRow = page.locator(".workspace-heading", { has: page.locator(".workspace-branch", { hasText: "feat/search" }) });
    await searchRow.locator(".sidebar-action-menu > summary").click();
    await searchRow.locator(".sidebar-action-item", { hasText: "Remove worktree…" }).click();
    for (let tries = 0; confirms.length < 2 && tries < 50; tries += 1) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    assert.equal(confirms.length, 2);
    assert.deepEqual(state.calls.slice(before).map((call) => [call[0], call[2].force]), [["remove", undefined]]);
    assert.equal(await searchRow.count(), 1, "a worktree declined at the second ask was removed");

    assert.deepEqual(errors, [], `${where}: page errors`);
    await context.close();
  }
  console.log("Worktrees OK: menu, branch, New, Open and Remove on desktop and phone");
} finally {
  await browser.close();
  server.close();
}
