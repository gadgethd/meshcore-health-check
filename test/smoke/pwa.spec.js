import { expect, test } from '@playwright/test';

test('installs the service worker and serves the cached shell offline', async ({ page, context }) => {
  await page.goto('/app');

  await expect.poll(async () => (await context.serviceWorkers())
    .some((worker) => worker.url().endsWith('/sw.js'))).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const activeWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    return registration.active?.scriptURL || '';
  });
  expect(activeWorkerUrl).toMatch(/\/sw\.js$/);

  const cachedShell = await page.evaluate(async () => Boolean(await caches.match('/app')));
  expect(cachedShell).toBe(true);

  await context.setOffline(true);
  const offlineShell = await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await context.setOffline(false);

  expect(offlineShell?.status()).toBe(200);
  await expect(page).toHaveTitle(/MeshCore Observer Coverage/i);
});
