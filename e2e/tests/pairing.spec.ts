import { expect, test } from '@playwright/test';
import { BASE_URL, MEMBER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';

test.use({ storageState: undefined });

// AC2: the member generates a pairing code; `aom-runner pair` + `start` succeed; the workstation shows
// Connected with the toy repo listed.
test('AC2: pairing code, aom-runner pair + start, workstation Connected with the toy repo', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(MEMBER.email);
  await page.getByLabel('Password').fill(MEMBER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Workstations' }).click();

  await page
    .getByRole('button', { name: /pair workstation/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Generate pairing code' }).click();
  const code = (await page.getByTestId('pairing-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const out = pairRunner(BASE_URL, code, 'E2E Desktop');
  expect(out).toMatch(/pair/i);
  addRepoRoot(paths.repoRoot);
  startRunner();

  await page.keyboard.press('Escape');
  const card = page.getByTestId('workstation-E2E Desktop');
  await expect(card.getByTestId('connection-dot')).toHaveAttribute('data-connected', 'true');
  await expect(card.getByText('Connected')).toBeVisible();
  await expandWorkstation(card);
  await expect(card.getByText('mock')).toBeVisible();

  // The server lists only repos that match a project repo (ARCHITECTURE: workstation_repos), so the toy repo
  // shows once project TOY has it. Part of AC3 (project creation) lives here because it needs this workstation.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page
    .getByRole('button', { name: /new project/i })
    .first()
    .click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Key').fill('TOY');
  await dlg.getByLabel('Name').fill('Toy project');
  await dlg.getByRole('button', { name: /create/i }).click();
  await expect(page.getByText('TOY').first()).toBeVisible();
  await page.getByRole('link', { name: 'Settings for TOY' }).click();
  const add = page.getByRole('form', { name: 'Add repository' });
  await add.getByLabel('Repository name').fill('toy');
  await add.getByLabel('Remote URL').fill(paths.origin);
  await add.getByRole('button', { name: /add/i }).click();
  await expect(page.getByTestId('repos')).toContainText('toy');

  await page.getByRole('link', { name: 'Workstations' }).click();
  await expandWorkstation(page.getByTestId('workstation-E2E Desktop'));
  await expect(page.getByTestId('workstation-E2E Desktop').getByTestId('workstation-repos')).toContainText(
    'toy',
  );
});
