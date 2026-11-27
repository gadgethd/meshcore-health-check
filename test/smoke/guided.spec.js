import { expect, test } from '@playwright/test';

test('the dashboard paints and connects while tracked session history is pending', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify(['first']));
  });
  let socketReady = false;
  let sessionsRequested = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:3091\/$/, () => { socketReady = true; });
  await page.route('**/api/sessions?ids=*', async (route) => {
    sessionsRequested = true;
    await pending;
    await route.fulfill({ json: { sessions: [] } });
  });

  try {
    await page.goto('/app');
    await expect.poll(() => sessionsRequested).toBe(true);
    await expect(page.locator('#transport-status')).not.toHaveText('Checking network connection.');
    await expect.poll(() => socketReady).toBe(true);
    await expect(page.getByRole('button', { name: 'Generate code', exact: true })).toBeEnabled();
  } finally {
    release();
  }
});

test('live session events fetch only tracked IDs and polling still reconciles the full list', async ({ page }) => {
  const now = new Date('2026-01-01T12:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.addInitScript(() => {
    sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify(['first', 'second']));
  });
  let socket;
  let snapshot;
  const requests = [];
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:3091\/$/, (route) => { socket = route; });
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    snapshot = await response.json();
    await route.fulfill({ response });
  });
  await page.route('**/api/sessions?ids=*', async (route) => {
    requests.push(new URL(route.request().url()).searchParams.get('ids'));
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.goto('/app');
  await expect.poll(() => Boolean(socket)).toBe(true);
  await expect.poll(() => [...requests]).toEqual(['first,second']);

  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
  socket.send(JSON.stringify({ type: 'session-update', data: { sessionId: 'untracked' } }));
  await page.clock.runFor(500);
  expect(requests).toEqual(['first,second']);

  socket.send(JSON.stringify({ type: 'session-update', data: { sessionId: 'second' } }));
  await page.clock.runFor(500);
  await expect.poll(() => [...requests]).toEqual(['first,second', 'second']);

  await page.clock.runFor(5000);
  await expect.poll(() => [...requests]).toEqual(['first,second', 'second', 'first,second']);
});

for (const width of [1440, 390]) {
  test(`guided check and read-only share retain controls at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/app');
    const code = page.locator('#session-code');
    await expect(code).toHaveText('No active code');
    await expect(page.getByRole('link', { name: 'Back to UKMesh' })).toBeVisible();
    await page.getByRole('button', { name: 'Generate code', exact: true }).click();
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
