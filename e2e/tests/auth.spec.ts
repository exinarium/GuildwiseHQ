import { expect, test } from '@playwright/test';
import { storagePath } from '../support/api.ts';
import { ADMIN, MEMBER } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';

test.describe.configure({ mode: 'serial' });

// AC1: admin invites a member; the member accepts via the Mailpit link and logs in.
test('AC1: the owner invites an admin who accepts via the mailed link and logs in', async ({
  page,
  browser,
}) => {
  await deleteMailFor(MEMBER.email);

  // a visitor with no session is sent to the login page from any app route (`/` itself is the landing page)
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('wrong-password-xx');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.getByRole('link', { name: 'Organization', exact: true }).click();
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByTestId('invite-member').click();
  await page.getByRole('dialog').getByLabel('Email').fill(MEMBER.email);
  // the main e2e user creates projects, which only Admins and the Owner may do
  await page.getByRole('dialog').getByRole('radio', { name: /Admin/ }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await expect(page.getByText(MEMBER.email).first()).toBeVisible();

  const mail = await waitForMail(MEMBER.email);
  const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0];
  expect(link, mail.text).toBeTruthy();

  const memberCtx = await browser.newContext();
  const mp = await memberCtx.newPage();
  await mp.goto(link as string);
  await mp.getByLabel('Your name').fill(MEMBER.name);
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
  await expect(mp.getByTestId('org-role')).toContainText('Admin');
  await memberCtx.storageState({ path: storagePath('member') });
  await memberCtx.close();
});
