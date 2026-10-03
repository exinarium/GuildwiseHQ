import { expect, test } from '@playwright/test';

// Placeholder so the e2e lane has a spec to extend; skipped until the stack can be started.
test.skip('stack boots', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
