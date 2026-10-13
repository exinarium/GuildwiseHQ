import { expect, test } from '@playwright/test';
import { ADMIN, BASE_URL, NEWORG, ORGMEM } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('the Owner invites a Member, who sees the organization read-only; the Owner changes the role', async ({
  page,
  browser,
}) => {
  await deleteMailFor(ORGMEM.email);
  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Organization', exact: true }).click();
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByTestId('invite-member').click();
  await page.getByRole('dialog').getByLabel('Email').fill(ORGMEM.email);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();

  const mail = await waitForMail(ORGMEM.email);
  const link = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(mail.text)?.[0] as string;
  const ctx = await browser.newContext();
  const mp = await ctx.newPage();
  await mp.goto(link);
  await mp.getByLabel('Your name').fill(ORGMEM.name);
  await mp.getByLabel('Password', { exact: true }).fill(ORGMEM.password);
  await mp.getByLabel('Confirm password').fill(ORGMEM.password);
  await mp.getByRole('button', { name: /join/i }).click();
  await expect(mp.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // a Member cannot create projects and has no invitations, guests or plan tabs
  await mp.goto('/projects');
  await expect(mp.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await mp.goto('/settings/org');
  await expect(mp.getByRole('tab', { name: 'Members' })).toBeVisible();
  await expect(mp.getByRole('tab', { name: 'Invitations' })).toHaveCount(0);
  await expect(mp.getByRole('tab', { name: 'Plan & limits' })).toHaveCount(0);

  // the Owner sees the plan: Founding, no limits
  await page.reload();
  await page.getByRole('tab', { name: 'Plan & limits' }).click();
  await expect(page.getByTestId('plan-summary')).toContainText('Founding');
  await expect(page.getByTestId('usage-projects')).toContainText('Unlimited');

  // the Owner makes the Member an Admin: the Admin now sees the management tabs
  await page.getByRole('tab', { name: 'Members' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: ORGMEM.email })
    .getByRole('combobox')
    .selectOption('admin');
  await mp.reload();
  await expect(mp.getByRole('tab', { name: 'Invitations' })).toBeVisible();
  await ctx.close();
});

test('an Owner of one organization shares a project as a guest with the Owner of another, who switches organizations', async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  const ap = await adminCtx.newPage();
  await signIn(ap, ADMIN);
  const projects = (await (await ap.request.get('/api/projects')).json()) as {
    projects: Array<{ id: string }>;
  };
  const projectId = projects.projects[0]?.id;
  expect(projectId).toBeTruthy();
  const share = await ap.request.post(`/api/projects/${projectId}/members`, {
    data: { email: NEWORG.email },
    headers: { Origin: BASE_URL },
  });
  expect(share.ok(), await share.text()).toBeTruthy();

  const ownerCtx = await browser.newContext();
  const np = await ownerCtx.newPage();
  await signIn(np, NEWORG);
  await np.goto('/projects');
  const inbox = np.getByTestId('project-invitations');
  await expect(inbox).toContainText("E2E Admin's organization");
  await inbox.getByRole('button', { name: /Accept invitation/ }).click();

  // the project shows as a guest project, and the switcher lists the other organization under "Guest in"
  await expect(np.getByText(/Guest · /).first()).toBeVisible();
  await np.getByTestId('org-switcher').click();
  await expect(np.getByRole('list', { name: 'Guest in' })).toBeVisible();
  await adminCtx.close();
  await ownerCtx.close();
});
