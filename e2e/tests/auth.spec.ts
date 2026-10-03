import { expect, test } from '@playwright/test';
import { storagePath } from '../support/api.ts';
import { ADMIN, MEMBER } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';

test.describe.configure({ mode: 'serial' });

// AC1: admin invites a member; the member accepts via the Mailpit link and logs in.
test('AC1: admin invites a member who accepts via the mailed link and logs in', async ({ page, browser }) => {
  await deleteMailFor(MEMBER.email);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('wrong-password-xx');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('form', { name: 'Invite user' }).getByLabel('Email').fill(MEMBER.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(MEMBER.email).first()).toBeVisible();

  const mail = await waitForMail(MEMBER.email);
  const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0];
  expect(link, mail.text).toBeTruthy();

  const memberCtx = await browser.newContext();
  const mp = await memberCtx.newPage();
  await mp.goto(link as string);
  await mp.getByLabel('Display name').fill(MEMBER.name);
  await mp.getByLabel('Password', { exact: true }).fill(MEMBER.password);
  await mp.getByLabel('Confirm password').fill(MEMBER.password);
  await mp.getByRole('button', { name: /accept|create|continue|join/i }).click();
  await expect(mp.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Log out and back in with the new credentials.
  await mp.getByRole('button', { name: /sign out|log out|logout/i }).click();
  await expect(mp).toHaveURL(/\/login/);
  await mp.getByLabel('Email').fill(MEMBER.email);
  await mp.getByLabel('Password').fill(MEMBER.password);
  await mp.getByRole('button', { name: 'Sign in' }).click();
  await expect(mp.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(mp.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await memberCtx.storageState({ path: storagePath('member') });
  await memberCtx.close();
});
