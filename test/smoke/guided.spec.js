import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`guided check and read-only share retain controls at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/app');
    const code = page.locator('#session-code');
    await expect(code).toHaveText(/^MHC-[A-F0-9]{6}$/);
    await expect(page.locator('#check-guidance')).toContainText('connection is offline');
    await expect(page.locator('[aria-current="step"]')).toContainText('Send to your channel');
    const firstCode = await code.textContent();
    await page.locator('#copy-session-code').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstCode);
    await page.locator('#new-session-button').click();
    await expect(code).not.toHaveText(firstCode);
    const sessionId = await page.evaluate(() => sessionStorage.getItem('mesh-health-check-session-id'));
    await page.locator('#observer-customization > summary').click();
    await expect(page.locator('#observer-allowlist')).toBeVisible();
    await page.locator('#session-details > summary').click();
    await expect(page.locator('#session-status')).toBeVisible();
    await page.locator('#ui-theme-toggle').click();
    await expect(page.locator('body')).toHaveAttribute('data-ui-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`guided-${width}.png`), fullPage: true });

    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions/.test(request.url())) writes++; });
    await page.goto(`/share/${sessionId}`);
    await expect(page.locator('#session-code')).toHaveText(/^MHC-/);
    await expect(page.locator('#check-guidance')).toContainText('saved result');
    await expect(page.locator('#new-session-button')).toBeHidden();
    await expect(page.locator('#start-own-check-link')).toBeVisible();
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`shared-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
