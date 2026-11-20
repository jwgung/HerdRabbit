// The pane header's controls (Chat or Terminal, Find, the split view's and grid's
// buttons) are inline on a desktop. On a phone (max-width 760px) the stylesheet
// hides them and the "More" menu (#header-more) offers them, so a check that runs
// at both widths goes through these helpers. Their aria and hidden state still
// updates on a phone, so assertions can read #lens-chat[aria-pressed] and so on.

export const isPhoneHeader = (page) => page.evaluate(() => window.matchMedia("(max-width: 760px)").matches);

// Opens the menu and taps one of its items (data-action: grid-back, view-back,
// view-apply, view-close, lens-chat, lens-terminal, find). One tap must open
// it: a header redraw that sets the same values again does not rebuild the menu.
export async function chooseMoreAction(page, action) {
  await page.locator("#header-more summary").click();
  await page.locator(`#header-more [data-action="${action}"]`).click();
}

export async function showLens(page, lens) {
  if (!(await isPhoneHeader(page))) return page.locator(`#lens-${lens}`).click();
  if ((await page.locator(`#lens-${lens}`).getAttribute("aria-pressed")) === "true") return;
  await chooseMoreAction(page, `lens-${lens}`);
}

export async function openFind(page) {
  if (!(await isPhoneHeader(page))) return page.locator("#terminal-find-open").click();
  await chooseMoreAction(page, "find");
}

// The header's Chat or Terminal switch exists for this pane.
export async function waitForLensSwitch(page) {
  if (!(await isPhoneHeader(page))) return page.locator("#lens-switch").waitFor({ state: "visible" });
  await page.locator("#lens-switch").waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector("#lens-switch").hidden);
}

// A split view's or grid's button: "grid-back", "view-back", "view-apply" or "view-close".
export async function clickViewControl(page, name) {
  if (!(await isPhoneHeader(page))) return page.locator(`#${name}`).click();
  await chooseMoreAction(page, name);
}
