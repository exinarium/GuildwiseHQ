import { expect, test } from '@playwright/test';
import { NEWORG, SUPER } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { freshTotp } from '../support/totp.ts';

test.describe.configure({ mode: 'serial' });

let secret = '';

test('the platform administrator is held at the two-factor setup, then lands in the platform area', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SUPER.email);
  await page.getByLabel('Password').fill(SUPER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // no work shell: the setup comes first
  await page.getByLabel('Your password').fill(SUPER.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  secret = (await page.locator('code').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByTestId('totp-code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Turn on two-factor login' }).click();

  const codes = page.getByTestId('recovery-codes');
  await expect(codes).toBeVisible();
  expect(await codes.locator('li').count()).toBe(10);
  await page.getByLabel('I saved my recovery codes somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page).toHaveURL(/\/platform/);
  await expect(page.getByTestId('platform-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();
  // the platform account never sees a work shell
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});

test('signing in again needs a code; a wrong one is refused', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SUPER.email);
  await page.getByLabel('Password').fill(SUPER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('login-code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByTestId('login-code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/platform/);
});

test('invites a new organization, the invitee starts it, and the platform suspends and reactivates it', async ({
  page,
  browser,
}) => {
  await deleteMailFor(NEWORG.email);
  await page.goto('/login');
  await page.getByLabel('Email').fill(SUPER.email);
  await page.getByLabel('Password').fill(SUPER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('login-code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/platform/);

  await page.getByTestId('platform-nav-invitations').click();
  await page.getByLabel('Owner email').fill(NEWORG.email);
  await page.getByLabel('Organization name').fill(NEWORG.org);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByTestId('platform-invitations').getByText(NEWORG.email)).toBeVisible();

  const mail = await waitForMail(NEWORG.email);
  const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0];
  expect(link, mail.text).toBeTruthy();

  const ownerCtx = await browser.newContext();
  const op = await ownerCtx.newPage();
  await op.goto(link as string);
  await expect(op.getByRole('heading', { name: /Start your organization/ })).toBeVisible();
  await op.getByLabel('Your name').fill(NEWORG.name);
  await op.getByLabel('Password', { exact: true }).fill(NEWORG.password);
  await op.getByLabel('Confirm password').fill(NEWORG.password);
  await op.getByRole('button', { name: /start|create|continue|accept/i }).click();
  await expect(op.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(op.getByTestId('org-label')).toContainText(NEWORG.org);

  // the platform sees the organization (metadata only), suspends it with a reason
  await page.getByTestId('platform-nav-orgs').click();
  await page.getByRole('link', { name: NEWORG.org }).click();
  await expect(page.getByTestId('platform-org-overview')).toContainText(NEWORG.email);
  await page.getByRole('button', { name: 'Suspend' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Suspend' })).toBeDisabled();
  await dialog.getByLabel(/Reason/).fill('Unpaid invoice');
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();

  // the Owner still signs in and sees why
  await op.reload();
  await expect(op.getByTestId('org-banners')).toBeVisible();

  await page.getByRole('button', { name: 'Reactivate' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Reason/)
    .fill('Paid');
  await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByRole('button', { name: 'Suspend' }).first()).toBeVisible();

  // everything above is in the audit log
  await page.getByTestId('platform-nav-audit').click();
  await expect(page.getByTestId('platform-audit')).toContainText('Unpaid invoice');
  await ownerCtx.close();
});
