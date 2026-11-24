import { expect, test } from '@playwright/test';

for (const used of [false, true]) {
  test(`slider affects only new codes with ${used ? 'used' : 'waiting'} current results`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Suppress unrelated asynchronous live updates while inspecting retained results.
    await page.addInitScript(() => { window.WebSocket = class { addEventListener() {} close() {} }; });
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) posts.push(request.postDataJSON());
    });
    await page.goto('/app');
    const slider = page.getByRole('slider', { name: 'Code length' });
    await expect(slider).toBeVisible();
    await expect(page.locator('#code-length-note')).toContainText('after NYHC1234-');
    await expect(slider).toHaveAttribute('min', '6');
    await expect(slider).toHaveAttribute('max', '16');
    await expect(slider).toHaveAttribute('step', '1');
    await expect(slider).toHaveValue('6');
    await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{6}$/);
    const code = await page.locator('#session-code').textContent();
    const initial = await (await page.request.get('/api/sessions/' + await page.evaluate(() => sessionStorage.getItem('mesh-health-check-session-id')))).json();
    if (used) {
      const retained = { ...initial, status: 'active', useCount: 1, observedCount: 1, healthPercent: 50, healthLabel: 'FAIR', messageBody: code };
      await page.route(`**/api/sessions/${initial.id}`, route => route.fulfill({ json: retained }));
      await page.reload();
      await expect(page.locator('#health-label')).toHaveText('FAIR');
    }
    const before = posts.length;
    await slider.fill('15');
    await expect(page.locator('#code-length-value')).toHaveText('15');
    await expect(page.locator('#session-code')).toHaveText(code);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(before);
    if (used) await expect(page.locator('#health-label')).toHaveText('FAIR');
    await page.locator('#new-session-button').click();
    await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{15}$/);
    expect(posts.at(-1).codeLength).toBe(15);
    expect(posts.at(-1).expectedObserverKeys).toEqual(posts[0].expectedObserverKeys);
    const longerCode = await page.locator('#session-code').textContent();
    await page.locator('#copy-session-code').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(longerCode);
    const ids = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mesh-health-check-session-history')));
    expect(ids).toContain(initial.id);
    const latest = await (await page.request.get('/api/sessions/' + ids[0])).json();
    await page.route('**/api/bootstrap', async route => {
      const response = await route.fetch();
      const bootstrap = await response.json();
      bootstrap.codeOptions.prefix = 'CHANGED';
      await route.fulfill({ json: bootstrap });
    });
    await page.reload();
    await expect(page.locator('#code-length-note')).toContainText('after CHANGED-');
    await expect(slider).toHaveValue('6');
    await expect(page.locator('#session-code')).toHaveText(longerCode);
    expect(posts).toHaveLength(before + 1);
    await expect(page.locator('#session-history')).toContainText(code);
    await expect(page.locator('#session-history')).toContainText(longerCode);
    await page.locator('#copy-session-code').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(longerCode);
    await page.goto(latest.sharePath);
    await expect(page.locator('#session-code')).toHaveText(longerCode);
    await expect(slider).toBeHidden();
  });
}

test('observer changes retain automatic new-code behavior at the chosen length', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{6}$/);
  await page.getByRole('slider', { name: 'Code length' }).fill('7');
  await page.locator('#observer-customization > summary').click();
  const response = page.waitForResponse(r => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  const choices = page.locator('#observer-allowlist input[type="checkbox"]');
  await choices.first().uncheck();
  const created = await (await response).json();
  await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{7}$/);
  expect(created.expectedObservers).toHaveLength(1);
  await expect(page.locator('#expected-source')).toContainText('Custom set');
});

test('sixteen-character code and length controls fit desktop and mobile', async ({ page }, testInfo) => {
  await page.goto('/app');
  await page.getByRole('slider', { name: 'Code length' }).fill('16');
  await page.locator('#new-session-button').click();
  await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{16}$/);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('slider', { name: 'Code length' })).toBeVisible();
    const codeBounds = await page.locator('#session-code').boundingBox();
    expect(codeBounds.width).toBeGreaterThan(200);
    expect(codeBounds.height).toBeLessThan(250);
    expect(await page.locator('#session-code').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('#copy-session-code')).toBeVisible();
    const bounds = await page.locator('#code-length-control').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#command-center').screenshot({ path: testInfo.outputPath(`code-length-${width}.png`) });
  }
});


test('older bootstrap without code options retains default guidance and code', async ({ page }) => {
  // Emulate an old backend consistently: current live snapshots carry codeOptions.
  await page.addInitScript(() => { window.WebSocket = class { addEventListener() {} close() {} }; });
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    delete bootstrap.codeOptions;
    await route.fulfill({ json: bootstrap });
  });
  await page.goto('/app');
  await expect(page.locator('#session-code')).toHaveText(/^NYHC1234-[A-F0-9]{6}$/);
  await expect(page.locator('#code-length-control')).toBeHidden();
  await expect(page.locator('#code-length-note')).toHaveText('Hex characters after MHC-. Applies to new codes only.');
});
