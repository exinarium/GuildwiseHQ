import { type APIRequestContext, type Browser, type BrowserContext, expect } from '@playwright/test';
import { q } from '../support/db.ts';
import { BASE_URL, SUPER } from '../support/env.ts';
import { freshTotp } from '../support/totp.ts';

/**
 * The platform administrator of the demo stack, for the videos that need one (Help: answering a support request;
 * Platform area). The stack creates `platform@e2e.test`; before it signs in for the first time it is renamed to a demo
 * person (only demo data on screen), then it sets up two-factor login, which the platform requires at first sign-in.
 * Everything happens off camera, in a context of its own; the returned context is signed in.
 */
export const PLATFORM_DEMO = { email: 'sam.rivera@demo.local', name: 'Sam Rivera', password: SUPER.password };

export interface PlatformSession {
  ctx: BrowserContext;
  /** The signed-in platform API client (send `headers` with every write). */
  api: APIRequestContext;
  headers: Record<string, string>;
}

export async function platformLogin(browser: Browser): Promise<PlatformSession> {
  await q(`UPDATE users SET email=$1, display_name=$2 WHERE email=$3`, [
    PLATFORM_DEMO.email,
    PLATFORM_DEMO.name,
    SUPER.email,
  ]);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(PLATFORM_DEMO.email);
  await page.getByLabel('Password').fill(PLATFORM_DEMO.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Your password').fill(PLATFORM_DEMO.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.locator('code').first().innerText()).trim();
  await page.getByTestId('totp-code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor login' }).click();
  await page.getByLabel('I saved my recovery codes somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/platform/);
  await page.close();
  return { ctx, api: ctx.request, headers: { Origin: BASE_URL } };
}
