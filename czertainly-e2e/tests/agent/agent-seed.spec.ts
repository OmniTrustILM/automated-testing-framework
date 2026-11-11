import { test, expect } from '@playwright/test';

test('agent seed: logged in to the administrator UI', async ({ page }) => {
  await page.goto(new URL('administrator/', process.env.BASE_URL!).toString(), { waitUntil: 'domcontentloaded' });
  const username = page.getByRole('textbox', { name: 'Username' });
  const provider = page.getByRole('button', { name: process.env.AUTH_PROVIDER_NAME || 'Internal', exact: true });
  // With one provider ILM redirects straight to the Keycloak form (it can take longer than a few seconds);
  // with several it shows provider buttons first. Wait for whichever appears.
  await expect(username.or(provider)).toBeVisible({ timeout: 30_000 });
  if (!(await username.isVisible())) {
    await provider.click({ noWaitAfter: true });  // the redirect's "load" may never settle; wait for the form
  }
  await expect(username).toBeVisible({ timeout: 30_000 });
  await username.fill(process.env.SMOKE_USERNAME!);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.SMOKE_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click({ noWaitAfter: true });
  await expect(page.getByTestId('sidebar-sticky')).toBeVisible({ timeout: 30_000 });
});
