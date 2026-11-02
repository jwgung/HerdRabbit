import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
await mkdir('tmp/ui-library', { recursive: true });
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('../public/ui/index.html', import.meta.url).href);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.locator('#theme-switch').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      assert.equal(await page.locator('.primary-button').first().evaluate(el => getComputedStyle(el).borderRadius), '6px');
      await page.screenshot({ path: `tmp/ui-library/${width}-${theme}.png`, fullPage: true, animations: 'disabled' });
    }
    await page.locator('#open-dialog').click();
    assert(await page.locator('#example-dialog').evaluate(el => el.open));
    await page.locator('#dialog-name').fill('HTML example');
    await page.locator('#example-dialog [value="save"]').click();
    assert.equal(await page.locator('#example-dialog').evaluate(el => el.open), false);
    await page.waitForFunction(() => document.querySelector('#catalog-feedback').textContent.includes('완료'));
    await page.locator('.ui-nav-item').nth(1).click();
    assert.equal(await page.locator('.ui-nav-item[aria-pressed="true"]').count(), 1);
    await page.locator('.ui-menu summary').click();
    await page.locator('.ui-menu-item').first().click();
    assert.equal(await page.locator('.ui-menu').getAttribute('open'), null);
    await page.locator('[data-source="buttons"] summary').click();
    assert.match(await page.locator('[data-source="buttons"] code').textContent(), /class="primary-button"/);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Standalone file:// UI: desktop/mobile themes, overflow, dialog, navigation, menu and HTML examples passed');
} finally { await browser.close(); }
