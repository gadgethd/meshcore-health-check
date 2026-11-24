import { expect, test } from '@playwright/test';

async function mockTurnstileWidget(page) {
  await page.route('https://challenges.cloudflare.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.turnstile = {
        render(_selector, options) {
          window.__turnstileOptions = options;
        },
        reset() {},
      };`,
    });
  });
  await page.goto('/');
  await expect(page.locator('#landing-status')).toContainText('Waiting for verification', {
    timeout: 10000,
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.__turnstileOptions))).toBe(true);
}

test('successful Turnstile verification sets the auth cookie and opens the dashboard', async ({
  page,
  context,
}) => {
  await mockTurnstileWidget(page);
  await page.evaluate(() => window.__turnstileOptions.callback('success-token'));

  await expect(page).toHaveURL(/\/app$/, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'New Code' })).toBeVisible();

  const cookie = (await context.cookies()).find(({ name }) => name === 'mesh_health_turnstile');
  expect(cookie).toMatchObject({
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    secure: false,
  });
});

test('failed Turnstile verification reports an error and does not authorize the dashboard', async ({
  page,
  context,
}) => {
  await mockTurnstileWidget(page);
  await page.evaluate(() => window.__turnstileOptions.callback('failure-token'));

  await expect(page.locator('#landing-status')).toContainText('Verification failed: verification_failed');
  await expect(page).toHaveURL(/\/$/);
  expect((await context.cookies()).some(({ name }) => name === 'mesh_health_turnstile')).toBe(false);
});
