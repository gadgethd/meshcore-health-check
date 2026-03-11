import { expect, test } from '@playwright/test';

test('turnstile landing page renders when verification is required', async ({ page }) => {
  await page.route('https://challenges.cloudflare.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.turnstile={render(){},reset(){}};',
    });
  });

  await page.goto('/');

  await expect(page).toHaveTitle(/Verification/i);
  await expect(page.getByText('Human Verification')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Boston MeshCore Observer Coverage' })).toBeVisible();
  await expect(page.getByText(/Complete the Turnstile challenge/i)).toBeVisible();
  await expect(page.locator('#landing-status')).toContainText('Waiting for verification', { timeout: 10000 });
});
